//! The two channels keyd serves, each newline-delimited JSON-RPC 2.0 on a
//! 0600 Unix socket that only this user's processes can connect to:
//!
//! - `keyd.sock`, the souls' MCP server. Tools `credential` and
//!   `git_credential`; each call carries a daemon-signed grant in
//!   `params._meta["agent-bot/grant"]`, which `agent-bot-keyd mcp` (the
//!   harness-side relay) asks the daemon for with the soul's binding proof.
//!   A call returns an installation token, never key material.
//! - `owner.sock`, the owner's channel: `owner/import`, `owner/remove` and
//!   `owner/pin` each need the owner's consent, asked by keyd itself;
//!   `owner/status` says only whether an item exists. `owner/presence`
//!   asks the owner to approve one agent-bot action and returns keyd's
//!   signed assertion of it (presence.rs, agent-bot-identity #416); when no
//!   one can be asked here it fails with PRESENCE_UNAVAILABLE, so agent-bot
//!   may fall back to its own dialog, and never after a person declined.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::VerifyingKey;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::audit::{Audit, Receipt};
use crate::consent::{Consent, Refusal};
use crate::github::{self, Http};
use crate::grant::{self, Replay};
use crate::ids::{is_agent_id, is_app_slug};
use crate::paths::Paths;
use crate::presence;
use crate::store::{Credential, Store};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const GRANT_META: &str = "agent-bot/grant";
const MAX_LINE_BYTES: u64 = 1 << 20;
/// JSON-RPC error code: nobody could be asked here (no GUI session).
pub const PRESENCE_UNAVAILABLE: i64 = -32001;

pub struct Keyd {
    pub store: Store,
    pub http: Box<dyn Http>,
    pub consent: Box<dyn Consent>,
    pub audit: Audit,
    pub replay: Mutex<Replay>,
    pub owner_lock: Mutex<()>,
    pub now: fn() -> u64,
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn failure(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn tools() -> Value {
    json!([
        {
            "name": "credential",
            "description": "A GitHub App installation token for the App this soul acts as: one hour, one installation. The App's key stays in agent-bot-keyd.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        },
        {
            "name": "git_credential",
            "description": "git credential-helper output (username=x-access-token, password=<installation token>) for an https request to this soul's GitHub host; empty for any other host.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "protocol": { "type": "string" },
                    "host": { "type": "string" },
                },
                "required": ["protocol", "host"],
                "additionalProperties": false,
            },
        },
    ])
}

impl Keyd {
    fn pinned(&self) -> Result<VerifyingKey, String> {
        let raw = self
            .store
            .pinned_key()?
            .ok_or("no daemon key is pinned yet; the owner imports a soul's key first")?;
        VerifyingKey::from_bytes(&raw).map_err(|_| "pinned daemon key is malformed".to_owned())
    }

