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
//!   `owner/status` says only whether an item exists. `owner/app-import`,
//!   `owner/app-remove` and `owner/app-status` do the same for App-level
//!   keys, held by App slug rather than by soul (agent-bot-identity #110);
//!   a grant names `keyScope: "app"` to mint with one. `owner/presence`
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
use crate::grant::{self, KeyScope, Replay};
use crate::ids::{is_agent_id, is_app_slug};
use crate::paths::Paths;
use crate::pins;
use crate::presence;
use crate::store::{Credential, OwnerPins, Store};

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
        // The grant says which item; keyd never falls back to the other.
        let scope = grant.scope();
        let (held, missing, granted) = match scope {
            KeyScope::Soul => (
                self.store.credential(&grant.agent_id, &grant.app),
                format!("agent-bot-keyd holds no key for {} in this soul", grant.app),
                None,
            ),
            KeyScope::App => (
                self.store.app_credential(&grant.app),
                format!("agent-bot-keyd holds no App-level key for {}", grant.app),
                Some("App-level key"),
            ),
        };
        let credential = match held {
            Ok(Some(credential)) => credential,
            Ok(None) => {
                receipt(
                    "failed",
                    Some(match scope {
                        KeyScope::Soul => "no key held",
                        KeyScope::App => "no App-level key held",
                    }),
                );
                return tool_text(missing, true);
            }
            Err(error) => {
                receipt("failed", Some(&error));
                return tool_text(error, true);
            }
        };
        match github::mint(self.http.as_ref(), &credential, &grant, now) {
            Ok(minted) => {
                receipt("granted", granted);
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
            "owner/pins-attest" => return Some(self.owner_pins_attest(&id, &params, now)),
            "owner/pins-status" => return Some(self.owner_pins_status(&id, &params, now)),
            "owner/status" => self.owner_status(&params),
            "owner/app-status" => self.owner_app_status(&params),
            "owner/import"
            | "owner/remove"
            | "owner/pin"
            | "owner/app-import"
            | "owner/app-import-new"
            | "owner/app-remove" => {
                let _one_prompt_at_a_time = self.owner_lock.lock().unwrap();
                let result = match method {
                    "owner/import" => self.owner_import(&params),
                    "owner/remove" => self.owner_remove(&params),
                    "owner/app-import" => self.owner_app_import(&params, false),
                    "owner/app-import-new" => self.owner_app_import(&params, true),
                    "owner/app-remove" => self.owner_app_remove(&params),
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
                // Stamped at the owner's answer, not the request: the prompt
                // can take up to 120 s, longer than the assertion lives.
                Ok(presence::sign(&seed, action, nonce, (self.now)()))
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

    /// The owner approves the whole set of statement keys; keyd records its
    /// digest under the next generation and signs that record.
    fn owner_pins_attest(&self, id: &Value, params: &Value, now: u64) -> Value {
        let nonce = params.get("nonce").and_then(Value::as_str);
        let Some(nonce) = nonce.filter(|v| presence::nonce_ok(v)) else {
            return failure(id, -32602, "the nonce is not 16 to 64 base64url characters");
        };
        let keys = match pins::parse(params.get("pins").unwrap_or(&Value::Null)) {
            Ok(keys) => keys,
            Err(message) => return failure(id, -32602, &message),
        };
        let digest = pins::digest(&keys);
        let _one_prompt_at_a_time = self.owner_lock.lock().unwrap();
        let outcome = self
            .store
            .owner_pins()
            .and_then(|last| {
                let generation = last.map_or(0, |record| record.generation);
                let next = generation
                    .checked_add(1)
                    .ok_or("the owner key generation is exhausted")?;
                Ok((self.store.presence_seed()?, next))
            })
            .map_err(Refusal::Declined)
            .and_then(|(seed, generation)| {
                self.consent.ask(&pins::reason(&keys))?;
                let record = OwnerPins {
                    digest: digest.clone(),
                    generation,
                };
                self.store
                    .put_owner_pins(&record)
                    .map_err(Refusal::Declined)?;
                Ok((
                    pins::sign(&seed, Some(&digest), generation, nonce, (self.now)()),
                    generation,
                ))
            });
        let detail = match &outcome {
            Ok((_, generation)) => format!("pins {digest} generation {generation}"),
            Err(Refusal::Unavailable(message) | Refusal::Declined(message)) => {
                format!("pins {digest}: {message}")
            }
        };
        let decision = match &outcome {
            Ok(_) => "granted",
            Err(Refusal::Unavailable(_)) => "unavailable",
            Err(Refusal::Declined(_)) => "refused",
        };
        self.audit.record(
            Receipt {
                event: "keyd-owner",
                agent_id: None,
                app: None,
                operation: "owner/pins-attest",
                decision,
                detail: Some(&detail),
            },
            now,
        );
        match outcome {
            Ok((attestation, _)) => reply(id, json!({ "attestation": attestation })),
            Err(Refusal::Unavailable(message)) => failure(id, PRESENCE_UNAVAILABLE, &message),
            Err(Refusal::Declined(message)) => failure(id, -32000, &message),
        }
    }

    /// The key set the owner last approved, signed for agent-bot's nonce;
    /// no prompt. Before any approval the digest is null at generation 0.
    /// It takes no `owner_lock`: the record is one Keychain item, written
    /// whole, so a status read during an approval sees either generation.
    fn owner_pins_status(&self, id: &Value, params: &Value, now: u64) -> Value {
        let nonce = params.get("nonce").and_then(Value::as_str);
        let Some(nonce) = nonce.filter(|v| presence::nonce_ok(v)) else {
            return failure(id, -32602, "the nonce is not 16 to 64 base64url characters");
        };
        let signed = self.store.owner_pins().and_then(|record| {
            let seed = self.store.presence_seed()?;
            Ok(match record {
                Some(record) => {
                    pins::sign(&seed, Some(&record.digest), record.generation, nonce, now)
                }
                None => pins::sign(&seed, None, 0, nonce, now),
            })
        });
        match signed {
            Ok(attestation) => reply(id, json!({ "attestation": attestation })),
            Err(message) => failure(id, -32000, &message),
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

    fn app_of(params: &Value) -> Result<String, String> {
        params
            .get("app")
            .and_then(Value::as_str)
            .filter(|v| is_app_slug(v))
            .map(str::to_owned)
            .ok_or_else(|| "app is not a GitHub App slug".to_owned())
    }

    /// `items`, 1 to 64 of them, or the params as one item.
    fn import_entries(params: &Value) -> Result<Vec<Value>, String> {
        match params.get("items") {
            Some(Value::Array(items)) if !items.is_empty() && items.len() <= 64 => {
                Ok(items.clone())
            }
            Some(_) => Err("items must be a list of 1 to 64 keys".into()),
            None => Ok(vec![params.clone()]),
        }
    }

    /// An entry's key, refused before anyone is asked if keyd cannot sign
    /// with it.
    fn import_credential(&self, entry: &Value) -> Result<Credential, String> {
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
        github::app_jwt(&credential, (self.now)())?;
        Ok(credential)
    }

    /// The daemon key an import would pin: the offered one on the first
    /// import, none when it matches the pin, refused when it differs.
    fn import_pin(&self, params: &Value) -> Result<Option<[u8; 32]>, String> {
        let offered = Self::daemon_key(params)?;
        let pinned = self.store.pinned_key()?;
        match (pinned, offered) {
            (None, None) => {
                Err("no daemon key is pinned; pass daemonKey with the first import".into())
            }
            (None, Some(key)) => Ok(Some(key)),
            (Some(current), Some(key)) if current != key => {
                Err("a different daemon key is pinned; pin the new one with owner/pin first".into())
            }
            _ => Ok(None),
        }
    }

    fn named(names: Vec<String>) -> String {
        let mut named: Vec<String> = names.iter().take(4).cloned().collect();
        if names.len() > 4 {
            named.push(format!("{} more", names.len() - 4));
        }
        named.join(", ")
    }

    fn pin_clause(pin: &Option<[u8; 32]>) -> &'static str {
        if pin.is_some() {
            "; and trust this account's agent-bot daemon to request tokens"
        } else {
            ""
        }
    }

    /// Writes `credential` through `put`, then reads it back through `get`.
    fn store_verified(
        credential: &Credential,
        put: impl FnOnce() -> Result<(), String>,
        get: impl FnOnce() -> Result<Option<Credential>, String>,
    ) -> Result<(), String> {
        put()?;
        let back = get()?.ok_or("the keychain did not return what was written")?;
        if back.app_id != credential.app_id || back.private_key_pem != credential.private_key_pem {
            return Err("the keychain did not return what was written".into());
        }
        Ok(())
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
        let entries = Self::import_entries(params)?;
        let mut keys = Vec::with_capacity(entries.len());
        for entry in &entries {
            let (agent, app) = Self::soul_and_app(entry)?;
            let credential = self.import_credential(entry)?;
            keys.push((agent, app, credential));
        }
        let pin = self.import_pin(params)?;
        self.consent.ask(&format!(
            "keep GitHub App keys in agent-bot-keyd: {}{}",
            Self::named(
                keys.iter()
                    .map(|(agent, app, _)| format!("{app} (soul {agent})"))
                    .collect()
            ),
            Self::pin_clause(&pin)
        ))?;
        if let Some(key) = pin {
            self.store.pin_key(&key)?;
        }
        for (agent, app, credential) in &keys {
            Self::store_verified(
                credential,
                || self.store.put_credential(agent, app, credential),
                || self.store.credential(agent, app),
            )?;
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

    /// App-level keys (#110): one key per App slug, for every soul that acts
    /// as it. Same limits, checks, pin and single consent as `owner/import`.
    fn owner_app_import(&self, params: &Value, create_only: bool) -> Result<Value, String> {
        let entries = Self::import_entries(params)?;
        let mut keys: Vec<(String, Credential)> = Vec::with_capacity(entries.len());
        for entry in &entries {
            let app = Self::app_of(entry)?;
            if keys.iter().any(|(seen, _)| *seen == app) {
                return Err("an App appears more than once".into());
            }
            let credential = self.import_credential(entry)?;
            if create_only && self.store.app_credential(&app)?.is_some() {
                return Err("the App-level key already exists; it was not replaced".into());
            }
            keys.push((app, credential));
        }
        let pin = self.import_pin(params)?;
        self.consent.ask(&format!(
            "keep GitHub App keys in agent-bot-keyd for every soul acting as: {}{}",
            Self::named(keys.iter().map(|(app, _)| app.clone()).collect()),
            Self::pin_clause(&pin)
        ))?;
        if let Some(key) = pin {
            self.store.pin_key(&key)?;
        }
        for (app, credential) in &keys {
            Self::store_verified(
                credential,
                || {
                    if create_only {
                        self.store.insert_app_credential(app, credential)
                    } else {
                        self.store.put_app_credential(app, credential)
                    }
                },
                || self.store.app_credential(app),
            )?;
            self.audit.record(
                Receipt {
                    event: "keyd-owner",
                    agent_id: None,
                    app: Some(app),
                    operation: "owner/app-import item",
                    decision: "stored",
                    detail: None,
                },
                (self.now)(),
            );
        }
        Ok(json!({ "stored": keys.len(), "pinned": pin.is_some() }))
    }

    fn owner_app_remove(&self, params: &Value) -> Result<Value, String> {
        let app = Self::app_of(params)?;
        self.consent.ask(&format!(
            "delete the App-level {app} GitHub App key from agent-bot-keyd"
        ))?;
        Ok(json!({ "removed": self.store.remove_app_credential(&app)? }))
    }

    fn owner_app_status(&self, params: &Value) -> Result<Value, String> {
        let pinned = self.store.pinned_key()?.is_some();
        let app = Self::app_of(params)?;
        let held = self.store.app_credential(&app)?.is_some();
        Ok(json!({ "pinned": pinned, "held": held, "version": env!("CARGO_PKG_VERSION") }))
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

    fn owner(keyd: &Keyd, method: &str, params: Value) -> Value {
        keyd.handle_owner(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .unwrap()
    }

    fn app_grant(tool: &str, nonce: &str) -> String {
        let mut p = payload(tool, NOW);
        p["keyScope"] = json!("app");
        p["nonce"] = json!(nonce);
        sign(&signing_key(), &p)
    }

    #[test]
    fn imports_an_app_level_key_and_mints_with_it_only_for_an_app_grant() {
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        let (pem, _) = test_key_pem();
        let imported = owner(
            &keyd,
            "owner/app-import",
            json!({ "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": daemon_key() }),
        );
        assert_eq!(imported["result"], json!({ "stored": 1, "pinned": true }));
        assert_eq!(
            consent.asked.lock().unwrap().clone(),
            vec!["keep GitHub App keys in agent-bot-keyd for every soul acting as: qwts-claude-agent; and trust this account's agent-bot daemon to request tokens".to_owned()]
        );
        assert!(
            keyd.store
                .credential(AGENT, "qwts-claude-agent")
                .unwrap()
                .is_none(),
            "an App-level import writes no soul's item"
        );

        // A grant without keyScope still reads only the soul's item.
        let soul = call(
            &keyd,
            "credential",
            json!({}),
            Some(sign(&signing_key(), &payload("credential", NOW))),
        );
        assert_eq!(
            soul["content"][0]["text"],
            "agent-bot-keyd holds no key for qwts-claude-agent in this soul"
        );

        let minted = call(
            &keyd,
            "credential",
            json!({}),
            Some(app_grant("credential", "app-credential-0123456789")),
        );
        assert_eq!(minted["isError"], false);
        assert_eq!(minted["structuredContent"]["token"], "ghs_test");
        assert_eq!(minted["structuredContent"]["app"], "qwts-claude-agent");
        assert!(!minted.to_string().contains("PRIVATE KEY"));
        let git = call(
            &keyd,
            "git_credential",
            json!({ "protocol": "https", "host": "github.com" }),
            Some(app_grant("git_credential", "app-git-credential-0123456789")),
        );
        assert_eq!(
            git["content"][0]["text"],
            "username=x-access-token\npassword=ghs_test\n"
        );
    }

    #[test]
    fn an_app_grant_never_falls_back_to_a_soul_key() {
        let keyd = keyd(true);
        let (pem, _) = test_key_pem();
        import(&keyd, &pem);
        let result = call(
            &keyd,
            "credential",
            json!({}),
            Some(app_grant("credential", "app-no-fallback-0123456789")),
        );
        assert_eq!(
            result["content"][0]["text"],
            "agent-bot-keyd holds no App-level key for qwts-claude-agent"
        );
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn the_first_app_import_pins_the_daemon_key_under_its_one_consent() {
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        let (pem, _) = test_key_pem();
        let before = owner(
            &keyd,
            "owner/app-status",
            json!({ "app": "qwts-claude-agent" }),
        );
        assert_eq!(
            (
                before["result"]["pinned"].as_bool(),
                before["result"]["held"].as_bool()
            ),
            (Some(false), Some(false))
        );
        let first = owner(
            &keyd,
            "owner/app-import",
            json!({ "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": daemon_key() }),
        );
        assert_eq!(first["result"], json!({ "stored": 1, "pinned": true }));
        let asked = consent.asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("trust this account's agent-bot daemon"));
        assert_eq!(
            keyd.store.pinned_key().unwrap().map(|k| STANDARD.encode(k)),
            Some(daemon_key())
        );
        let after = owner(
            &keyd,
            "owner/app-status",
            json!({ "app": "qwts-claude-agent" }),
        );
        assert_eq!(
            (
                after["result"]["pinned"].as_bool(),
                after["result"]["held"].as_bool()
            ),
            (Some(true), Some(true))
        );
    }

    #[test]
    fn app_level_owner_operations_need_consent_and_a_matching_pin() {
        let (pem, _) = test_key_pem();
        let refusing = keyd(false);
        let refused = owner(
            &refusing,
            "owner/app-import",
            json!({ "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": daemon_key() }),
        );
        assert_eq!(refused["error"]["code"], -32000);
        assert!(refusing.store.pinned_key().unwrap().is_none());
        assert!(refusing
            .store
            .app_credential("qwts-claude-agent")
            .unwrap()
            .is_none());

        let keyd = keyd(true);
        let first = owner(
            &keyd,
            "owner/app-import",
            json!({ "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem }),
        );
        assert_eq!(
            first["error"]["message"],
            "no daemon key is pinned; pass daemonKey with the first import"
        );
        import(&keyd, &pem);
        let other = STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[2; 32])
                .verifying_key()
                .to_bytes(),
        );
        let mismatch = owner(
            &keyd,
            "owner/app-import",
            json!({ "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": other }),
        );
        assert!(mismatch["error"]["message"]
            .as_str()
            .unwrap()
            .contains("different daemon key"));
        for params in [
            json!({ "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": "nope" }),
            json!({ "app": "../x", "appId": "42", "privateKeyPem": pem }),
            json!({ "app": "qwts-claude-agent", "appId": "x", "privateKeyPem": pem }),
            json!({ "items": [] }),
            json!({ "items": [
                { "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem },
                { "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem },
            ] }),
        ] {
            assert_eq!(
                owner(&keyd, "owner/app-import", params)["error"]["code"],
                -32000
            );
        }
        // The soul's pin carries over: no daemonKey needed after the first.
        let several = owner(
            &keyd,
            "owner/app-import",
            json!({ "items": [
                { "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem },
                { "app": "qwts-grok-agent", "appId": "43", "privateKeyPem": pem },
            ] }),
        );
        assert_eq!(several["result"], json!({ "stored": 2, "pinned": false }));

        let status = owner(
            &keyd,
            "owner/app-status",
            json!({ "app": "qwts-grok-agent" }),
        );
        assert_eq!(
            (
                status["result"]["pinned"].as_bool(),
                status["result"]["held"].as_bool()
            ),
            (Some(true), Some(true))
        );
        assert!(!status.to_string().contains("PRIVATE"));
        assert_eq!(
            owner(&keyd, "owner/app-status", json!({}))["error"]["message"],
            "app is not a GitHub App slug"
        );
        // The soul's own item and status are untouched by App-level keys.
        let soul_status = owner(
            &keyd,
            "owner/status",
            json!({ "agentId": AGENT, "app": "qwts-claude-agent" }),
        );
        assert_eq!(soul_status["result"]["held"], true);

        assert_eq!(
            owner(
                &refusing,
                "owner/app-remove",
                json!({ "app": "qwts-grok-agent" })
            )["error"]["code"],
            -32000
        );
        let removed = owner(
            &keyd,
            "owner/app-remove",
            json!({ "app": "qwts-grok-agent" }),
        );
        assert_eq!(removed["result"]["removed"], true);
        assert!(keyd
            .store
            .app_credential("qwts-grok-agent")
            .unwrap()
            .is_none());
        assert!(keyd
            .store
            .app_credential("qwts-claude-agent")
            .unwrap()
            .is_some());
        assert!(keyd
            .store
            .credential(AGENT, "qwts-claude-agent")
            .unwrap()
            .is_some());
        // App-level owner methods are for the owner channel only.
        let soul = keyd
            .handle_soul(&json!({ "jsonrpc": "2.0", "id": 1, "method": "owner/app-status", "params": { "app": "qwts-claude-agent" } }))
            .unwrap();
        assert_eq!(soul["error"]["code"], -32601);
    }

    #[test]
    fn create_only_app_import_refuses_an_item_added_during_consent() {
        use crate::store::{encode, Items, APP_SERVICE};
        struct AddDuringConsent(Memory);
        impl Consent for AddDuringConsent {
            fn ask(&self, _reason: &str) -> Result<(), Refusal> {
                self.0
                    .write(
                        APP_SERVICE,
                        "github-app/test-app",
                        encode(&Credential {
                            app_id: "99".into(),
                            private_key_pem: "late-key".into(),
                        })
                        .as_bytes(),
                    )
                    .unwrap();
                Ok(())
            }
        }
        let items = Memory::default();
        let mut keyd = keyd(true);
        keyd.store = Store::new(Box::new(items.clone()));
        keyd.consent = Box::new(AddDuringConsent(items));
        let (pem, _) = test_key_pem();
        let result = owner(
            &keyd,
            "owner/app-import-new",
            json!({
                "app": "test-app", "appId": "42", "privateKeyPem": pem, "daemonKey": daemon_key()
            }),
        );
        assert_eq!(
            result["error"]["message"],
            "the App-level key already exists; it was not replaced"
        );
        let kept = keyd.store.app_credential("test-app").unwrap().unwrap();
        assert_eq!(
            (kept.app_id.as_str(), kept.private_key_pem.as_str()),
            ("99", "late-key")
        );
    }

    #[test]
    fn create_only_app_import_adds_once_and_never_rotates() {
        let keyd = keyd(true);
        let (pem, _) = test_key_pem();
        let params = json!({ "app": "test-app", "appId": "42", "privateKeyPem": pem, "daemonKey": daemon_key() });
        assert_eq!(
            owner(&keyd, "owner/app-import-new", params.clone())["result"],
            json!({ "stored": 1, "pinned": true })
        );
        assert_eq!(
            owner(&keyd, "owner/app-import-new", params)["error"]["message"],
            "the App-level key already exists; it was not replaced"
        );
        assert_eq!(
            keyd.store
                .app_credential("test-app")
                .unwrap()
                .unwrap()
                .private_key_pem,
            pem
        );
    }

    fn other_daemon_key() -> String {
        STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[2; 32])
                .verifying_key()
                .to_bytes(),
        )
    }

    /// keyd-protocol.md: keyd pins `daemonKey` on the first import of either
    /// kind, asks for it in that one consent, and from then on takes a new
    /// key only through `owner/pin`.
    #[test]
    fn pins_the_daemon_key_exactly_once() {
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        let (pem, _) = test_key_pem();
        let pinned = signing_key().verifying_key().to_bytes();
        let item = |key: Option<String>| {
            let mut params = json!({ "agentId": AGENT, "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem });
            if let Some(key) = key {
                params["daemonKey"] = json!(key);
            }
            params
        };
        let trust = "trust this account's agent-bot daemon";

        let first = owner(&keyd, "owner/import", item(Some(daemon_key())));
        assert_eq!(first["result"], json!({ "stored": 1, "pinned": true }));
        assert_eq!(keyd.store.pinned_key().unwrap(), Some(pinned));
        assert!(consent.asked.lock().unwrap()[0].contains(trust));

        // The same key again, or none, pins nothing and never asks to.
        for (kind, params) in [
            ("owner/import", item(Some(daemon_key()))),
            ("owner/import", item(None)),
            (
                "owner/app-import",
                json!({ "app": "qwts-grok-agent", "appId": "43", "privateKeyPem": pem, "daemonKey": daemon_key() }),
            ),
        ] {
            assert_eq!(
                owner(&keyd, kind, params)["result"]["pinned"],
                false,
                "{kind}"
            );
            assert!(!consent
                .asked
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .contains(trust));
        }
        assert_eq!(
            owner(&keyd, "owner/pin", json!({ "daemonKey": daemon_key() }))["result"],
            json!({ "pinned": false })
        );
        assert_eq!(
            consent.asked.lock().unwrap().len(),
            4,
            "no prompt to re-pin"
        );

        // A different key is refused on either import, before anyone is asked.
        for kind in ["owner/import", "owner/app-import"] {
            let refused = owner(
                &keyd,
                kind,
                json!({ "agentId": AGENT, "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem, "daemonKey": other_daemon_key() }),
            );
            assert_eq!(refused["error"]["code"], -32000, "{kind}");
        }
        assert_eq!(consent.asked.lock().unwrap().len(), 4);
        assert_eq!(keyd.store.pinned_key().unwrap(), Some(pinned));

        // Only owner/pin replaces it, with the owner's consent.
        assert_eq!(
            owner(
                &keyd,
                "owner/pin",
                json!({ "daemonKey": other_daemon_key() })
            )["result"],
            json!({ "pinned": true })
        );
        assert_ne!(keyd.store.pinned_key().unwrap(), Some(pinned));
        assert_eq!(consent.asked.lock().unwrap().len(), 5);
        let declined = self::keyd(false);
        import(&declined, &pem);
        assert_eq!(
            owner(
                &declined,
                "owner/pin",
                json!({ "daemonKey": other_daemon_key() })
            )["error"]["code"],
            -32000
        );
        assert_eq!(declined.store.pinned_key().unwrap(), None);
    }

    /// keyd-protocol.md: `items` holds 1 to 64 keys, otherwise the whole
    /// import is refused before the owner is asked, for either kind.
    #[test]
    fn imports_one_to_sixty_four_items_and_refuses_zero_or_sixty_five() {
        let (pem, _) = test_key_pem();
        let soul = |n: usize| json!({ "agentId": format!("agent_ea588a53-c6ce-430b-9d71-{n:012x}"), "app": "qwts-claude-agent", "appId": "42", "privateKeyPem": pem });
        let app =
            |n: usize| json!({ "app": format!("app-{n}"), "appId": "42", "privateKeyPem": pem });
        for (kind, item) in [
            ("owner/import", &soul as &dyn Fn(usize) -> Value),
            ("owner/app-import", &app),
        ] {
            for (count, stored) in [(0, None), (1, Some(1)), (64, Some(64)), (65, None)] {
                let consent = Arc::new(Consenting::new(true));
                let mut keyd = keyd(true);
                keyd.consent = Box::new(Arc::clone(&consent));
                let items: Vec<Value> = (0..count).map(item).collect();
                let answer = owner(
                    &keyd,
                    kind,
                    json!({ "daemonKey": daemon_key(), "items": items }),
                );
                match stored {
                    Some(n) => {
                        assert_eq!(answer["result"]["stored"], n, "{kind} {count}");
                        assert_eq!(consent.asked.lock().unwrap().len(), 1);
                    }
                    None => {
                        assert_eq!(
                            answer["error"]["message"], "items must be a list of 1 to 64 keys",
                            "{kind} {count}"
                        );
                        assert!(consent.asked.lock().unwrap().is_empty());
                        assert!(keyd.store.pinned_key().unwrap().is_none());
                    }
                }
            }
            for items in [json!("x"), json!({}), Value::Null] {
                let answer = owner(
                    &keyd(true),
                    kind,
                    json!({ "daemonKey": daemon_key(), "items": items }),
                );
                assert_eq!(answer["error"]["code"], -32000, "{kind} {items}");
            }
        }
    }

    /// The test clock for `presence_is_stamped_when_the_owner_answers`: the
    /// owner takes 100 s to answer.
    static PROMPT_CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(NOW);

    struct SlowOwner;

    impl Consent for SlowOwner {
        fn ask(&self, _reason: &str) -> Result<(), Refusal> {
            PROMPT_CLOCK.fetch_add(100, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    /// keyd waits up to 120 s for the owner. An assertion stamped when the
    /// request arrived would be past agent-bot's `now ≤ exp + 30` by the time
    /// a slow approval returned; its 60 s run from the approval.
    #[test]
    fn presence_is_stamped_when_the_owner_answers() {
        let mut keyd = keyd(true);
        keyd.consent = Box::new(SlowOwner);
        keyd.now = || PROMPT_CLOCK.load(std::sync::atomic::Ordering::SeqCst);
        let answer = presence(
            &keyd,
            json!({ "action": "turn agent comms off for Bill", "nonce": "abcdefghijklmnopqrstuvwx" }),
        );
        let seed = keyd.store.presence_seed().unwrap();
        let payload =
            crate::presence::tests::open(answer["result"]["assertion"].as_str().unwrap(), &seed);
        assert_eq!(
            (payload["iat"].as_u64(), payload["exp"].as_u64()),
            (Some(NOW + 100), Some(NOW + 160))
        );
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

    fn owner_pins(keyd: &Keyd, method: &str, params: Value) -> Value {
        keyd.handle_owner(
            &json!({ "jsonrpc": "2.0", "id": 10, "method": method, "params": params }),
        )
        .unwrap()
    }

    fn pins_payload(keyd: &Keyd, answer: &Value) -> Value {
        let seed = keyd.store.presence_seed().unwrap();
        crate::pins::tests::open(answer["result"]["attestation"].as_str().unwrap(), &seed)
    }

    #[test]
    fn records_the_owner_keys_only_when_the_owner_approves() {
        use crate::pins::tests::{pin, FP_A, FP_B};
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        let nonce = "abcdefghijklmnopqrstuvwx";

        let before = owner_pins(&keyd, "owner/pins-status", json!({ "nonce": nonce }));
        let payload = pins_payload(&keyd, &before);
        assert!(payload["digest"].is_null());
        assert_eq!(
            (payload["generation"].as_u64(), payload["nonce"].as_str()),
            (Some(0), Some(nonce))
        );

        let one = json!([pin("yubikey", FP_A)]);
        let attested = owner_pins(
            &keyd,
            "owner/pins-attest",
            json!({ "pins": one, "nonce": nonce }),
        );
        let payload = pins_payload(&keyd, &attested);
        let digest = crate::pins::digest(&crate::pins::parse(&one).unwrap());
        assert_eq!(payload["digest"], digest);
        assert_eq!(payload["generation"], 1);
        assert_eq!(payload["kind"], "pins");
        assert_eq!(
            consent.asked.lock().unwrap().clone(),
            vec![format!("agent-bot wants to trust only these keys to sign statements as you: yubikey (ssh security key, {FP_A})")]
        );

        let status = owner_pins(
            &keyd,
            "owner/pins-status",
            json!({ "nonce": "zyxwvutsrqponmlkjihgfedc" }),
        );
        let payload = pins_payload(&keyd, &status);
        assert_eq!(
            (payload["digest"].as_str(), payload["generation"].as_u64()),
            (Some(digest.as_str()), Some(1))
        );
        assert_eq!(payload["nonce"], "zyxwvutsrqponmlkjihgfedc");

        // Every approval is a new generation, removing every key included.
        let two = json!([pin("yubikey", FP_A), pin("spare", FP_B)]);
        let again = owner_pins(
            &keyd,
            "owner/pins-attest",
            json!({ "pins": two, "nonce": nonce }),
        );
        assert_eq!(pins_payload(&keyd, &again)["generation"], 2);
        let none = owner_pins(
            &keyd,
            "owner/pins-attest",
            json!({ "pins": [], "nonce": nonce }),
        );
        let payload = pins_payload(&keyd, &none);
        assert_eq!(payload["generation"], 3);
        assert_eq!(payload["digest"], crate::pins::digest(&[]));

        // A declined or unanswered prompt changes nothing.
        keyd.consent = Box::new(Consenting::new(false));
        let declined = owner_pins(
            &keyd,
            "owner/pins-attest",
            json!({ "pins": one, "nonce": nonce }),
        );
        assert_eq!(declined["error"]["code"], -32000);
        keyd.consent = Box::new(Consenting::unavailable());
        let unavailable = owner_pins(
            &keyd,
            "owner/pins-attest",
            json!({ "pins": one, "nonce": nonce }),
        );
        assert_eq!(unavailable["error"]["code"], PRESENCE_UNAVAILABLE);
        let status = owner_pins(&keyd, "owner/pins-status", json!({ "nonce": nonce }));
        assert_eq!(pins_payload(&keyd, &status)["generation"], 3);
        assert_eq!(
            pins_payload(&keyd, &status)["digest"],
            crate::pins::digest(&[])
        );
    }

    #[test]
    fn refuses_malformed_owner_key_requests_without_asking() {
        use crate::pins::tests::{pin, FP_A};
        let consent = Arc::new(Consenting::new(true));
        let mut keyd = keyd(true);
        keyd.consent = Box::new(Arc::clone(&consent));
        let nonce = "abcdefghijklmnopqrstuvwx";
        for params in [
            json!({ "pins": [pin("yubikey", FP_A)] }),
            json!({ "pins": [pin("yubikey", FP_A)], "nonce": "short" }),
            json!({ "nonce": nonce }),
            json!({ "pins": [pin("Bad Name", FP_A)], "nonce": nonce }),
        ] {
            assert_eq!(
                owner_pins(&keyd, "owner/pins-attest", params)["error"]["code"],
                -32602
            );
        }
        assert_eq!(
            owner_pins(&keyd, "owner/pins-status", json!({}))["error"]["code"],
            -32602
        );
        assert!(consent.asked.lock().unwrap().is_empty());

        // A record keyd cannot read is refused, not taken as no keys.
        keyd.store
            .put_owner_pins(&OwnerPins {
                digest: "nope".into(),
                generation: 4,
            })
            .unwrap();
        assert_eq!(
            owner_pins(&keyd, "owner/pins-status", json!({ "nonce": nonce }))["error"]["code"],
            -32000
        );
        assert_eq!(
            owner_pins(
                &keyd,
                "owner/pins-attest",
                json!({ "pins": [], "nonce": nonce })
            )["error"]["code"],
            -32000
        );
        assert!(consent.asked.lock().unwrap().is_empty());

        // The owner's keys are for the owner channel only.
        for method in ["owner/pins-attest", "owner/pins-status"] {
            let soul = keyd
                .handle_soul(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": { "pins": [], "nonce": nonce } }))
                .unwrap();
            assert!(soul.get("result").is_none(), "{method}");
        }
    }
}
