//! Minting: the App JWT is signed here, with the key from the Keychain, and
//! exchanged for an installation token. The JWT never leaves this process;
//! callers get only the installation token (one hour, one installation).

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};

use crate::grant::Grant;
use crate::store::Credential;

pub struct Minted {
    pub token: String,
    pub expires_at: String,
    pub installation_id: u64,
}

pub trait Http: Send + Sync {
    /// One request with `Authorization: Bearer <bearer>`; the status and the
    /// parsed JSON body (Null when it is not JSON).
    fn request(&self, method: &str, url: &str, bearer: &str) -> Result<(u16, Value), String>;
}

/// PEM to the DER the Security framework takes: PKCS#1 as it is (what
/// GitHub downloads), PKCS#8 unwrapped to its PKCS#1 key.
pub fn rsa_der(pem: &str) -> Result<Vec<u8>, &'static str> {
    let (label, body) = pem_body(pem).ok_or("App key is not PEM")?;
    let der = STANDARD.decode(body).map_err(|_| "App key is not PEM")?;
    match label.as_str() {
        "RSA PRIVATE KEY" => Ok(der),
        "PRIVATE KEY" => pkcs8_inner(&der).ok_or("App key is not an RSA key"),
        _ => Err("App key is not an RSA private key"),
    }
}

fn pem_body(pem: &str) -> Option<(String, String)> {
    let start = pem.find("-----BEGIN ")?;
    let rest = &pem[start + 11..];
    let label_end = rest.find("-----")?;
    let label = rest[..label_end].to_owned();
    let body_start = label_end + 5;
    let end = rest.find(&format!("-----END {label}-----"))?;
    let body: String = rest[body_start..end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    Some((label, body))
}

/// One DER element at `at`: (tag, content start, content end).
fn der_element(der: &[u8], at: usize) -> Option<(u8, usize, usize)> {
    let tag = *der.get(at)?;
    let first = *der.get(at + 1)? as usize;
    let (length, header) = if first < 0x80 {
        (first, 2)
    } else {
        let count = first & 0x7f;
        if count == 0 || count > 4 {
            return None;
        }
        let mut length = 0usize;
        for i in 0..count {
            length = (length << 8) | *der.get(at + 2 + i)? as usize;
        }
        (length, 2 + count)
    };
    let start = at + header;
    let end = start.checked_add(length)?;
    (end <= der.len()).then_some((tag, start, end))
}

// PrivateKeyInfo ::= SEQUENCE { version INTEGER, algorithm SEQUENCE, privateKey OCTET STRING }
fn pkcs8_inner(der: &[u8]) -> Option<Vec<u8>> {
    const RSA_OID: [u8; 9] = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
    let (0x30, body, _) = der_element(der, 0)? else {
        return None;
    };
    let (0x02, _, version_end) = der_element(der, body)? else {
        return None;
    };
    let (0x30, algorithm, algorithm_end) = der_element(der, version_end)? else {
        return None;
    };
    let (0x06, oid, oid_end) = der_element(der, algorithm)? else {
        return None;
    };
    if der[oid..oid_end] != RSA_OID {
        return None;
    }
    let (0x04, key, key_end) = der_element(der, algorithm_end)? else {
        return None;
    };
    Some(der[key..key_end].to_vec())
}

#[cfg(target_os = "macos")]
fn sign_rs256(der: &[u8], input: &[u8]) -> Result<Vec<u8>, String> {
    use core_foundation::base::TCFType;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFMutableDictionary;
    use security_framework::key::{Algorithm, SecKey};
    use security_framework_sys::item::{
        kSecAttrKeyClass, kSecAttrKeyClassPrivate, kSecAttrKeyType, kSecAttrKeyTypeRSA,
    };
    use security_framework_sys::key::SecKeyCreateWithData;

    let data = CFData::from_buffer(der);
    let mut attributes = CFMutableDictionary::new();
    // SAFETY: Security framework constants, valid for the process lifetime.
    unsafe {
        attributes.add(&kSecAttrKeyType.cast(), &kSecAttrKeyTypeRSA.cast());
        attributes.add(&kSecAttrKeyClass.cast(), &kSecAttrKeyClassPrivate.cast());
    }
    let mut error = std::ptr::null_mut();
    // SAFETY: valid CF objects; the key is returned +1 (create rule) or null.
    let key = unsafe {
        SecKeyCreateWithData(
            data.as_concrete_TypeRef(),
            attributes.as_concrete_TypeRef(),
            &mut error,
        )
    };
    if key.is_null() {
        if !error.is_null() {
            // SAFETY: a +1 CFError we own.
            unsafe { core_foundation::base::CFRelease(error.cast()) };
        }
        return Err("App key could not be loaded".into());
    }
    // SAFETY: non-null, create rule.
    let key = unsafe { SecKey::wrap_under_create_rule(key) };
    key.create_signature(Algorithm::RSASignatureMessagePKCS1v15SHA256, input)
        .map_err(|_| "App JWT could not be signed".into())
}

/// The App JWT mint-token.mjs builds: nine minutes with a 60-second backdate.
pub fn app_jwt(credential: &Credential, now: u64) -> Result<String, String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({ "iat": now - 60, "exp": now + 540, "iss": credential.app_id }))
            .expect("json"),
    );
    let input = format!("{header}.{payload}");
    let mut der = rsa_der(&credential.private_key_pem)?;
    let signature = sign_rs256(&der, input.as_bytes());
    der.fill(0);
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature?)))
}