    /// One soul-channel message; None for a notification.
    pub fn handle_soul(&self, message: &Value) -> Option<Value> {
        let id = message.get("id")?.clone();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => reply(
                &id,
                json!({
                    "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "agent-bot-keyd", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "GitHub App installation tokens for this soul. The App key never leaves agent-bot-keyd.",
                }),
            ),
            "ping" => reply(&id, json!({})),
            "tools/list" => reply(&id, json!({ "tools": tools() })),
            "tools/call" => reply(&id, self.call_tool(&params)),
            _ => failure(&id, -32601, "method not found"),
        })
    }

    fn call_tool(&self, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        if !grant::TOOLS.contains(&name) {
            return tool_text(
                format!(
                    "unknown tool: {}",
                    name.chars().take(40).collect::<String>()
                ),
                true,
            );
        }
        let now = (self.now)();
        let token = params
            .pointer(&format!("/_meta/{}", GRANT_META.replace('/', "~1")))
            .and_then(Value::as_str);
        let Some(token) = token else {
            self.audit.record(
                Receipt {
                    event: "keyd-mint",
                    agent_id: None,
                    app: None,
                    operation: name,
                    decision: "denied",
                    detail: Some("no grant"),
                },
                now,
            );
            return tool_text("no grant: reach agent-bot-keyd through `agent-bot-keyd mcp`, which asks the daemon for one with this soul's binding".into(), true);
        };
        let verified = self.pinned().and_then(|key| {
            grant::verify(token, name, &key, now, &mut self.replay.lock().unwrap())
                .map_err(str::to_owned)
        });
        let grant = match verified {
            Ok(grant) => grant,
            Err(reason) => {
                self.audit.record(
                    Receipt {
                        event: "keyd-mint",
                        agent_id: None,
                        app: None,
                        operation: name,
                        decision: "denied",
                        detail: Some(&reason),
                    },
                    now,
                );
                return tool_text(reason, true);
            }
        };
        let receipt = |decision: &str, detail: Option<&str>| {
            self.audit.record(
                Receipt {
                    event: "keyd-mint",
                    agent_id: Some(&grant.agent_id),
                    app: Some(&grant.app),
                    operation: name,
                    decision,
                    detail,
                },
                now,
            );
        };
        let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
        if name == "git_credential" {
            let protocol = arguments.get("protocol").and_then(Value::as_str);
            let host = arguments.get("host").and_then(Value::as_str);
            // Like git-credential-bot.mjs: silent for anything that is not
            // https to this soul's GitHub host, so git moves on.
            if protocol != Some("https") || host != grant.host.as_deref() {
                receipt("declined", Some("not this soul's GitHub host"));
                return tool_text(String::new(), false);
            }
        }
        let credential = match self.store.credential(&grant.agent_id, &grant.app) {
            Ok(Some(credential)) => credential,
            Ok(None) => {
                receipt("failed", Some("no key held"));
                return tool_text(
                    format!("agent-bot-keyd holds no key for {} in this soul", grant.app),
                    true,
                );
            }
            Err(error) => {
                receipt("failed", Some(&error));
                return tool_text(error, true);
            }
        };
        match github::mint(self.http.as_ref(), &credential, &grant, now) {
            Ok(minted) => {
                receipt("granted", None);
                if name == "git_credential" {
                    return tool_text(
                        format!("username=x-access-token\npassword={}\n", minted.token),
                        false,
                    );
                }
                let grant_json = json!({
                    "app": grant.app,
                    "token": minted.token,
                    "expires_at": minted.expires_at,
                    "installation_id": minted.installation_id,
                });
                let mut result = tool_text(grant_json.to_string(), false);
                result["structuredContent"] = grant_json;
                result
            }
            Err(error) => {
                receipt("failed", Some(&error));
                tool_text(error, true)
            }
        }
    }

    /// One owner-channel message; None for a notification.
    pub fn handle_owner(&self, message: &Value) -> Option<Value> {
        let id = message.get("id")?.clone();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let now = (self.now)();
        let outcome = match method {
            "owner/presence" => return Some(self.owner_presence(&id, &params, now)),
            "owner/status" => self.owner_status(&params),
            "owner/import" | "owner/remove" | "owner/pin" => {
                let _one_prompt_at_a_time = self.owner_lock.lock().unwrap();
                let result = match method {
                    "owner/import" => self.owner_import(&params),
                    "owner/remove" => self.owner_remove(&params),
                    _ => self.owner_pin(&params),
                };
                let decision = if result.is_ok() { "granted" } else { "refused" };
                self.audit.record(
                    Receipt {
                        event: "keyd-owner",
                        agent_id: params
                            .get("agentId")
                            .and_then(Value::as_str)
                            .filter(|v| is_agent_id(v)),
                        app: params
                            .get("app")
                            .and_then(Value::as_str)
                            .filter(|v| is_app_slug(v)),
                        operation: method,
                        decision,
                        detail: result.as_ref().err().map(String::as_str),
                    },
                    now,
                );
                result
            }
            _ => return Some(failure(&id, -32601, "method not found")),
        };
        Some(match outcome {
            Ok(result) => reply(&id, result),
            Err(message) => failure(&id, -32000, &message),
        })
    }

    /// One approval for one agent-bot action, signed for agent-bot.
    fn owner_presence(&self, id: &Value, params: &Value, now: u64) -> Value {
        let action = params.get("action").and_then(Value::as_str);
        let nonce = params.get("nonce").and_then(Value::as_str);
        let (Some(action), Some(nonce)) = (action, nonce) else {
            return failure(id, -32602, "presence needs an action and a nonce");
        };
        if !presence::action_ok(action) {
            return failure(
                id,
                -32602,
                "the action must be one line of 1 to 400 characters",
            );
        }
        if !presence::nonce_ok(nonce) {
            return failure(id, -32602, "the nonce is not 16 to 64 base64url characters");
        }
        let _one_prompt_at_a_time = self.owner_lock.lock().unwrap();
        let outcome = self
            .store
            .presence_seed()
            .map_err(Refusal::Declined)
            .and_then(|seed| {
                self.consent.ask(&presence::reason(action))?;
                Ok(presence::sign(&seed, action, nonce, now))
            });
        let (decision, detail) = match &outcome {
            Ok(_) => ("granted", None),
            Err(Refusal::Unavailable(message)) => ("unavailable", Some(message.as_str())),
            Err(Refusal::Declined(message)) => ("refused", Some(message.as_str())),
        };
        // The receipt names the action by digest only: agent-bot's own audit
        // records the words.
        let digest = presence::digest(action);
        let detail = match detail {
            None => format!("action {digest}"),
            Some(message) => format!("action {digest}: {message}"),
        };
        self.audit.record(
            Receipt {
                event: "keyd-owner",
                agent_id: None,
                app: None,
                operation: "owner/presence",
                decision,
                detail: Some(&detail),
            },
            now,
        );
        match outcome {
            Ok(assertion) => reply(id, json!({ "assertion": assertion })),
            Err(Refusal::Unavailable(message)) => failure(id, PRESENCE_UNAVAILABLE, &message),
            Err(Refusal::Declined(message)) => failure(id, -32000, &message),
        }
    }

    fn soul_and_app(params: &Value) -> Result<(String, String), String> {
        let agent = params
            .get("agentId")
            .and_then(Value::as_str)
            .filter(|v| is_agent_id(v))
            .ok_or("agentId is not an Agent ID")?;
        let app = params
            .get("app")
            .and_then(Value::as_str)
            .filter(|v| is_app_slug(v))
            .ok_or("app is not a GitHub App slug")?;
        Ok((agent.to_owned(), app.to_owned()))
    }

    fn daemon_key(params: &Value) -> Result<Option<[u8; 32]>, String> {
        let Some(text) = params.get("daemonKey") else {
            return Ok(None);
        };
        let raw = text
            .as_str()
            .and_then(|t| STANDARD.decode(t).ok())
            .ok_or("daemonKey is not base64")?;
        let raw: [u8; 32] = raw
            .try_into()
            .map_err(|_| "daemonKey is not an Ed25519 public key")?;
        VerifyingKey::from_bytes(&raw).map_err(|_| "daemonKey is not an Ed25519 public key")?;
        Ok(Some(raw))
    }

    fn owner_status(&self, params: &Value) -> Result<Value, String> {
        let pinned = self.store.pinned_key()?.is_some();
        if params.get("agentId").is_none() && params.get("app").is_none() {
            return Ok(json!({ "pinned": pinned, "version": env!("CARGO_PKG_VERSION") }));
        }
        let (agent, app) = Self::soul_and_app(params)?;
        let held = self.store.credential(&agent, &app)?.is_some();
        Ok(json!({ "pinned": pinned, "held": held, "version": env!("CARGO_PKG_VERSION") }))
    }

    /// One key, or several under `items` with one consent for all of them.
    fn owner_import(&self, params: &Value) -> Result<Value, String> {
        let entries: Vec<Value> = match params.get("items") {
            Some(Value::Array(items)) if !items.is_empty() && items.len() <= 64 => items.clone(),
            Some(_) => return Err("items must be a list of 1 to 64 keys".into()),
            None => vec![params.clone()],
        };
        let mut keys = Vec::with_capacity(entries.len());
        for entry in &entries {
            let (agent, app) = Self::soul_and_app(entry)?;
            let app_id = entry
                .get("appId")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
                .ok_or("appId is not a GitHub App ID")?;
            let pem = entry
                .get("privateKeyPem")
                .and_then(Value::as_str)
                .ok_or("privateKeyPem is missing")?;
            let credential = Credential {
                app_id: app_id.to_owned(),
                private_key_pem: pem.to_owned(),
            };
            // A key keyd cannot sign with is refused before anyone is asked.
            github::app_jwt(&credential, (self.now)())?;
            keys.push((agent, app, credential));
        }
        let offered = Self::daemon_key(params)?;
        let pinned = self.store.pinned_key()?;
        let pin = match (pinned, offered) {
            (None, None) => {
                return Err("no daemon key is pinned; pass daemonKey with the first import".into())
            }
            (None, Some(key)) => Some(key),
            (Some(current), Some(key)) if current != key => {
                return Err(
                    "a different daemon key is pinned; pin the new one with owner/pin first".into(),
                );
            }
            _ => None,
        };
        let mut named: Vec<String> = keys
            .iter()
            .take(4)
            .map(|(agent, app, _)| format!("{app} (soul {agent})"))
            .collect();
        if keys.len() > 4 {
            named.push(format!("{} more", keys.len() - 4));
        }
        self.consent.ask(&format!(
            "keep GitHub App keys in agent-bot-keyd: {}{}",
            named.join(", "),
            if pin.is_some() {
                "; and trust this account's agent-bot daemon to request tokens"
            } else {
                ""
            }
        ))?;
        if let Some(key) = pin {
            self.store.pin_key(&key)?;
        }
        for (agent, app, credential) in &keys {
            self.store.put_credential(agent, app, credential)?;
            let back = self
                .store
                .credential(agent, app)?
                .ok_or("the keychain did not return what was written")?;
            if back.app_id != credential.app_id
                || back.private_key_pem != credential.private_key_pem
            {
                return Err("the keychain did not return what was written".into());
            }
            self.audit.record(
                Receipt {
                    event: "keyd-owner",
                    agent_id: Some(agent),
                    app: Some(app),
                    operation: "owner/import item",
                    decision: "stored",
                    detail: None,
                },
                (self.now)(),
            );
        }
        Ok(json!({ "stored": keys.len(), "pinned": pin.is_some() }))
    }

    fn owner_remove(&self, params: &Value) -> Result<Value, String> {
        let (agent, app) = Self::soul_and_app(params)?;
        self.consent.ask(&format!(
            "delete the {app} GitHub App key for soul {agent} from agent-bot-keyd"
        ))?;
        Ok(json!({ "removed": self.store.remove_credential(&agent, &app)? }))
    }

    fn owner_pin(&self, params: &Value) -> Result<Value, String> {
        let key = Self::daemon_key(params)?.ok_or("daemonKey is missing")?;
        if self.store.pinned_key()? == Some(key) {
            return Ok(json!({ "pinned": false }));
        }
        self.consent
            .ask("trust a new agent-bot daemon key to request GitHub tokens from agent-bot-keyd")?;
        self.store.pin_key(&key)?;
        Ok(json!({ "pinned": true }))
    }
}

