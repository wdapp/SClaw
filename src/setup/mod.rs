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
        .unwrap_or_else(|| "openai_compatible".to_string());
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
