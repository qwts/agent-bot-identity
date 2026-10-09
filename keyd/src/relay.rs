//! `agent-bot-keyd mcp`: what a harness runs as its MCP server. It holds no
//! key and opens no Keychain item. It relays stdio to keyd's socket and, for
//! each tool call, asks the daemon for a grant with the soul's binding proof
//! (binding-proof.mjs, byte for byte), so keyd mints only for the soul the
//! daemon says this session is.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::server::GRANT_META;

pub const PROOF_HEADER: &str = "x-agent-binding-proof";
pub const GRANT_PATH: &str = "/v0/keyd/grant";

#[derive(Deserialize)]
pub struct Binding {
    pub v: u32,
    pub secret: String,
    pub daemon: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
}

/// The binding file, read like agent-binding.mjs's readPrivate: no link, a
/// regular file this user owns, readable by nobody else.
pub fn read_binding_file(path: &Path) -> Result<Binding, String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "the agent binding could not be opened".to_owned())?;
    let meta = file
        .metadata()
        .map_err(|_| "the agent binding could not be read".to_owned())?;
    // SAFETY: getuid cannot fail.
    if !meta.is_file() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
        return Err("the agent binding is not a private file this user owns".into());
    }
    let mut text = String::new();
    (&file)
        .take(64 * 1024)
        .read_to_string(&mut text)
        .map_err(|_| "the agent binding could not be read".to_owned())?;
    let binding: Binding =
        serde_json::from_str(&text).map_err(|_| "unsupported binding shape".to_owned())?;
    let secret_ok = binding.secret.len() == 43
        && binding
            .secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if binding.v != 1
        || !secret_ok
        || authority(&binding.daemon).is_none()
        || !crate::ids::is_agent_id(&binding.agent_id)
    {
        return Err("unsupported binding shape".into());
    }
    Ok(binding)
}

/// AGENT_BOT_BINDING, else `<git dir>/agent-binding.json` for the cwd.
pub fn find_binding() -> Result<Option<Binding>, String> {
    let path = match std::env::var_os("AGENT_BOT_BINDING").filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => {
            let output = std::process::Command::new("git")
                .args(["rev-parse", "--absolute-git-dir"])
                .stderr(std::process::Stdio::null())
                .output();
            match output {
                Ok(out) if out.status.success() => {
                    let dir = String::from_utf8_lossy(&out.stdout).trim().to_owned();
                    let path = PathBuf::from(dir).join("agent-binding.json");
                    if !path.exists() {
                        return Ok(None);
                    }
                    path
                }
                _ => return Ok(None),
            }
        }
    };
    read_binding_file(&path).map(Some)
}

/// `new URL(daemon).host` for the loopback daemon URLs a binding may hold.
pub fn authority(daemon: &str) -> Option<String> {
    let rest = daemon.strip_prefix("http://")?;
    let host = rest.strip_suffix('/')?;
    if host.contains('/') || host.contains('@') {
        return None;
    }
    let (name, port) = host.rsplit_once(':')?;
    if !matches!(name, "127.0.0.1" | "[::1]")
        || port.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    Some(if port == 80 {
        name.to_owned()
    } else {
        format!("{name}:{port}")
    })
}

/// binding-proof.mjs's signBindingProof.
pub fn sign_proof(
    secret: &str,
    method: &str,
    path: &str,
    authority: &str,
    now_ms: u64,
    nonce: &str,
) -> String {
    let key = Sha256::digest(secret.as_bytes());
    let mut id = Sha256::new();
    id.update(b"agent-binding-id\0");
    id.update(key);
    let key_id = URL_SAFE_NO_PAD.encode(id.finalize());
    let ts = now_ms.to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("any key length");
    mac.update(
        [
            "agent-binding-proof",
            "v1",
            &method.to_ascii_uppercase(),
            path,
            authority,
            &ts,
            nonce,
        ]
        .join("\n")
        .as_bytes(),
    );
    format!(
        "v1.{key_id}.{ts}.{nonce}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 18];
    getrandom::fill(&mut bytes).expect("system randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Asks the daemon for a one-call grant for `tool`.
pub fn fetch_grant(binding: &Binding, tool: &str) -> Result<String, String> {
    let authority = authority(&binding.daemon).ok_or("unsupported binding shape")?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let proof = sign_proof(
        &binding.secret,
        "POST",
        GRANT_PATH,
        &authority,
        now_ms,
        &random_nonce(),
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .into();
    let mut response = agent
        .post(&format!("http://{authority}{GRANT_PATH}"))
        .header(PROOF_HEADER, &proof)
        .send_json(json!({ "tool": tool }))
        .map_err(|_| "the agent-bot daemon could not be reached".to_owned())?;
    let status = response.status().as_u16();
    let body: Value = response.body_mut().read_json().unwrap_or(Value::Null);
    if status != 200 {
        let reason = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("refused");
        return Err(format!(
            "the daemon gave no grant (HTTP {status}: {})",
            reason.chars().take(200).collect::<String>()
        ));
    }
    body.get("grant")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "the daemon gave no grant".to_owned())
}

type Out = Arc<Mutex<std::io::Stdout>>;

fn emit(out: &Out, message: &Value) {
    let mut out = out.lock().unwrap();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn tool_error(id: &Value, text: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }], "isError": true } })
}

