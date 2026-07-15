//! Lifecycle management for the local Jinghua encryption bridge.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};
use tokio::time::{sleep, timeout};

const JINGHUA_BACKEND: &str = "jinghua_saas";
const READY_PREFIX: &str = "SCLAW_SIDECAR_READY ";
const SIDECAR_PORT: u16 = 3190;
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Returns true when the resolved LLM backend needs the local crypto bridge.
pub fn requires_crypto_sidecar(backend: &str) -> bool {
    backend.eq_ignore_ascii_case(JINGHUA_BACKEND)
}

/// Errors returned while locating, starting, or stopping the crypto sidecar.
#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error(
        "Could not resolve the current executable for the Jinghua encryption sidecar: {reason}"
    )]
    CurrentExecutable { reason: String },

    #[error("Jinghua encryption sidecar {kind} was not found at {path}")]
    MissingPath { kind: &'static str, path: PathBuf },

    #[error("Could not start the Jinghua encryption sidecar with {node}: {reason}")]
    Spawn { node: PathBuf, reason: String },

    #[error("Jinghua encryption sidecar did not expose its piped {stream}")]
    MissingPipe { stream: &'static str },

    #[error("Jinghua encryption sidecar ready stream failed: {reason}")]
    ReadyRead { reason: String },

    #[error("Jinghua encryption sidecar did not report ready within {seconds} seconds")]
    ReadyTimeout { seconds: u64 },

    #[error(
        "Jinghua encryption sidecar exited before ready ({status}); verify SDK initialization and that 127.0.0.1:3190 is available"
    )]
    ExitedBeforeReady { status: String },

    #[error("Jinghua encryption sidecar closed stdout before reporting ready")]
    ReadyStreamClosed,

    #[error("Jinghua encryption sidecar returned an invalid ready message")]
    InvalidReady,

    #[error("Jinghua encryption sidecar reported port {actual}, expected {expected}")]
    UnexpectedPort { actual: u16, expected: u16 },

    #[error("Could not create the Jinghua encryption sidecar health client: {reason}")]
    HealthClient { reason: String },

    #[error("Jinghua encryption sidecar health check failed: {reason}")]
    HealthRequest { reason: String },

    #[error("Jinghua encryption sidecar health check returned HTTP {status}")]
    HealthStatus { status: u16 },

    #[error("Jinghua encryption sidecar health response was invalid")]
    InvalidHealth,

    #[error("Could not stop the Jinghua encryption sidecar: {reason}")]
    Shutdown { reason: String },
}

#[derive(Debug)]
struct SidecarPaths {
    node: PathBuf,
    entry: PathBuf,
}

impl SidecarPaths {
    fn resolve() -> Result<Self, SidecarError> {
        let current_exe =
            std::env::current_exe().map_err(|error| SidecarError::CurrentExecutable {
                reason: error.to_string(),
            })?;

        Self::resolve_with(
            &current_exe,
            std::env::var_os("SCLAW_NODE_BINARY"),
            std::env::var_os("SCLAW_SIDECAR_ENTRY"),
            cfg!(debug_assertions),
        )
    }

    fn resolve_with(
        current_exe: &Path,
        node_override: Option<OsString>,
        entry_override: Option<OsString>,
        debug_build: bool,
    ) -> Result<Self, SidecarError> {
        let resources_dir = current_exe
            .parent()
            .and_then(Path::parent)
            .map(|contents| contents.join("Resources"));
        let bundled_node = resources_dir
            .as_ref()
            .map(|resources| resources.join("node/bin/node"))
            .unwrap_or_else(|| PathBuf::from("Resources/node/bin/node"));
        let bundled_entry = resources_dir
            .as_ref()
            .map(|resources| resources.join("crypto-bridge/server.mjs"))
            .unwrap_or_else(|| PathBuf::from("Resources/crypto-bridge/server.mjs"));

        let node = if bundled_node.is_file() {
            bundled_node
        } else if debug_build {
            match node_override {
                Some(path) => require_file("Node executable", PathBuf::from(path))?,
                None => PathBuf::from("node"),
            }
        } else {
            return Err(SidecarError::MissingPath {
                kind: "Node executable",
                path: bundled_node,
            });
        };

        let entry = if bundled_entry.is_file() {
            bundled_entry
        } else if debug_build {
            match entry_override {
                Some(path) => require_file("entry point", PathBuf::from(path))?,
                None => require_file(
                    "entry point",
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("sidecar/src/server.mjs"),
                )?,
            }
        } else {
            return Err(SidecarError::MissingPath {
                kind: "entry point",
                path: bundled_entry,
            });
        };

        Ok(Self { node, entry })
    }
}

