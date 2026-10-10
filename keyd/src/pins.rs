//! The owner's statement keys, as keyd records them (agent-bot-identity #753).
//!
//! agent-bot pins the public keys the owner signs statements with in
//! `<state>/owner/keys.json`, a file anything running as the owner can
//! write. keyd keeps the trusted copy: `owner/pins-attest` shows the owner
//! the whole key set, asks for their consent, and on approval records the
//! set's digest and a generation one past the last in its own Keychain item.
//! `owner/pins-status` reports that record, signed, with no prompt. Both
//! answer
//!
//!   k1.<base64url(JSON payload)>.<base64url(Ed25519 signature of the payload segment)>
//!   payload: { v: 1, aud: "agent-bot-owner", kind: "pins",
//!              digest: hex(sha256(canonical key set)) or null,
//!              generation, nonce, iat, exp }
//!
//! with the presence key, under its own prefix and kind, so it is never a
//! presence assertion. The nonce is agent-bot's, so an answer is fresh: a
//! reader compares the digest with the file it read, and an older signed
//! answer, or a file restored from before a removal, does not match.
//!
//! The canonical key set is one line per key, in the order given:
//!
//!   agent-bot owner pins v1\n
//!   <store> <alg> <fingerprint> <verifyRequired 0|1> <softwareKey 0|1> <name>\n
//!
//! The fingerprint (SHA256 of the key blob) stands for the public key;
//! agent-bot refuses a pin whose fingerprint does not match its key.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::presence::AUDIENCE;

pub const KIND: &str = "pins";
const LIFETIME_SECONDS: u64 = 60;
/// The most keys agent-bot pins (owner-statement.mjs MAX_OWNER_KEYS).
const MAX_PINS: usize = 4;

pub struct Pin {
    store: String,
    alg: String,
    fingerprint: String,
    verify_required: bool,
    software_key: bool,
    name: String,
}

fn name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn fingerprint_ok(fingerprint: &str) -> bool {
    fingerprint.strip_prefix("SHA256:").is_some_and(|rest| {
        rest.len() == 43
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    })
}

/// The key set from `pins`: 0 to 4 keys, each well formed, no name or
/// fingerprint twice.
pub fn parse(pins: &Value) -> Result<Vec<Pin>, String> {
    let list = pins
        .as_array()
        .filter(|list| list.len() <= MAX_PINS)
        .ok_or("pins must be a list of 0 to 4 keys")?;
    let mut parsed: Vec<Pin> = Vec::with_capacity(list.len());
    for entry in list {
        let text = |field: &str| entry.get(field).and_then(Value::as_str).map(str::to_owned);
        let flag = |field: &str| entry.get(field).and_then(Value::as_bool);
        let pin = Pin {
            store: text("store").ok_or("a pin has no store")?,
            alg: text("alg").ok_or("a pin has no alg")?,
            fingerprint: text("fingerprint")
                .filter(|v| fingerprint_ok(v))
                .ok_or("a pin's fingerprint is not a SHA256 fingerprint")?,
            verify_required: flag("verifyRequired").ok_or("a pin has no verifyRequired")?,
            software_key: flag("softwareKey").ok_or("a pin has no softwareKey")?,
            name: text("name")
                .filter(|v| name_ok(v))
                .ok_or("a pin's name is not 1 to 32 of a-z, 0-9 and -")?,
        };
        match (pin.store.as_str(), pin.alg.as_str()) {
            ("ssh", "sshsig") | ("keyd", "ed25519") => {}
            _ => return Err("a pin's store and alg are not ssh/sshsig or keyd/ed25519".into()),
        }
        if parsed
            .iter()
            .any(|seen| seen.name == pin.name || seen.fingerprint == pin.fingerprint)
        {
            return Err("two pins share a name or a key".into());
        }
        parsed.push(pin);
    }
    Ok(parsed)
}

pub fn canonical(pins: &[Pin]) -> String {
    let mut text = String::from("agent-bot owner pins v1\n");
    for pin in pins {
        text.push_str(&format!(
            "{} {} {} {} {} {}\n",
            pin.store,
            pin.alg,
            pin.fingerprint,
            u8::from(pin.verify_required),
            u8::from(pin.software_key),
            pin.name
        ));
    }
    text
}

