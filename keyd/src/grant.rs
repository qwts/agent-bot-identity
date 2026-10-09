//! Daemon-signed grants. agent-bot's daemon decides who may mint (binding,
//! add-on gate, the soul's App, audit) and says so in a grant it signs with
//! its account Ed25519 key, the same key that vouches souls to agent-comms:
//!
//!   v1.<base64url(JSON payload)>.<base64url(Ed25519 signature of the payload segment)>
//!
//! keyd holds no policy of its own. It checks that a grant is signed by the
//! key the owner pinned, is meant for keyd and for this tool, is fresh, and
//! has not been used, then does exactly what the grant says.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::collections::HashMap;

use crate::ids::{is_agent_id, is_app_slug};

pub const AUDIENCE: &str = "agent-bot-keyd";
pub const TOOLS: [&str; 2] = ["credential", "git_credential"];
/// A grant is for one call: the daemon signs it moments before the call.
const MAX_LIFETIME_SECONDS: u64 = 120;
const CLOCK_SKEW_SECONDS: u64 = 30;
const MAX_GRANT_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub v: u32,
    pub aud: String,
    pub agent_id: String,
    pub app: String,
    pub tool: String,
    pub iat: u64,
    pub exp: u64,
    pub nonce: String,
    /// GitHub's REST base, e.g. https://api.github.com.
    pub api_base: String,
    /// The installation to mint against, when the daemon's config names one.
    #[serde(default)]
    pub installation_id: Option<u64>,
    /// Otherwise the account the App is installed on, when it has several.
    #[serde(default)]
    pub owner: Option<String>,
    /// git_credential only: the GitHub host git may send this token to.
    #[serde(default)]
    pub host: Option<String>,
}

/// Nonces already spent, kept until their grant would have expired anyway.
#[derive(Default)]
pub struct Replay {
    seen: HashMap<String, u64>,
}

impl Replay {
    fn spend(&mut self, nonce: &str, exp: u64, now: u64) -> bool {
        self.seen.retain(|_, until| *until > now);
        if self.seen.contains_key(nonce) {
            return false;
        }
        self.seen.insert(nonce.to_owned(), exp);
        true
    }
}