fn require_file(kind: &'static str, path: PathBuf) -> Result<PathBuf, SidecarError> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(SidecarError::MissingPath { kind, path })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage {
    port: u16,
    sdk_version: String,
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    status: String,
}

/// Supervised Node process serving the loopback Jinghua encryption bridge.
#[derive(Debug)]
pub struct CryptoSidecar {
    child: Option<Child>,
    shutdown_timeout: Duration,
}

impl CryptoSidecar {
    /// Start the bridge, wait for its ready message, and verify `/health`.
    pub async fn start() -> Result<Self, SidecarError> {
        let paths = SidecarPaths::resolve()?;
        Self::start_with(
            paths,
            SIDECAR_PORT,
            READY_TIMEOUT,
            HEALTH_TIMEOUT,
            SHUTDOWN_TIMEOUT,
        )
        .await
    }

    async fn start_with(
        paths: SidecarPaths,
        expected_port: u16,
        ready_timeout: Duration,
        health_timeout: Duration,
        shutdown_timeout: Duration,
    ) -> Result<Self, SidecarError> {
        tracing::info!(
            node = %paths.node.display(),
            entry = %paths.entry.display(),
            "Starting Jinghua encryption sidecar"
        );
        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_remove("JINGHUA_API_KEY");

        let mut child = command.spawn().map_err(|error| SidecarError::Spawn {
            node: paths.node.clone(),
            reason: error.to_string(),
        })?;

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                terminate_child(&mut child).await;
                return Err(SidecarError::MissingPipe { stream: "stdout" });
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                terminate_child(&mut child).await;
                return Err(SidecarError::MissingPipe { stream: "stderr" });
            }
        };

        // Drain stderr without forwarding child-controlled output into SClaw logs.
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut BufReader::new(stderr), &mut tokio::io::sink()).await;
        });

        let ready = match wait_for_ready(&mut child, stdout, ready_timeout).await {
            Ok(ready) => ready,
            Err(error) => {
                terminate_child(&mut child).await;
                return Err(error);
            }
        };

        if ready.port != expected_port {
            terminate_child(&mut child).await;
            return Err(SidecarError::UnexpectedPort {
                actual: ready.port,
                expected: expected_port,
            });
        }

        if let Err(error) = check_health(expected_port, health_timeout).await {
            terminate_child(&mut child).await;
            return Err(error);
        }

        tracing::info!(
            port = ready.port,
            sdk_version = %ready.sdk_version,
            "Jinghua encryption sidecar is ready"
        );

        Ok(Self {
            child: Some(child),
            shutdown_timeout,
        })
    }

    /// Close stdin, wait for graceful exit, then kill and reap on timeout.
    /// Calling shutdown more than once is safe.
    pub async fn shutdown(&mut self) -> Result<(), SidecarError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };

        drop(child.stdin.take());

        match timeout(self.shutdown_timeout, child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => {
                terminate_child(&mut child).await;
                Err(SidecarError::Shutdown {
                    reason: error.to_string(),
                })
            }
            Err(_) => {
                let kill_error = child.start_kill().err();
                child.wait().await.map_err(|error| SidecarError::Shutdown {
                    reason: kill_error
                        .map(|kill| format!("{kill}; wait failed: {error}"))
                        .unwrap_or_else(|| error.to_string()),
                })?;
                Ok(())
            }
        }
    }
}