/// The peer's user ID, from the kernel.
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: a connected socket and two out-pointers.
    (unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
}

fn serve_connection(stream: UnixStream, handle: impl Fn(&Value) -> Option<Value>) {
    // SAFETY: getuid cannot fail.
    if peer_uid(&stream) != Some(unsafe { libc::getuid() }) {
        return;
    }
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = Vec::new();
        match (&mut reader)
            .take(MAX_LINE_BYTES)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.last() != Some(&b'\n') && line.len() as u64 >= MAX_LINE_BYTES {
            let _ = writeln!(
                writer,
                "{}",
                failure(&Value::Null, -32600, "message too large")
            );
            return;
        }
        if line.trim_ascii().is_empty() {
            continue;
        }
        let response = match serde_json::from_slice::<Value>(&line) {
            Ok(message) if message.is_object() => handle(&message),
            Ok(_) => Some(failure(&Value::Null, -32600, "batches are not supported")),
            Err(_) => Some(failure(&Value::Null, -32700, "parse error")),
        };
        if let Some(response) = response {
            if writeln!(writer, "{response}").is_err() {
                return;
            }
        }
    }
}

/// The directory must be this user's and private; it is made so if new.
fn private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // SAFETY: getuid cannot fail.
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
        return Err(format!(
            "{} is not a directory this user owns",
            dir.display()
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("{}: {e}", dir.display()))
}

