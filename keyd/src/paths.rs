//! keyd's files, under agent-bot's state directory (vouch.mjs's
//! vouchStateDir): `$XDG_STATE_HOME/agent-bot` or `~/.local/state/agent-bot`.
//!
//!   keyd/            0700
//!     keyd.sock      0600  souls' MCP endpoint (credential, git_credential)
//!     owner.sock     0600  the owner's channel (import, remove, pin, status)
//!     audit.jsonl    0600  one receipt per call, never a secret

use std::path::{Path, PathBuf};

pub fn state_dir() -> Result<PathBuf, &'static str> {
    if let Some(base) = std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(base).join("agent-bot"));
    }
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .ok_or("HOME is not set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("agent-bot"))
}

pub struct Paths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub owner_socket: PathBuf,
    pub audit: PathBuf,
}

impl Paths {
    pub fn under(state: &Path) -> Self {
        let dir = state.join("keyd");
        Self {
            socket: dir.join("keyd.sock"),
            owner_socket: dir.join("owner.sock"),
            audit: dir.join("audit.jsonl"),
            dir,
        }
    }
}

#[cfg(test)]
pub mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Unix socket paths are capped near 104 bytes, so tests use short ones.
    pub fn short_temp_dir(tag: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = PathBuf::from(format!(
            "/tmp/kd-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
