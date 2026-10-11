//! The keyd store for owner-signed statements (agent-bot-identity #753,
//! ADR-0753 section 5).
//!
//! agent-bot builds a statement or a challenge as the payload segment of
//!
//!   s1.<base64url(payload JSON)>.<base64url(signature)>
//!   payload: { v: 1, aud: "agent-bot-owner-statement", kind, alg, key,
//!              text, scope, action, nonce, iat, exp }
//!
//! and sends keyd only that segment (`owner/sign { payload }`). keyd decodes
//! and checks it with the rules agent-bot's verifier applies, builds the
//! prompt from the payload's own kind, text, scope and expiry, and signs
//! exactly the segment's bytes, so no caller can show the owner one text and
//! have another signed. It signs with the owner statement key, a seed of its
//! own (service `agent-bot.keyd`, account `owner-statement-key`), never the
//! presence seed: a presence assertion can never be a statement, and either
//! key rotates on its own. The payload must name that key's fingerprint, so
//! keyd never signs a payload that claims another key.
//!
//! `owner/statement-key { nonce }` reports the key's public half without a
//! prompt, as a `k1.` record signed with the presence key (`kind:
//! "statement-key"`), so agent-bot pins the key keyd holds, not one a process
//! standing in for keyd's socket handed it.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::presence;

pub const AUDIENCE: &str = "agent-bot-owner-statement";
/// The `kind` of keyd's signed report of the statement key.
pub const KEY_KIND: &str = "statement-key";
const KEY_RECORD_LIFETIME_SECONDS: u64 = 60;
const MAX_TEXT_BYTES: usize = 500;
const STATEMENT_MAX_SECONDS: u64 = 30 * 86_400;
const CHALLENGE_MAX_SECONDS: u64 = 900;
const CLOCK_SKEW_SECONDS: u64 = 30;
/// Far more than any payload within these rules encodes to.
const MAX_SEGMENT_BYTES: usize = 4096;
const FIELDS: [&str; 11] = [
    "action", "alg", "aud", "exp", "iat", "key", "kind", "nonce", "scope", "text", "v",
];
/// JavaScript's Number.MAX_SAFE_INTEGER: the largest number agent-bot reads exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A payload keyd agreed to put in front of the owner.
#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub kind: String,
    pub key: String,
    pub text: String,
    pub repo: Option<(String, u64)>,
    pub host: Option<String>,
    pub exp: u64,
}

/// The public key as the SSH wire blob agent-bot fingerprints.
fn ssh_blob(public: &[u8; 32]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(51);
    for part in [b"ssh-ed25519".as_slice(), public.as_slice()] {
        blob.extend_from_slice(&u32::try_from(part.len()).unwrap().to_be_bytes());
        blob.extend_from_slice(part);
    }
    blob
}

pub fn public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// `SHA256:` and unpadded base64 of the SHA-256 of the ssh-ed25519 blob, as
/// `ssh-keygen -l` prints it and agent-bot's `sshFingerprint` computes it.
pub fn fingerprint(public: &[u8; 32]) -> String {
    format!(
        "SHA256:{}",
        STANDARD_NO_PAD.encode(Sha256::digest(ssh_blob(public)))
    )
}

/// Control, line-break and bidirectional characters, as owner-text.mjs's
/// UNSAFE_TEXT: anything that could make the text read differently from
/// what is signed.
fn unsafe_char(c: char) -> bool {
    matches!(c as u32,
        0x00..=0x1f | 0x7f..=0x9f | 0x061c | 0x200e | 0x200f | 0x2028 | 0x2029
        | 0x202a..=0x202e | 0x2066..=0x2069)
}

fn text_ok(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES && !text.chars().any(unsafe_char)
}