fn nonce_ok(nonce: &str) -> bool {
    (16..=64).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Verifies `token` for `tool` and spends its nonce. Errors are stable,
/// non-reflecting strings: a grant's contents never come back in a message.
pub fn verify(
    token: &str,
    tool: &str,
    key: &VerifyingKey,
    now: u64,
    replay: &mut Replay,
) -> Result<Grant, &'static str> {
    if token.len() > MAX_GRANT_BYTES {
        return Err("grant is too large");
    }
    let mut parts = token.split('.');
    let (Some("v1"), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("grant is malformed");
    };
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or("grant is malformed")?;
    key.verify(payload.as_bytes(), &signature)
        .map_err(|_| "grant signature is not the daemon's")?;
    let grant: Grant = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("grant is malformed")?;
    if grant.v != 1 || grant.aud != AUDIENCE {
        return Err("grant is not for agent-bot-keyd");
    }
    if grant.tool != tool || !TOOLS.contains(&grant.tool.as_str()) {
        return Err("grant is for another tool");
    }
    if !is_agent_id(&grant.agent_id) || !is_app_slug(&grant.app) {
        return Err("grant names an invalid soul or App");
    }
    if grant.exp <= now
        || grant.iat > now + CLOCK_SKEW_SECONDS
        || grant.exp < grant.iat
        || grant.exp - grant.iat > MAX_LIFETIME_SECONDS
    {
        return Err("grant has expired");
    }
    if !grant.api_base.starts_with("https://") || grant.api_base.len() > 200 {
        return Err("grant names an invalid GitHub API");
    }
    if grant.tool == "git_credential" && grant.host.as_deref().is_none_or(str::is_empty) {
        return Err("grant names no GitHub host");
    }
    if !nonce_ok(&grant.nonce) || !replay.spend(&grant.nonce, grant.exp, now) {
        return Err("grant was already used");
    }
    Ok(grant)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{json, Value};

    pub const AGENT: &str = "agent_ea588a53-c6ce-430b-9d71-89897d843ab6";

    pub fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub fn payload(tool: &str, now: u64) -> Value {
        json!({
            "v": 1, "aud": AUDIENCE, "agentId": AGENT, "app": "qwts-claude-agent", "tool": tool,
            "iat": now, "exp": now + 60, "nonce": format!("nonce-{now}-{tool}-0123456789"),
            "apiBase": "https://api.github.com", "host": "github.com",
        })
    }

    pub fn sign(key: &SigningKey, payload: &Value) -> String {
        let segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).unwrap());
        let signature = key.sign(segment.as_bytes());
        format!(
            "v1.{segment}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    /// A grant agent-bot's keyd-client.mjs signed (seed [7; 32], iat
    /// 1800000000): the two sides agree on the format byte for byte.
    #[test]
    fn accepts_a_grant_the_daemon_signed() {
        let token = include_str!("../tests/fixtures/grant.txt").trim();
        let mut replay = Replay::default();
        let grant = verify(
            token,
            "git_credential",
            &signing_key().verifying_key(),
            1_800_000_010,
            &mut replay,
        )
        .unwrap();
        assert_eq!(grant.agent_id, AGENT);
        assert_eq!(grant.installation_id, Some(42));
        assert_eq!(grant.owner.as_deref(), Some("qwts"));
        assert_eq!(grant.host.as_deref(), Some("github.com"));
    }

    #[test]
    fn accepts_a_fresh_grant_once() {
        let key = signing_key();
        let token = sign(&key, &payload("credential", 1000));
        let mut replay = Replay::default();
        let grant = verify(
            &token,
            "credential",
            &key.verifying_key(),
            1001,
            &mut replay,
        )
        .unwrap();
        assert_eq!(grant.agent_id, AGENT);
        assert_eq!(
            verify(
                &token,
                "credential",
                &key.verifying_key(),
                1002,
                &mut replay
            ),
            Err("grant was already used")
        );
    }

    #[test]
    fn refuses_another_signer_tool_audience_or_age() {
        let key = signing_key();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let mut replay = Replay::default();
        let pinned = key.verifying_key();
        let forged = sign(&other, &payload("credential", 1000));
        assert_eq!(
            verify(&forged, "credential", &pinned, 1000, &mut replay),
            Err("grant signature is not the daemon's")
        );
        let token = sign(&key, &payload("credential", 1000));
        assert_eq!(
            verify(&token, "git_credential", &pinned, 1000, &mut replay),
            Err("grant is for another tool")
        );
        assert_eq!(
            verify(&token, "credential", &pinned, 1060, &mut replay),
            Err("grant has expired")
        );
        let mut wrong = payload("credential", 1000);
        wrong["aud"] = json!("agent-comms");
        assert_eq!(
            verify(
                &sign(&key, &wrong),
                "credential",
                &pinned,
                1000,
                &mut replay
            ),
            Err("grant is not for agent-bot-keyd")
        );
        let mut long = payload("credential", 1000);
        long["exp"] = json!(1000 + 3600);
        assert_eq!(
            verify(&sign(&key, &long), "credential", &pinned, 1000, &mut replay),
            Err("grant has expired")
        );
        let mut plain = payload("credential", 1000);
        plain["apiBase"] = json!("http://evil.example");
        assert_eq!(
            verify(
                &sign(&key, &plain),
                "credential",
                &pinned,
                1000,
                &mut replay
            ),
            Err("grant names an invalid GitHub API")
        );
        let mut extra = payload("credential", 1000);
        extra["privateKeyPem"] = json!("x");
        assert_eq!(
            verify(
                &sign(&key, &extra),
                "credential",
                &pinned,
                1000,
                &mut replay
            ),
            Err("grant is malformed")
        );
    }

    #[test]
    fn refuses_a_tampered_payload() {
        let key = signing_key();
        let token = sign(&key, &payload("credential", 1000));
        let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
        let mut changed = payload("credential", 1000);
        changed["app"] = json!("someone-else");
        parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&changed).unwrap());
        assert_eq!(
            verify(
                &parts.join("."),
                "credential",
                &key.verifying_key(),
                1000,
                &mut Replay::default()
            ),
            Err("grant signature is not the daemon's")
        );
    }
}