async fn wait_for_ready(
    child: &mut Child,
    stdout: ChildStdout,
    ready_timeout: Duration,
) -> Result<ReadyMessage, SidecarError> {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    let bytes = timeout(ready_timeout, reader.read_line(&mut line))
        .await
        .map_err(|_| SidecarError::ReadyTimeout {
            seconds: ready_timeout.as_secs(),
        })?
        .map_err(|error| SidecarError::ReadyRead {
            reason: error.to_string(),
        })?;

    if bytes == 0 {
        return match poll_exit_status(child).await? {
            Some(status) => Err(SidecarError::ExitedBeforeReady {
                status: format_exit_status(status),
            }),
            None => Err(SidecarError::ReadyStreamClosed),
        };
    }

    parse_ready(&line)
}

async fn poll_exit_status(child: &mut Child) -> Result<Option<ExitStatus>, SidecarError> {
    for _ in 0..10 {
        if let Some(status) = child.try_wait().map_err(|error| SidecarError::ReadyRead {
            reason: error.to_string(),
        })? {
            return Ok(Some(status));
        }
        sleep(Duration::from_millis(10)).await;
    }
    Ok(None)
}

fn parse_ready(line: &str) -> Result<ReadyMessage, SidecarError> {
    let payload = line
        .strip_prefix(READY_PREFIX)
        .ok_or(SidecarError::InvalidReady)?;
    serde_json::from_str(payload).map_err(|_| SidecarError::InvalidReady)
}

async fn check_health(port: u16, request_timeout: Duration) -> Result<(), SidecarError> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(request_timeout)
        .build()
        .map_err(|error| SidecarError::HealthClient {
            reason: error.to_string(),
        })?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .map_err(|error| SidecarError::HealthRequest {
            reason: error.to_string(),
        })?;

    if !response.status().is_success() {
        return Err(SidecarError::HealthStatus {
            status: response.status().as_u16(),
        });
    }

    let health: HealthResponse = response
        .json()
        .await
        .map_err(|_| SidecarError::InvalidHealth)?;
    if health.status != "ok" {
        return Err(SidecarError::InvalidHealth);
    }

    Ok(())
}

fn format_exit_status(status: ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("exit code {code}"))
        .unwrap_or_else(|| "terminated by signal".to_string())
}