pub fn digest(pins: &[Pin]) -> String {
    Sha256::digest(canonical(pins).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The words keyd puts in the prompt: every key the owner is trusting, with
/// every field the digest covers (the alg follows from the store), so a key
/// slipped into the set, or a policy weakened on a key already there, is in
/// front of them.
pub fn reason(pins: &[Pin]) -> String {
    if pins.is_empty() {
        return "agent-bot wants to remove every owner statement key, so no signed statement counts as yours".into();
    }
    let keys: Vec<String> = pins
        .iter()
        .map(|pin| {
            let kind = match (pin.store.as_str(), pin.software_key) {
                ("keyd", _) => "keyd key",
                (_, true) => "ssh software key",
                (_, false) => "ssh security key",
            };
            let verify = if pin.verify_required {
                ", PIN or biometric required"
            } else {
                ""
            };
            format!("{} ({kind}{verify}, {})", pin.name, pin.fingerprint)
        })
        .collect();
    format!(
        "agent-bot wants to trust only these keys to sign statements as you: {}",
        keys.join("; ")
    )
}

pub fn sign(
    seed: &[u8; 32],
    digest: Option<&str>,
    generation: u64,
    nonce: &str,
    now: u64,
) -> String {
    let payload = json!({
        "v": 1,
        "aud": AUDIENCE,
        "kind": KIND,
        "digest": digest,
        "generation": generation,
        "nonce": nonce,
        "iat": now,
        "exp": now + LIFETIME_SECONDS,
    });
    let segment = URL_SAFE_NO_PAD.encode(payload.to_string());
    let signature = SigningKey::from_bytes(seed).sign(segment.as_bytes());
    format!(
        "k1.{segment}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    pub const FP_A: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    pub const FP_B: &str = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    pub fn pin(name: &str, fingerprint: &str) -> Value {
        json!({ "name": name, "store": "ssh", "alg": "sshsig", "publicKey": "ignored", "fingerprint": fingerprint,
                "verifyRequired": false, "softwareKey": false, "pinnedAt": "2026-10-10T00:00:00.000Z" })
    }

    pub fn open(token: &str, seed: &[u8; 32]) -> Value {
        let mut parts = token.split('.');
        assert_eq!(parts.next(), Some("k1"));
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
    fn digests_the_canonical_key_set() {
        let pins = parse(&json!([pin("yubikey", FP_A), {
            "name": "mac", "store": "keyd", "alg": "ed25519", "fingerprint": FP_B, "verifyRequired": true, "softwareKey": false,
        }]))
        .unwrap();
        assert_eq!(
            canonical(&pins),
            format!("agent-bot owner pins v1\nssh sshsig {FP_A} 0 0 yubikey\nkeyd ed25519 {FP_B} 1 0 mac\n")
        );
        // Known vectors, shared with agent-bot's pinSetDigest test.
        assert_eq!(
            digest(&pins),
            "cb09d44b2df51fd95cbea3002bb477ac8c209f824089eaebda5c66d502325def"
        );
        assert_eq!(
            digest(&parse(&json!([])).unwrap()),
            "84685a46b42aa9f320b192a3a3843fdaece0ef8613a76b7ba10660504ca772c4"
        );
    }

    #[test]
    fn refuses_malformed_key_sets() {
        for pins in [
            json!({}),
            json!([
                pin("a", FP_A),
                pin("b", FP_B),
                pin("c", FP_A),
                pin("d", FP_B),
                pin("e", FP_A)
            ]),
            json!([pin("Upper", FP_A)]),
            json!([pin("ok", "SHA256:short")]),
            json!([pin("same", FP_A), pin("same", FP_B)]),
            json!([pin("one", FP_A), pin("two", FP_A)]),
            json!([{ "name": "x", "store": "ssh", "alg": "ed25519", "fingerprint": FP_A, "verifyRequired": false, "softwareKey": false }]),
            json!([{ "name": "x", "store": "ssh", "alg": "sshsig", "fingerprint": FP_A, "softwareKey": false }]),
        ] {
            assert!(parse(&pins).is_err(), "{pins}");
        }
    }

    #[test]
    fn signs_under_its_own_prefix_and_kind() {
        let seed = [9u8; 32];
        let payload = open(
            &sign(&seed, Some("ab"), 3, "n0nce-n0nce-n0nce-0", 100),
            &seed,
        );
        assert_eq!(payload["kind"], KIND);
        assert_eq!(payload["aud"], AUDIENCE);
        assert_eq!(payload["digest"], "ab");
        assert_eq!(payload["generation"], 3);
        assert_eq!(
            (payload["iat"].as_u64(), payload["exp"].as_u64()),
            (Some(100), Some(160))
        );
        let empty = open(&sign(&seed, None, 0, "n0nce-n0nce-n0nce-0", 100), &seed);
        assert!(empty["digest"].is_null());
    }

    #[test]
    fn names_every_key_in_the_prompt() {
        let mut software = pin("laptop", FP_B);
        software["softwareKey"] = json!(true);
        let mut verified = pin("yubikey", FP_A);
        verified["verifyRequired"] = json!(true);
        let pins = parse(&json!([verified, software])).unwrap();
        assert_eq!(
            reason(&pins),
            format!("agent-bot wants to trust only these keys to sign statements as you: yubikey (ssh security key, PIN or biometric required, {FP_A}); laptop (ssh software key, {FP_B})")
        );
        // The same key without its verification requirement reads differently.
        let weaker = parse(&json!([pin("yubikey", FP_A)])).unwrap();
        assert_eq!(
            reason(&weaker),
            format!("agent-bot wants to trust only these keys to sign statements as you: yubikey (ssh security key, {FP_A})")
        );
        let keyd = parse(&json!([{ "name": "mac", "store": "keyd", "alg": "ed25519", "fingerprint": FP_B, "verifyRequired": false, "softwareKey": false }])).unwrap();
        assert!(reason(&keyd).ends_with(&format!("mac (keyd key, {FP_B})")));
        assert!(reason(&[]).contains("remove every owner statement key"));
    }
}