/// `owner/name` as GitHub spells it.
fn repo_ok(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    let owner_bytes = owner.as_bytes();
    (1..=39).contains(&owner_bytes.len())
        && owner_bytes[0].is_ascii_alphanumeric()
        && owner_bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
        && (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn host_ok(host: &str) -> bool {
    let bytes = host.as_bytes();
    (1..=253).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
}

fn whole(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER)
}

/// The scope's repository and host, in one of the shapes ADR-0753 allows:
/// `{ repo, number }` for a statement, `{ host }` or `{ host, repo, number }`
/// for a challenge.
type Scope = (Option<(String, u64)>, Option<String>);

fn scope(value: &Value, kind: &str) -> Result<Scope, String> {
    let object = value.as_object().ok_or("the scope is not an object")?;
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let shapes: &[&[&str]] = if kind == "statement" {
        &[&["number", "repo"]]
    } else {
        &[&["host"], &["host", "number", "repo"]]
    };
    if !shapes.contains(&keys.as_slice()) {
        return Err(format!("a {kind} scope has another shape"));
    }
    let repo = match object.get("repo") {
        None => None,
        Some(repo) => {
            let repo = repo
                .as_str()
                .filter(|r| repo_ok(r))
                .ok_or("the scope repo is not owner/name")?;
            let number = whole(&object["number"])
                .filter(|n| *n > 0)
                .ok_or("the scope number is not a positive integer")?;
            Some((repo.to_owned(), number))
        }
    };
    let host = match object.get("host") {
        None => None,
        Some(host) => Some(
            host.as_str()
                .filter(|h| host_ok(h))
                .ok_or("the scope host is not a host name")?
                .to_owned(),
        ),
    };
    Ok((repo, host))
}

/// Decodes and checks a payload segment, every structural rule of
/// agent-bot's `payloadProblem` and its clock, for the ed25519 alg only.
/// `key` is checked against keyd's statement key by the caller, which needs
/// the seed for it; nothing here reads the Keychain.
pub fn parse(segment: &str, now: u64) -> Result<Request, String> {
    if segment.is_empty()
        || segment.len() > MAX_SEGMENT_BYTES
        || !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("the payload is not a base64url segment".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| "the payload is not base64url")?;
    if URL_SAFE_NO_PAD.encode(&bytes) != segment {
        return Err("the payload is not canonical base64url".into());
    }
    let payload: Map<String, Value> = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or("the payload is not a JSON object")?;
    let mut fields: Vec<&str> = payload.keys().map(String::as_str).collect();
    fields.sort_unstable();
    if fields != FIELDS {
        return Err("the payload has missing or unknown fields".into());
    }
    let text_field = |name: &str| payload[name].as_str();
    if whole(&payload["v"]) != Some(1) {
        return Err("the payload version is not 1".into());
    }
    if text_field("aud") != Some(AUDIENCE) {
        return Err(format!("the payload audience is not {AUDIENCE}"));
    }
    let kind = match text_field("kind") {
        Some(kind @ ("statement" | "challenge")) => kind,
        _ => return Err("the payload kind is not statement or challenge".into()),
    };
    if text_field("alg") != Some("ed25519") {
        return Err("keyd signs only the ed25519 alg".into());
    }
    let key = text_field("key").ok_or("the payload key is not a fingerprint")?;
    let text = text_field("text")
        .filter(|t| text_ok(t))
        .ok_or("the text is empty, longer than 500 bytes, or has a control, line-break or bidirectional character")?;
    let (repo, host) = scope(&payload["scope"], kind)?;
    let action = &payload["action"];
    let action_ok = if kind == "statement" {
        action.is_null()
    } else {
        action.as_str().is_some_and(|a| {
            a.len() == 64
                && a.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    };
    if !action_ok {
        return Err(if kind == "statement" {
            "a statement has no action".into()
        } else {
            "a challenge action is a sha256 hex digest".into()
        });
    }
    if !text_field("nonce").is_some_and(presence::nonce_ok) {
        return Err("the nonce is not 16 to 64 base64url characters".into());
    }
    let (Some(iat), Some(exp)) = (whole(&payload["iat"]), whole(&payload["exp"])) else {
        return Err("iat and exp are whole Unix seconds".into());
    };
    let limit = if kind == "statement" {
        STATEMENT_MAX_SECONDS
    } else {
        CHALLENGE_MAX_SECONDS
    };
    if exp <= iat || exp - iat > limit {
        return Err(format!(
            "a {kind} lasts more than 0 and at most {limit} seconds"
        ));
    }
    if iat > now + CLOCK_SKEW_SECONDS {
        return Err(format!("the {kind} is issued in the future"));
    }
    if now >= exp {
        return Err(format!("the {kind} has expired"));
    }
    Ok(Request {
        kind: kind.to_owned(),
        key: key.to_owned(),
        text: text.to_owned(),
        repo,
        host,
        exp,
    })
}

/// `YYYY-MM-DD HH:MM UTC` for Unix seconds (Howard Hinnant's civil_from_days).
fn utc(seconds: u64) -> String {
    let days = i64::try_from(seconds / 86_400).unwrap_or(i64::MAX / 2);
    let (hour, minute) = ((seconds % 86_400) / 3600, (seconds % 3600) / 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02} UTC")
}

/// The words keyd puts in the prompt: what is being signed, where it
/// applies, until when, and the owner's text exactly as signed.
pub fn reason(request: &Request) -> String {
    let target = request
        .repo
        .as_ref()
        .map(|(repo, number)| format!("{repo}#{number}"));
    let until = utc(request.exp);
    if request.kind == "statement" {
        format!(
            "agent-bot wants you to sign a statement as the owner, for {}, until {until}: \u{201c}{}\u{201d}",
            target.unwrap_or_default(),
            request.text
        )
    } else {
        let place = [
            request.host.as_ref().map(|h| format!("on {h}")),
            target.map(|t| format!("for {t}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        format!(
            "agent-bot asks you to approve a request {place}, until {until}: \u{201c}{}\u{201d}",
            request.text
        )
    }
}

/// The Ed25519 signature of the segment's ASCII bytes, base64url.
pub fn sign(seed: &[u8; 32], segment: &str) -> String {
    URL_SAFE_NO_PAD.encode(
        SigningKey::from_bytes(seed)
            .sign(segment.as_bytes())
            .to_bytes(),
    )
}

/// SHA-256 of the segment, hex: how a receipt names what was signed.
pub fn digest(segment: &str) -> String {
    presence::digest(segment)
}

/// keyd's report of the statement key, signed with the presence key:
///
///   k1.<base64url(payload)>.<base64url(signature)>
///   payload: { v: 1, aud: "agent-bot-owner", kind: "statement-key",
///              key: base64(raw public key), fingerprint, nonce, iat, exp }
pub fn sign_key_record(
    presence_seed: &[u8; 32],
    statement_public: &[u8; 32],
    nonce: &str,
    now: u64,
) -> String {
    let payload = json!({
        "v": 1,
        "aud": presence::AUDIENCE,
        "kind": KEY_KIND,
        "key": STANDARD.encode(statement_public),
        "fingerprint": fingerprint(statement_public),
        "nonce": nonce,
        "iat": now,
        "exp": now + KEY_RECORD_LIFETIME_SECONDS,
    });
    let segment = URL_SAFE_NO_PAD.encode(payload.to_string());
    let signature = SigningKey::from_bytes(presence_seed).sign(segment.as_bytes());
    format!(
        "k1.{segment}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Known vectors, shared with agent-bot's tests/owner-keyd-store.test.mjs:
    /// the seed of 32 bytes of 7, its public key and fingerprint, a statement
    /// payload naming that key, and the signature of that segment.
    pub const SEED: [u8; 32] = [7u8; 32];
    pub const PUBLIC: &str = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
    pub const FINGERPRINT: &str = "SHA256:z/fSv0Z0RZS+Lccbc6ZoOWwt/fbj1VFJGSBKQbo4icE";
    pub const SEGMENT: &str = "eyJ2IjoxLCJhdWQiOiJhZ2VudC1ib3Qtb3duZXItc3RhdGVtZW50Iiwia2luZCI6InN0YXRlbWVudCIsImFsZyI6ImVkMjU1MTkiLCJrZXkiOiJTSEEyNTY6ei9mU3YwWjBSWlMrTGNjYmM2Wm9PV3d0L2ZiajFWRkpHU0JLUWJvNGljRSIsInRleHQiOiJTaGlwIHRoZSBrZXlkIG93bmVyL3NpZ24gc2xpY2UuIiwic2NvcGUiOnsicmVwbyI6InF3dHMvYWdlbnQtYm90LWlkZW50aXR5IiwibnVtYmVyIjo3NTN9LCJhY3Rpb24iOm51bGwsIm5vbmNlIjoidmVjdG9yLW5vbmNlLTAxMjM0NTY3ODkiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDYwNDgwMH0";
    pub const SIGNATURE: &str =
        "rOHSC-6pyz8LQWNpdDOR2-M2FlI2Bkp0i0UkjHDKtBDThiIYHzQ8e8foA0vcUxJf5WFthc94yh6x6jyDgkmhBA";
    /// The vector statement's iat.
    pub const IAT: u64 = 1_800_000_000;

    pub fn segment(payload: &Value) -> String {
        URL_SAFE_NO_PAD.encode(payload.to_string())
    }

    pub fn statement(key: &str) -> Value {
        json!({ "v": 1, "aud": AUDIENCE, "kind": "statement", "alg": "ed25519", "key": key,
                "text": "Ship the keyd owner/sign slice.", "scope": { "repo": "qwts/agent-bot-identity", "number": 753 },
                "action": null, "nonce": "vector-nonce-0123456789", "iat": IAT, "exp": IAT + 7 * 86_400 })
    }

    pub fn challenge(key: &str) -> Value {
        json!({ "v": 1, "aud": AUDIENCE, "kind": "challenge", "alg": "ed25519", "key": key,
                "text": "Enrol owner key mac", "scope": { "host": "studio" },
                "action": "a".repeat(64), "nonce": "challenge-nonce-0123456", "iat": IAT, "exp": IAT + 600 })
    }

    #[test]
    fn matches_the_shared_vectors() {
        let public = public_key(&SEED);
        assert_eq!(STANDARD.encode(public), PUBLIC);
        assert_eq!(fingerprint(&public), FINGERPRINT);
        // The segment as agent-bot encodes it (field order is agent-bot's;
        // keyd signs the bytes it is sent, never a re-encoding).
        let decoded: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(SEGMENT).unwrap()).unwrap();
        assert_eq!(decoded, statement(FINGERPRINT));
        assert_eq!(sign(&SEED, SEGMENT), SIGNATURE);
    }

    #[test]
    fn reads_a_statement_and_a_challenge() {
        let request = parse(SEGMENT, IAT).unwrap();
        assert_eq!(
            request,
            Request {
                kind: "statement".into(),
                key: FINGERPRINT.into(),
                text: "Ship the keyd owner/sign slice.".into(),
                repo: Some(("qwts/agent-bot-identity".into(), 753)),
                host: None,
                exp: IAT + 7 * 86_400,
            }
        );
        assert_eq!(
            reason(&request),
            "agent-bot wants you to sign a statement as the owner, for qwts/agent-bot-identity#753, until 2027-01-22 08:00 UTC: \u{201c}Ship the keyd owner/sign slice.\u{201d}"
        );
        let challenge = parse(&segment(&challenge(FINGERPRINT)), IAT + 10).unwrap();
        assert_eq!(
            reason(&challenge),
            "agent-bot asks you to approve a request on studio, until 2027-01-15 08:10 UTC: \u{201c}Enrol owner key mac\u{201d}"
        );
        let mut scoped = challenge_value();
        scoped["scope"] = json!({ "host": "studio", "repo": "qwts/x", "number": 5 });
        assert!(reason(&parse(&segment(&scoped), IAT).unwrap())
            .starts_with("agent-bot asks you to approve a request on studio for qwts/x#5, until"));
    }

    fn challenge_value() -> Value {
        challenge(FINGERPRINT)
    }

    #[test]
    fn refuses_what_agent_bot_would_refuse() {
        let edits: Vec<(&str, Value)> = vec![
            ("v", json!(2)),
            ("aud", json!("agent-bot-owner")),
            ("kind", json!("presence")),
            ("alg", json!("sshsig")),
            ("text", json!(" ")),
            ("text", json!("x".repeat(501))),
            ("text", json!("line\nbreak")),
            ("text", json!("bidi \u{202e} override")),
            ("text", json!("zero \u{200f} width")),
            ("scope", json!({ "host": "studio" })),
            ("scope", json!({ "repo": "qwts/x" })),
            ("scope", json!({ "repo": "qwts/x", "number": 0 })),
            ("scope", json!({ "repo": "not a repo", "number": 1 })),
            (
                "scope",
                json!({ "repo": "qwts/x", "number": 1, "extra": 1 }),
            ),
            ("action", json!("a".repeat(64))),
            ("nonce", json!("short")),
            ("iat", json!(-1)),
            ("exp", json!(IAT)),
            ("exp", json!(IAT + 30 * 86_400 + 1)),
            ("iat", json!(IAT + 31)),
        ];
        for (field, value) in edits {
            let mut payload = statement(FINGERPRINT);
            payload[field] = value.clone();
            assert!(parse(&segment(&payload), IAT).is_err(), "{field} = {value}");
        }
        let mut payload = statement(FINGERPRINT);
        payload.as_object_mut().unwrap().remove("action");
        assert!(parse(&segment(&payload), IAT).is_err());
        payload["action"] = Value::Null;
        payload["extra"] = json!(1);
        assert!(parse(&segment(&payload), IAT).is_err());
        // A challenge: its own scopes, an action digest, at most 15 minutes.
        for (field, value) in [
            ("scope", json!({ "repo": "qwts/x", "number": 1 })),
            ("scope", json!({ "host": "-studio" })),
            ("action", Value::Null),
            ("action", json!("A".repeat(64))),
            ("exp", json!(IAT + 901)),
        ] {
            let mut payload = challenge_value();
            payload[field] = value.clone();
            assert!(parse(&segment(&payload), IAT).is_err(), "{field} = {value}");
        }
        // Expired, not base64url, padded, not canonical, not JSON, too long.
        assert!(parse(SEGMENT, IAT + 7 * 86_400).is_err());
        for bad in [
            "",
            "not base64url!",
            &format!("{SEGMENT}="),
            &URL_SAFE_NO_PAD.encode("[1]"),
            &URL_SAFE_NO_PAD.encode("not json"),
            &"A".repeat(MAX_SEGMENT_BYTES + 1),
        ] {
            assert!(parse(bad, IAT).is_err(), "{bad}");
        }
        // A trailing bit set where canonical base64url has none.
        let mut noncanonical = SEGMENT.to_owned();
        let last = noncanonical.pop().unwrap();
        noncanonical.push(if last == 'Q' { 'R' } else { 'Q' });
        if URL_SAFE_NO_PAD.decode(&noncanonical).is_ok() {
            assert!(parse(&noncanonical, IAT).is_err());
        }
    }

    #[test]
    fn signs_its_key_record_with_the_presence_key() {
        let presence_seed = [9u8; 32];
        let public = public_key(&SEED);
        let record = sign_key_record(&presence_seed, &public, "n0nce-n0nce-n0nce-0", 100);
        let payload = crate::pins::tests::open(&record, &presence_seed);
        assert_eq!(payload["kind"], KEY_KIND);
        assert_eq!(payload["aud"], presence::AUDIENCE);
        assert_eq!(payload["key"], PUBLIC);
        assert_eq!(payload["fingerprint"], FINGERPRINT);
        assert_eq!(payload["nonce"], "n0nce-n0nce-n0nce-0");
        assert_eq!(
            (payload["iat"].as_u64(), payload["exp"].as_u64()),
            (Some(100), Some(160))
        );
    }

    #[test]
    fn formats_utc() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00 UTC");
        assert_eq!(utc(1_800_000_000), "2027-01-15 08:00 UTC");
    }
}