async fn terminate_child(child: &mut Child) {
    drop(child.stdin.take());
    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(_) => {}
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::Ipv4Addr;

    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn write_script(temp_dir: &TempDir, contents: &str) -> PathBuf {
        let path = temp_dir.path().join("fake-sidecar.sh");
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn shell_paths(entry: PathBuf) -> SidecarPaths {
        SidecarPaths {
            node: PathBuf::from("/bin/sh"),
            entry,
        }
    }

    async fn serve_health_once() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\nconnection: close\r\n\r\n{\"status\":\"ok\"}",
                )
                .await
                .unwrap();
        });
        (port, handle)
    }

    #[test]
    fn only_jinghua_backend_requires_the_sidecar() {
        assert!(requires_crypto_sidecar("jinghua_saas"));
        assert!(requires_crypto_sidecar("JINGHUA_SAAS"));
        assert!(!requires_crypto_sidecar("openai"));
        assert!(!requires_crypto_sidecar("openai_compatible"));
    }

    #[test]
    fn debug_path_resolution_honors_explicit_overrides() {
        let temp_dir = TempDir::new().unwrap();
        let node = temp_dir.path().join("node");
        let entry = temp_dir.path().join("server.mjs");
        std::fs::File::create(&node)
            .unwrap()
            .write_all(b"node")
            .unwrap();
        std::fs::File::create(&entry)
            .unwrap()
            .write_all(b"entry")
            .unwrap();

        let paths = SidecarPaths::resolve_with(
            Path::new("/tmp/SClaw.app/Contents/MacOS/ironclaw"),
            Some(node.clone().into_os_string()),
            Some(entry.clone().into_os_string()),
            true,
        )
        .unwrap();

        assert_eq!(paths.node, node);
        assert_eq!(paths.entry, entry);
    }

    #[test]
    fn release_path_resolution_rejects_a_missing_bundled_node() {
        let error = SidecarPaths::resolve_with(
            Path::new("/missing/SClaw.app/Contents/MacOS/ironclaw"),
            Some(OsString::from("/usr/local/bin/node")),
            Some(OsString::from("/tmp/server.mjs")),
            false,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            SidecarError::MissingPath {
                kind: "Node executable",
                ..
            }
        ));
        assert!(error.to_string().contains("Resources/node/bin/node"));
    }

    #[test]
    fn release_path_resolution_uses_only_bundled_resources() {
        let temp_dir = TempDir::new().unwrap();
        let contents = temp_dir.path().join("SClaw.app/Contents");
        let current_exe = contents.join("MacOS/ironclaw");
        let bundled_node = contents.join("Resources/node/bin/node");
        let bundled_entry = contents.join("Resources/crypto-bridge/server.mjs");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(bundled_node.parent().unwrap()).unwrap();
        std::fs::create_dir_all(bundled_entry.parent().unwrap()).unwrap();
        std::fs::write(&current_exe, b"ironclaw").unwrap();
        std::fs::write(&bundled_node, b"node").unwrap();
        std::fs::write(&bundled_entry, b"entry").unwrap();

        let paths = SidecarPaths::resolve_with(
            &current_exe,
            Some(OsString::from("/usr/local/bin/node")),
            Some(OsString::from("/tmp/server.mjs")),
            false,
        )
        .unwrap();

        assert_eq!(paths.node, bundled_node);
        assert_eq!(paths.entry, bundled_entry);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn start_waits_for_ready_and_health_then_shutdown_reaps_child() {
        let temp_dir = TempDir::new().unwrap();
        let (port, health_server) = serve_health_once().await;
        let entry = write_script(
            &temp_dir,
            &format!(
                "printf 'SCLAW_SIDECAR_READY {{\"port\":{port},\"sdkVersion\":\"test\"}}\\n'\ncat >/dev/null\n"
            ),
        );

        let mut sidecar = CryptoSidecar::start_with(
            shell_paths(entry),
            port,
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        health_server.await.unwrap();

        sidecar.shutdown().await.unwrap();
        sidecar.shutdown().await.unwrap();
        assert!(sidecar.child.is_none());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn ready_timeout_kills_and_reaps_the_child() {
        let temp_dir = TempDir::new().unwrap();
        let pid_path = temp_dir.path().join("pid");
        let entry = write_script(
            &temp_dir,
            &format!(
                "printf '%s' \"$$\" > '{}'\ncat >/dev/null\n",
                pid_path.display()
            ),
        );

        let error = CryptoSidecar::start_with(
            shell_paths(entry),
            SIDECAR_PORT,
            Duration::from_millis(100),
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, SidecarError::ReadyTimeout { .. }));
        let pid = std::fs::read_to_string(pid_path).unwrap();
        let status = std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "timed-out child should be reaped");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn early_exit_reports_only_the_exit_status() {
        let temp_dir = TempDir::new().unwrap();
        let entry = write_script(&temp_dir, "printf 'sensitive stderr' >&2\nexit 23\n");

        let error = CryptoSidecar::start_with(
            shell_paths(entry),
            SIDECAR_PORT,
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        let message = error.to_string();

        assert!(matches!(error, SidecarError::ExitedBeforeReady { .. }));
        assert!(message.contains("exit code 23"));
        assert!(!message.contains("sensitive stderr"));
    }
}