/// Binds `path`, replacing a stale socket but never a live keyd's.
fn bind(path: &Path) -> Result<UnixListener, String> {
    if UnixStream::connect(path).is_ok() {
        return Err(format!(
            "another agent-bot-keyd is serving {}",
            path.display()
        ));
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket_like() => {
            std::fs::remove_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(_) => return Err(format!("{} exists and is not a socket", path.display())),
        Err(_) => {}
    }
    let listener = UnixListener::bind(path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(listener)
}

trait SocketLike {
    fn is_socket_like(&self) -> bool;
}

impl SocketLike for std::fs::FileType {
    fn is_socket_like(&self) -> bool {
        use std::os::unix::fs::FileTypeExt;
        self.is_socket()
    }
}

pub struct Listeners {
    pub soul: UnixListener,
    pub owner: UnixListener,
}

pub fn listen(paths: &Paths) -> Result<Listeners, String> {
    private_dir(&paths.dir)?;
    Ok(Listeners {
        soul: bind(&paths.socket)?,
        owner: bind(&paths.owner_socket)?,
    })
}

/// Serves both channels until the process ends.
pub fn serve(keyd: Arc<Keyd>, listeners: Listeners) {
    let owner_keyd = Arc::clone(&keyd);
    let owner = listeners.owner;
    std::thread::spawn(move || {
        for stream in owner.incoming().flatten() {
            let keyd = Arc::clone(&owner_keyd);
            std::thread::spawn(move || serve_connection(stream, |m| keyd.handle_owner(m)));
        }
    });
    for stream in listeners.soul.incoming().flatten() {
        let keyd = Arc::clone(&keyd);
        std::thread::spawn(move || serve_connection(stream, |m| keyd.handle_soul(m)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consent::tests::Scripted as Consenting;
    use crate::github::tests::{test_key_pem, Scripted as GitHub};
    use crate::grant::tests::{payload, sign, signing_key, AGENT};
    use crate::store::tests::Memory;

    const NOW: u64 = 1_800_000_000;

    fn keyd(approve: bool) -> Keyd {
        Keyd {
            store: Store::new(Box::<Memory>::default()),
            http: Box::new(GitHub::new(
                json!([{ "id": 7, "account": { "login": "qwts" } }]),
            )),
            consent: Box::new(Consenting::new(approve)),
            audit: Audit::none(),
            replay: Mutex::default(),
            owner_lock: Mutex::default(),
            now: || NOW,
        }
    }

    fn daemon_key() -> String {
        STANDARD.encode(signing_key().verifying_key().to_bytes())
    }

    fn import(keyd: &Keyd, pem: &str) -> Value {
        keyd.handle_owner(&json!({ "jsonrpc": "2.0", "id": 1, "method": "owner/import", "params": {
            "agentId": AGENT, "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": daemon_key(),
        }})).unwrap()
    }

    fn call(keyd: &Keyd, tool: &str, arguments: Value, grant: Option<String>) -> Value {
        let mut params = json!({ "name": tool, "arguments": arguments });
        if let Some(grant) = grant {
            params["_meta"] = json!({ GRANT_META: grant });
        }
        keyd.handle_soul(
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": params }),
        )
        .unwrap()["result"]
            .clone()
    }

    #[test]
    fn speaks_mcp() {
        let keyd = keyd(true);
        let init = keyd.handle_soul(&json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(keyd
            .handle_soul(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .is_none());
        let list = keyd
            .handle_soul(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
            .unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["credential", "git_credential"]);
        let unknown = keyd
            .handle_soul(&json!({ "jsonrpc": "2.0", "id": 3, "method": "owner/import" }))
            .unwrap();
        assert_eq!(
            unknown["error"]["code"], -32601,
            "owner methods are not on the soul channel"
        );
    }

    #[test]
    fn mints_with_a_daemon_grant_and_never_returns_the_key() {
        let keyd = keyd(true);
        let (pem, _) = test_key_pem();
        assert_eq!(
            import(&keyd, &pem)["result"],
            json!({ "stored": 1, "pinned": true })
        );
        let result = call(
            &keyd,
            "credential",
            json!({}),
            Some(sign(&signing_key(), &payload("credential", NOW))),
        );
        assert_eq!(result["isError"], false);
        assert_eq!(result["structuredContent"]["token"], "ghs_test");
        assert_eq!(result["structuredContent"]["installation_id"], 7);
        let text = result.to_string();
        assert!(!text.contains("PRIVATE KEY") && !text.contains(&pem[40..80]));
    }

    #[test]
    fn refuses_calls_without_a_valid_grant() {
        let keyd = keyd(true);
        let (pem, _) = test_key_pem();
        // Before the owner pins a key nothing is accepted.
        let early = call(
            &keyd,
            "credential",
            json!({}),
            Some(sign(&signing_key(), &payload("credential", NOW))),
        );
        assert_eq!(early["isError"], true);
        import(&keyd, &pem);
        assert_eq!(call(&keyd, "credential", json!({}), None)["isError"], true);
        let forged = sign(
            &ed25519_dalek::SigningKey::from_bytes(&[1; 32]),
            &payload("credential", NOW),
        );
        assert_eq!(
            call(&keyd, "credential", json!({}), Some(forged))["content"][0]["text"],
            "grant signature is not the daemon's"
        );
        let grant = sign(&signing_key(), &payload("credential", NOW));
        assert_eq!(
            call(&keyd, "credential", json!({}), Some(grant.clone()))["isError"],
            false
        );
        assert_eq!(
            call(&keyd, "credential", json!({}), Some(grant))["content"][0]["text"],
            "grant was already used"
        );
    }

    #[test]
    fn git_credential_answers_only_for_the_granted_host() {
        let keyd = keyd(true);
        let (pem, _) = test_key_pem();
        import(&keyd, &pem);
        let ok = call(
            &keyd,
            "git_credential",
            json!({ "protocol": "https", "host": "github.com" }),
            Some(sign(&signing_key(), &payload("git_credential", NOW))),
        );
        assert_eq!(
            ok["content"][0]["text"],
            "username=x-access-token\npassword=ghs_test\n"
        );
        let other = call(
            &keyd,
            "git_credential",
            json!({ "protocol": "https", "host": "evil.example" }),
            Some(sign(&signing_key(), &{
                let mut p = payload("git_credential", NOW);
                p["nonce"] = json!("other-host-nonce-0123456789");
                p
            })),
        );
        assert_eq!(
            (
                other["content"][0]["text"].as_str(),
                other["isError"].as_bool()
            ),
            (Some(""), Some(false))
        );
    }

    #[test]
    fn owner_operations_need_consent_and_a_matching_pin() {
        let refusing = keyd(false);
        let (pem, _) = test_key_pem();
        assert!(import(&refusing, &pem)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("did not approve"));
        assert!(
            refusing.store.pinned_key().unwrap().is_none(),
            "nothing changes without consent"
        );

        let keyd = keyd(true);
        import(&keyd, &pem);
        let other = STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[2; 32])
                .verifying_key()
                .to_bytes(),
        );
        let mismatch = keyd.handle_owner(&json!({ "jsonrpc": "2.0", "id": 4, "method": "owner/import", "params": {
            "agentId": AGENT, "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": other,
        }})).unwrap();
        assert!(mismatch["error"]["message"]
            .as_str()
            .unwrap()
            .contains("different daemon key"));
        let bad = keyd.handle_owner(&json!({ "jsonrpc": "2.0", "id": 5, "method": "owner/import", "params": {
            "agentId": AGENT, "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": "nope",
        }})).unwrap();
        assert_eq!(bad["error"]["message"], "App key is not PEM");
        let status = keyd.handle_owner(&json!({ "jsonrpc": "2.0", "id": 6, "method": "owner/status", "params": { "agentId": AGENT, "app": "qwts-claude-agent" } })).unwrap();
        assert_eq!(
            (
                status["result"]["pinned"].as_bool(),
                status["result"]["held"].as_bool()
            ),
            (Some(true), Some(true))
        );
        assert!(!status.to_string().contains("PRIVATE"));
        let removed = keyd.handle_owner(&json!({ "jsonrpc": "2.0", "id": 7, "method": "owner/remove", "params": { "agentId": AGENT, "app": "qwts-claude-agent" } })).unwrap();
        assert_eq!(removed["result"]["removed"], true);
    }

    #[test]
    fn serves_over_a_private_socket() {
        let dir = crate::paths::tests::short_temp_dir("sock");
        let paths = Paths::under(&dir);
        let listeners = listen(&paths).unwrap();
        assert_eq!(
            std::fs::metadata(&paths.dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&paths.socket)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(listen(&paths).is_err(), "a live keyd is never replaced");
        let keyd = Arc::new(keyd(true));
        std::thread::spawn(move || serve(keyd, listeners));
        let mut stream = UnixStream::connect(&paths.socket).unwrap();
        writeln!(
            stream,
            "{}",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })
        )
        .unwrap();
        writeln!(stream, "not json").unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["result"],
            json!({})
        );
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["error"]["code"],
            -32700
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_several_keys_with_one_consent() {
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        let (pem, _) = test_key_pem();
        let second = "agent_3a005b6d-87a7-82c0-82a1-f946c045ce9b";
        let result = keyd
            .handle_owner(&json!({ "jsonrpc": "2.0", "id": 1, "method": "owner/import", "params": {
                "daemonKey": daemon_key(),
                "items": [
                    { "agentId": AGENT, "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem },
                    { "agentId": second, "app": "qwts-grok-agent", "appId": "43", "privateKeyPem": pem },
                ],
            }}))
            .unwrap();
        assert_eq!(result["result"], json!({ "stored": 2, "pinned": true }));
        let asked = consent.asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("qwts-claude-agent") && asked[0].contains("qwts-grok-agent"));
        assert!(keyd
            .store
            .credential(second, "qwts-grok-agent")
            .unwrap()
            .is_some());
    }

    fn presence(keyd: &Keyd, params: Value) -> Value {
        keyd.handle_owner(
            &json!({ "jsonrpc": "2.0", "id": 9, "method": "owner/presence", "params": params }),
        )
        .unwrap()
    }

    #[test]
    fn signs_presence_only_when_the_owner_approves() {
        let consent = Arc::new(Consenting::new(true));
        let mut approving = keyd(true);
        approving.consent = Box::new(Arc::clone(&consent));
        let action =
            "turn agent comms off for Bill - Starter (agent_121b5b35-0000-4000-8000-000000000000)";
        let nonce = "abcdefghijklmnopqrstuvwx";
        let answer = presence(&approving, json!({ "action": action, "nonce": nonce }));
        let token = answer["result"]["assertion"].as_str().unwrap();
        let seed = approving.store.presence_seed().unwrap();
        let payload = crate::presence::tests::open(token, &seed);
        assert_eq!(payload["action"], crate::presence::digest(action));
        assert_eq!(payload["nonce"], nonce);
        assert_eq!(payload["iat"].as_u64(), Some(NOW));
        assert_eq!(
            consent.asked.lock().unwrap().clone(),
            vec![format!("agent-bot wants to {action}")]
        );

        let declined = presence(&keyd(false), json!({ "action": action, "nonce": nonce }));
        assert_eq!(declined["error"]["code"], -32000);
        assert!(declined.get("result").is_none());

        let mut nobody = keyd(true);
        nobody.consent = Box::new(Consenting::unavailable());
        let unavailable = presence(&nobody, json!({ "action": action, "nonce": nonce }));
        assert_eq!(unavailable["error"]["code"], PRESENCE_UNAVAILABLE);
    }

    #[test]
    fn refuses_malformed_presence_requests_without_asking() {
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        for params in [
            json!({ "action": "x" }),
            json!({ "action": "two\nlines", "nonce": "abcdefghijklmnopqrstuvwx" }),
            json!({ "action": "x".repeat(401), "nonce": "abcdefghijklmnopqrstuvwx" }),
            json!({ "action": "ok", "nonce": "short" }),
        ] {
            assert_eq!(presence(&keyd, params)["error"]["code"], -32602);
        }
        assert!(consent.asked.lock().unwrap().is_empty());
        // Presence is for the owner channel only.
        let soul = keyd
            .handle_soul(&json!({ "jsonrpc": "2.0", "id": 1, "method": "owner/presence", "params": { "action": "ok", "nonce": "abcdefghijklmnopqrstuvwx" } }))
            .unwrap();
        assert!(soul.get("result").is_none());
    }
}
