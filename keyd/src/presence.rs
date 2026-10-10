//! The owner's presence, signed for agent-bot (agent-bot-identity #416).
//!
//! agent-bot's owner gate asks keyd's owner socket for `owner/presence` with
//! the action it is about to take and a fresh nonce. keyd asks the person at
//! the Mac (Touch ID, or the login password) with its own wording of that
//! action and, only on approval, signs:
//!
//!   p1.<base64url(JSON payload)>.<base64url(Ed25519 signature of the payload segment)>
//!   payload: { v: 1, aud: "agent-bot-owner", kind: "presence",
//!              action: hex(sha256(action)), nonce, iat, exp }
//!
//! with its presence key, whose seed only keyd's code can read from the
//! Keychain. agent-bot pins the public half from the code-signed binary
//! (`agent-bot-keyd presence-key`), not from the socket, so a process that
//! stands up a socket of its own cannot answer for the owner. The nonce is
//! agent-bot's, so an assertion is good for the one action it was asked for.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const AUDIENCE: &str = "agent-bot-owner";
const LIFETIME_SECONDS: u64 = 60;
const MAX_ACTION_CHARS: usize = 400;

/// The action as the owner reads it: one line of printable text.
pub fn action_ok(action: &str) -> bool {
    let count = action.chars().count();
    (1..=MAX_ACTION_CHARS).contains(&count) && !action.chars().any(char::is_control)
}

pub fn nonce_ok(nonce: &str) -> bool {
    (16..=64).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn digest(action: &str) -> String {
    Sha256::digest(action.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The words keyd puts in the prompt. The action comes from agent-bot, which
/// names the soul and what changes; keyd adds who is asking.
pub fn reason(action: &str) -> String {
    format!("agent-bot wants to {action}")
}

pub fn sign(seed: &[u8; 32], action: &str, nonce: &str, now: u64) -> String {
    let payload = json!({
        "v": 1,
        "aud": AUDIENCE,
        "kind": "presence",
        "action": digest(action),
        "nonce": nonce,
        "iat": now,
        "exp": now + LIFETIME_SECONDS,
    });
    let segment = URL_SAFE_NO_PAD.encode(payload.to_string());
    let signature = SigningKey::from_bytes(seed).sign(segment.as_bytes());
    format!(
        "p1.{segment}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

/// The public half agent-bot pins, as raw Ed25519 bytes in base64.
pub fn public_key(seed: &[u8; 32]) -> String {
    use base64::engine::general_purpose::STANDARD;
    STANDARD.encode(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};
    use serde_json::Value;

    pub fn open(token: &str, seed: &[u8; 32]) -> Value {
        let mut parts = token.split('.');
        assert_eq!(parts.next(), Some("p1"));
        let segment = parts.next().unwrap();
        let signature = URL_SAFE_NO_PAD.decode(parts.next().unwrap()).unwrap();
        SigningKey::from_bytes(seed)
            .verifying_key()
            .verify(
                segment.as_bytes(),
                &Signature::from_slice(&signature).unwrap(),
            )
            .unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
    }

    #[test]
    fn signs_the_action_digest_and_the_callers_nonce() {
        let seed = [9u8; 32];
        let nonce = "n0nce-n0nce-n0nce-0";
        let payload = open(
            &sign(&seed, "turn agent comms off for Bill", nonce, 100),
            &seed,
        );
        assert_eq!(payload["aud"], AUDIENCE);
        assert_eq!(payload["kind"], "presence");
        assert_eq!(payload["nonce"], nonce);
        assert_eq!(payload["action"], digest("turn agent comms off for Bill"));
        assert_eq!(
            (payload["iat"].as_u64(), payload["exp"].as_u64()),
            (Some(100), Some(160))
        );
        // A known vector, so agent-bot's verifier and keyd agree on the digest.
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// keyd-protocol.md: keyd issues for 60 s, and agent-bot's verifier
    /// takes `0 < exp − iat ≤ 120`, `iat ≤ now + 30` and `now ≤ exp + 30`.
    /// So an assertion keyd signs at `t` is good from `t − 30` to `t + 90`
    /// on agent-bot's clock, and no longer.
    #[test]
    fn issues_for_sixty_seconds_within_the_documented_skew() {
        const SKEW: u64 = 30;
        const MAX_LIFETIME: u64 = 120;
        let accepted = |payload: &Value, now: u64| {
            let (iat, exp) = (
                payload["iat"].as_u64().unwrap(),
                payload["exp"].as_u64().unwrap(),
            );
            exp > iat && exp - iat <= MAX_LIFETIME && iat <= now + SKEW && now <= exp + SKEW
        };
        let seed = [9u8; 32];
        let t = 1_800_000_000;
        let payload = open(&sign(&seed, "pin a key", "n0nce-n0nce-n0nce-0", t), &seed);
        assert_eq!(payload["exp"].as_u64(), Some(t + LIFETIME_SECONDS));
        assert_eq!(LIFETIME_SECONDS, 60);
        for (now, ok) in [
            (t - 31, false),
            (t - 30, true),
            (t, true),
            (t + 60, true),
            (t + 90, true),
            (t + 91, false),
        ] {
            assert_eq!(
                accepted(&payload, now),
                ok,
                "at t{:+}",
                now as i64 - t as i64
            );
        }
    }

    #[test]
    fn checks_actions_and_nonces() {
        assert!(action_ok("turn agent comms off for Bill (agent_1)"));
        assert!(!action_ok(""));
        assert!(!action_ok("two\nlines"));
        assert!(!action_ok(&"x".repeat(401)));
        assert!(nonce_ok("abcdefghijklmnop"));
        assert!(!nonce_ok("short"));
        assert!(!nonce_ok("abcdefghijklmnop!"));
    }
}