fn github_message(body: &Value) -> String {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    message
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect()
}

/// mint-token.mjs's pickInstallation: the only one, else the one on `owner`.
fn pick_installation(installations: &Value, owner: Option<&str>) -> Result<u64, String> {
    let list = installations
        .as_array()
        .ok_or("GitHub returned no installations list")?;
    let id = |entry: &Value| entry.get("id").and_then(Value::as_u64);
    match list.len() {
        0 => Err("the App is not installed on any account".into()),
        1 => id(&list[0]).ok_or_else(|| "GitHub returned an installation with no id".into()),
        _ => {
            let owner = owner.ok_or(
                "the App is installed on several accounts; set \"owner\" in agent-bot's config",
            )?;
            list.iter()
                .find(|entry| {
                    entry
                        .pointer("/account/login")
                        .and_then(Value::as_str)
                        .is_some_and(|login| login.eq_ignore_ascii_case(owner))
                })
                .and_then(id)
                .ok_or_else(|| {
                    "the configured owner matches none of the App's installations".into()
                })
        }
    }
}

pub fn mint(
    http: &dyn Http,
    credential: &Credential,
    grant: &Grant,
    now: u64,
) -> Result<Minted, String> {
    let jwt = app_jwt(credential, now)?;
    let base = grant.api_base.trim_end_matches('/');
    let installation_id = match grant.installation_id {
        Some(id) => id,
        None => {
            let (status, body) = http.request("GET", &format!("{base}/app/installations"), &jwt)?;
            if status != 200 {
                return Err(format!(
                    "GET /app/installations -> {status}: {}",
                    github_message(&body)
                ));
            }
            pick_installation(&body, grant.owner.as_deref())?
        }
    };
    let (status, body) = http.request(
        "POST",
        &format!("{base}/app/installations/{installation_id}/access_tokens"),
        &jwt,
    )?;
    if status != 201 && status != 200 {
        return Err(format!(
            "POST /app/installations/{installation_id}/access_tokens -> {status}: {}",
            github_message(&body)
        ));
    }
    let field = |name: &str| body.get(name).and_then(Value::as_str).map(str::to_owned);
    match (field("token"), field("expires_at")) {
        (Some(token), Some(expires_at)) => Ok(Minted {
            token,
            expires_at,
            installation_id,
        }),
        _ => Err("GitHub returned no installation token".into()),
    }
}

/// The real client: TLS through the system (native-tls on Security.framework).
pub struct Ureq {
    agent: ureq::Agent,
}

impl Ureq {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(20)))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::NativeTls)
                    .build(),
            )
            .build();
        Self {
            agent: config.into(),
        }
    }
}

impl Http for Ureq {
    fn request(&self, method: &str, url: &str, bearer: &str) -> Result<(u16, Value), String> {
        let authorization = format!("Bearer {bearer}");
        let response = match method {
            "GET" => self
                .agent
                .get(url)
                .header("authorization", &authorization)
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28")
                .header("user-agent", "agent-bot-keyd")
                .call(),
            _ => self
                .agent
                .post(url)
                .header("authorization", &authorization)
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28")
                .header("user-agent", "agent-bot-keyd")
                .send_empty(),
        };
        // The error names the request, never the bearer.
        let mut response =
            response.map_err(|error| format!("{method} {} failed: {error}", url_path(url)))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(1 << 20)
            .read_to_string()
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        Ok((status, body))
    }
}

