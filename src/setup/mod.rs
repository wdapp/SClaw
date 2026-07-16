//! Interactive setup wizard for IronClaw.
//!
//! Provides a guided setup experience for:
//! 1. Database connection
//! 2. Security (secrets master key)
//! 3. Inference provider selection
//! 4. Model selection
//! 5. Embeddings
//! 6. Channel configuration (HTTP, Telegram, etc.)
//! 7. Extensions (tool installation from registry)
//! 8. Heartbeat (background tasks)
//!
//! # Example
//!
//! ```ignore
//! use ironclaw::setup::SetupWizard;
//!
//! let mut wizard = SetupWizard::new();
//! wizard.run().await?;
//! ```

mod channels;
mod prompts;
#[cfg(any(feature = "postgres", feature = "libsql"))]
mod wizard;

pub use channels::{ChannelSetupError, SecretsContext, setup_http, setup_tunnel};
pub use prompts::{
    confirm, input, optional_input, print_error, print_header, print_info, print_step,
    print_success, secret_input, select_many, select_one,
};
#[cfg(any(feature = "postgres", feature = "libsql"))]
pub use wizard::{SetupConfig, SetupWizard};

/// Check if onboarding is needed and return the reason.
///
/// Reads environment variables (`DATABASE_URL`, `LIBSQL_PATH`,
/// `ONBOARD_COMPLETED`, `NEARAI_API_KEY`) and checks for the default
/// session file on disk. Not safe to call concurrently with `env::set_var`.
#[cfg(any(feature = "postgres", feature = "libsql"))]
pub fn check_onboard_needed() -> Option<&'static str> {
    let has_db = crate::config::env_or_override("DATABASE_URL").is_some()
        || crate::config::env_or_override("LIBSQL_PATH").is_some()
        || matches!(
            crate::config::env_or_override("DATABASE_BACKEND").as_deref(),
            Some("libsql") | Some("sqlite") | Some("turso")
        )
        || matches!(crate::config::DatabaseBackend::default(), crate::config::DatabaseBackend::LibSql)
        || crate::config::default_libsql_path().exists();

    if !has_db {
        return Some("Database not configured");
    }

    if crate::config::env_or_override("ONBOARD_COMPLETED")
        .map(|v| v == "true")
        .unwrap_or(false)
    {
        return None;
    }

    let backend = crate::config::env_or_override("LLM_BACKEND")
        .unwrap_or_else(|| crate::config::DEFAULT_SCLAW_LLM_BACKEND.to_string());
    if backend == crate::config::DEFAULT_SCLAW_LLM_BACKEND {
        if crate::config::llm::has_bundled_jinghua_api_key()
            || crate::config::env_or_override("JINGHUA_API_KEY").is_some()
        {
            return None;
        }
        return Some("Jinghua API key not configured");
    }
    if backend == "openai_compatible" {
        return None;
    }

    if crate::config::env_or_override("NEARAI_API_KEY").is_none() {
        let session_path = crate::config::default_session_path();
        if !session_path.exists() {
            return Some("First run");
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::helpers::ENV_MUTEX;

    #[test]
    fn sclaw_default_requires_a_credential_before_skipping_onboarding() {
        let _guard = ENV_MUTEX.lock().expect("env mutex poisoned");
        let names = [
            "DATABASE_BACKEND",
            "LLM_BACKEND",
            "ONBOARD_COMPLETED",
            "JINGHUA_API_KEY",
        ];
        let originals: Vec<_> = names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect();

        // SAFETY: Only called under ENV_MUTEX in tests.
        unsafe {
            std::env::set_var("DATABASE_BACKEND", "libsql");
            std::env::remove_var("LLM_BACKEND");
            std::env::remove_var("ONBOARD_COMPLETED");
            std::env::remove_var("JINGHUA_API_KEY");
        }

        let expected = if crate::config::llm::has_bundled_jinghua_api_key() {
            None
        } else {
            Some("Jinghua API key not configured")
        };
        assert_eq!(check_onboard_needed(), expected);

        // SAFETY: Only called under ENV_MUTEX in tests.
        unsafe {
            std::env::set_var("JINGHUA_API_KEY", "test-jinghua-key");
        }
        assert_eq!(check_onboard_needed(), None);

        // SAFETY: Restore process environment while still holding ENV_MUTEX.
        unsafe {
            for (name, value) in originals {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }
}