/// Adds the grant to a tools/call, or answers it with the reason there is none.
pub fn prepare(
    mut message: Value,
    grant: impl Fn(&str) -> Result<String, String>,
) -> Result<Value, Value> {
    if message.get("method").and_then(Value::as_str) != Some("tools/call") {
        return Ok(message);
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let tool = message
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    match grant(&tool) {
        Ok(token) => {
            let params = message
                .get_mut("params")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| tool_error(&id, "tools/call has no params".into()))?;
            let meta = params.entry("_meta").or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            meta[GRANT_META] = json!(token);
            Ok(message)
        }
        Err(reason) => Err(tool_error(&id, reason)),
    }
}

pub fn run(socket: &Path) -> Result<(), String> {
    let binding = find_binding()?;
    let stream = UnixStream::connect(socket)
        .map_err(|_| format!("agent-bot-keyd is not running ({})", socket.display()))?;
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    let back = Arc::clone(&out);
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let mut out = back.lock().unwrap();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
        // keyd went away: nothing more can be answered.
        std::process::exit(0);
    });
    let mut writer = stream;
    let grant = |tool: &str| match &binding {
        Some(binding) => fetch_grant(binding, tool),
        None => Err(
            "this session has no agent binding, so agent-bot-keyd cannot tell which soul it is"
                .to_owned(),
        ),
    };
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            // keyd answers malformed input itself.
            writeln!(writer, "{line}").map_err(|e| e.to_string())?;
            continue;
        };
        match prepare(message, grant) {
            Ok(message) => writeln!(writer, "{message}").map_err(|e| e.to_string())?,
            Err(answer) => emit(&out, &answer),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_match_binding_proof_mjs() {
        // Generated with binding-proof.mjs:
        // signBindingProof({ secret: 'A'.repeat(43), method: 'POST', path: '/v0/keyd/grant',
        //   authority: '127.0.0.1:4100', now: 1800000000000, nonce: 'bm9uY2Utbm9uY2Utbm9u' })
        let proof = sign_proof(
            &"A".repeat(43),
            "post",
            "/v0/keyd/grant",
            "127.0.0.1:4100",
            1_800_000_000_000,
            "bm9uY2Utbm9uY2Utbm9u",
        );
        assert_eq!(proof, include_str!("../tests/fixtures/proof.txt").trim());
    }

    #[test]
    fn authority_matches_url_host() {
        assert_eq!(
            authority("http://127.0.0.1:4100/").as_deref(),
            Some("127.0.0.1:4100")
        );
        assert_eq!(
            authority("http://[::1]:4100/").as_deref(),
            Some("[::1]:4100")
        );
        assert_eq!(
            authority("http://127.0.0.1:80/").as_deref(),
            Some("127.0.0.1")
        );
        assert!(authority("http://example.com:4100/").is_none());
        assert!(authority("https://127.0.0.1:4100/").is_none());
        assert!(authority("http://127.0.0.1:4100/x").is_none());
    }

    #[test]
    fn adds_the_grant_only_to_tool_calls() {
        let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        assert_eq!(prepare(list.clone(), |_| unreachable!()).unwrap(), list);
        let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "credential" } });
        let sent = prepare(call.clone(), |tool| Ok(format!("grant-for-{tool}"))).unwrap();
        assert_eq!(sent["params"]["_meta"][GRANT_META], "grant-for-credential");
        let refused = prepare(call, |_| Err("no binding".into())).unwrap_err();
        assert_eq!(refused["result"]["isError"], true);
        assert_eq!(refused["id"], 2);
    }

    #[test]
    fn reads_only_a_private_binding() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::paths::tests::short_temp_dir("bind");
        let file = dir.join("agent-binding.json");
        let body = json!({ "v": 1, "secret": "A".repeat(43), "daemon": "http://127.0.0.1:4100/",
            "account": "user", "agentId": "agent_ea588a53-c6ce-430b-9d71-89897d843ab6", "parent": null });
        std::fs::write(&file, body.to_string()).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_binding_file(&file).is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_binding_file(&file).unwrap().agent_id,
            "agent_ea588a53-c6ce-430b-9d71-89897d843ab6"
        );
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_binding_file(&link).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