fn url_path(url: &str) -> &str {
    url.find("://")
        .and_then(|i| url[i + 3..].find('/').map(|j| &url[i + 3 + j..]))
        .unwrap_or(url)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::grant::tests::{payload, AGENT};
    use std::sync::Mutex;

    /// Records each request and answers from a script.
    pub struct Scripted {
        pub calls: Mutex<Vec<(String, String)>>,
        pub installations: Value,
    }

    impl Scripted {
        pub fn new(installations: Value) -> Self {
            Self {
                calls: Mutex::default(),
                installations,
            }
        }
    }

    impl Http for Scripted {
        fn request(&self, method: &str, url: &str, bearer: &str) -> Result<(u16, Value), String> {
            assert_eq!(bearer.split('.').count(), 3, "an App JWT");
            self.calls.lock().unwrap().push((method.into(), url.into()));
            if method == "GET" {
                return Ok((200, self.installations.clone()));
            }
            Ok((
                201,
                json!({ "token": "ghs_test", "expires_at": "2026-10-03T22:00:00Z" }),
            ))
        }
    }

    /// A throwaway RSA key made by the Security framework, as PKCS#1 PEM.
    #[cfg(target_os = "macos")]
    pub fn test_key_pem() -> (String, security_framework::key::SecKey) {
        use security_framework::key::{GenerateKeyOptions, KeyType, SecKey};
        let mut options = GenerateKeyOptions::default();
        options.set_key_type(KeyType::rsa()).set_size_in_bits(2048);
        let key = SecKey::new(&options).unwrap();
        let der = key.external_representation().unwrap();
        let body = STANDARD.encode(der.bytes());
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        (
            format!(
                "-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----\n",
                lines.join("\n")
            ),
            key,
        )
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn signs_an_app_jwt_the_public_key_verifies() {
        use security_framework::key::Algorithm;
        let (pem, key) = test_key_pem();
        let jwt = app_jwt(
            &Credential {
                app_id: "42".into(),
                private_key_pem: pem,
            },
            10_000,
        )
        .unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims, json!({ "iat": 9_940, "exp": 10_540, "iss": "42" }));
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        let public = key.public_key().unwrap();
        assert!(public
            .verify_signature(
                Algorithm::RSASignatureMessagePKCS1v15SHA256,
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &signature
            )
            .unwrap());
    }

    #[test]
    fn unwraps_pkcs8_and_refuses_other_keys() {
        // PKCS#8 around a (fake) PKCS#1 body.
        let inner = [0x30, 0x03, 0x02, 0x01, 0x00];
        let mut der = vec![0x30, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09];
        der.extend([
            0x2a,
            0x86,
            0x48,
            0x86,
            0xf7,
            0x0d,
            0x01,
            0x01,
            0x01,
            0x05,
            0x00,
            0x04,
            inner.len() as u8,
        ]);
        der.extend(inner);
        der[1] = (der.len() - 2) as u8;
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(&der)
        );
        assert_eq!(rsa_der(&pem).unwrap(), inner);
        assert!(
            rsa_der("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----").is_err()
        );
        assert!(rsa_der("not a key").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mints_on_the_only_installation_or_the_owners() {
        let (pem, _) = test_key_pem();
        let credential = Credential {
            app_id: "42".into(),
            private_key_pem: pem,
        };
        let now = 10_000;
        let grant: Grant = serde_json::from_value(payload("credential", now)).unwrap();
        let http = Scripted::new(json!([{ "id": 7, "account": { "login": "qwts" } }]));
        let minted = mint(&http, &credential, &grant, now).unwrap();
        assert_eq!(
            (minted.token.as_str(), minted.installation_id),
            ("ghs_test", 7)
        );
        assert_eq!(
            http.calls.lock().unwrap().clone(),
            vec![
                (
                    "GET".into(),
                    "https://api.github.com/app/installations".into()
                ),
                (
                    "POST".into(),
                    "https://api.github.com/app/installations/7/access_tokens".into()
                ),
            ]
        );

        let several = Scripted::new(
            json!([{ "id": 7, "account": { "login": "qwts" } }, { "id": 8, "account": { "login": "Other" } }]),
        );
        assert!(mint(&several, &credential, &grant, now).is_err());
        let mut owned = payload("credential", now);
        owned["owner"] = json!("other");
        let grant: Grant = serde_json::from_value(owned).unwrap();
        assert_eq!(
            mint(&several, &credential, &grant, now)
                .unwrap()
                .installation_id,
            8
        );

        let mut pinned = payload("credential", now);
        pinned["installationId"] = json!(99);
        let grant: Grant = serde_json::from_value(pinned).unwrap();
        let direct = Scripted::new(json!([]));
        assert_eq!(
            mint(&direct, &credential, &grant, now)
                .unwrap()
                .installation_id,
            99
        );
        assert_eq!(direct.calls.lock().unwrap().len(), 1);
        let _ = AGENT;
    }
}
