//! One JSON line per call in `keyd/audit.jsonl` (0600): who, which App,
//! which tool, and the decision. Never a token, a JWT or a key.

use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Audit {
    file: Option<PathBuf>,
    lock: Mutex<()>,
}

pub struct Receipt<'a> {
    pub event: &'a str,
    pub agent_id: Option<&'a str>,
    pub app: Option<&'a str>,
    pub operation: &'a str,
    pub decision: &'a str,
    pub detail: Option<&'a str>,
}

fn clean(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect()
}

impl Audit {
    pub fn to(file: PathBuf) -> Self {
        Self {
            file: Some(file),
            lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn none() -> Self {
        Self {
            file: None,
            lock: Mutex::new(()),
        }
    }

    pub fn record(&self, receipt: Receipt, at: u64) {
        let Some(file) = &self.file else { return };
        let mut line: Value = json!({
            "at": at,
            "event": receipt.event,
            "operation": receipt.operation,
            "decision": receipt.decision,
        });
        if let Some(agent) = receipt.agent_id {
            line["agentId"] = json!(agent);
        }
        if let Some(app) = receipt.app {
            line["app"] = json!(app);
        }
        if let Some(detail) = receipt.detail {
            line["detail"] = json!(clean(detail));
        }
        let _guard = self.lock.lock();
        // A receipt that cannot be written is not a reason to fail the call:
        // the daemon keeps its own receipt of every grant it signs.
        if let Ok(mut out) = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(file)
        {
            let _ = writeln!(out, "{line}");
        }
    }
}
