//! Where keyd keeps keys: generic passwords in the login keychain, created by
//! keyd itself. An item a process adds through SecKeychainAddGenericPassword
//! with no explicit access gets an access list that trusts only that
//! process's code, by its designated requirement (Team ID and identifier for
//! a Developer ID build). Any other reader, `security` and `node` included,
//! gets the system's allow/deny prompt instead of a silent read, and an
//! update signed by the same team keeps access.
//!
//! - a soul's App key: service `agent-bot.keyd.<agentId>`, account
//!   `github-app/<slug>`, value base64 of `{appId, privateKeyPem}` (the
//!   encoding soul-credentials.mjs uses). The service differs from the
//!   `agent-bot.soul.<agentId>` items `security` created (#395), so keyd never
//!   needs access to an item it did not create.
//! - the daemon's grant key the owner pinned: service `agent-bot.keyd`,
//!   account `daemon-grant-key`, value base64 of the raw Ed25519 public key.
//! - keyd's own presence key (agent-bot-identity #416), which signs the
//!   owner's presence for agent-bot: service `agent-bot.keyd`, account
//!   `presence-key`, value base64 of the 32-byte Ed25519 seed. keyd makes it
//!   on first use; only keyd's code can read it.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::ids::{is_agent_id, is_app_slug};

pub struct Credential {
    pub app_id: String,
    pub private_key_pem: String,
}

impl Drop for Credential {
    fn drop(&mut self) {
        // Best effort: the key does not outlive the call that needed it.
        // SAFETY: zero bytes are valid UTF-8.
        unsafe { self.private_key_pem.as_bytes_mut().fill(0) };
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    app_id: String,
    private_key_pem: String,
}

pub fn encode(credential: &Credential) -> String {
    STANDARD.encode(
        serde_json::to_vec(&Stored {
            app_id: credential.app_id.clone(),
            private_key_pem: credential.private_key_pem.clone(),
        })
        .expect("serializable"),
    )
}

pub fn decode(text: &[u8]) -> Result<Credential, &'static str> {
    let stored: Stored = STANDARD
        .decode(text.trim_ascii())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("stored credential is malformed")?;
    if stored.app_id.is_empty() || !stored.app_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("stored credential is malformed");
    }
    Ok(Credential {
        app_id: stored.app_id,
        private_key_pem: stored.private_key_pem,
    })
}

pub const PIN_SERVICE: &str = "agent-bot.keyd";
pub const PIN_ACCOUNT: &str = "daemon-grant-key";
pub const PRESENCE_ACCOUNT: &str = "presence-key";

pub fn item(agent_id: &str, app: &str) -> Result<(String, String), &'static str> {
    if !is_agent_id(agent_id) || !is_app_slug(app) {
        return Err("invalid soul or App");
    }
    Ok((
        format!("agent-bot.keyd.{agent_id}"),
        format!("github-app/{app}"),
    ))
}

/// Raw generic-password access; everything above it is shared.
pub trait Items: Send + Sync {
    fn read(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String>;
    fn remove(&self, service: &str, account: &str) -> Result<bool, String>;
}

pub struct Store {
    items: Box<dyn Items>,
}

impl Store {
    pub fn new(items: Box<dyn Items>) -> Self {
        Self { items }
    }

    pub fn credential(&self, agent_id: &str, app: &str) -> Result<Option<Credential>, String> {
        let (service, account) = item(agent_id, app)?;
        match self.items.read(&service, &account)? {
            None => Ok(None),
            Some(mut bytes) => {
                let decoded = decode(&bytes).map(Some).map_err(str::to_owned);
                bytes.fill(0);
                decoded
            }
        }
    }

    pub fn put_credential(
        &self,
        agent_id: &str,
        app: &str,
        credential: &Credential,
    ) -> Result<(), String> {
        let (service, account) = item(agent_id, app)?;
        let mut value = encode(credential).into_bytes();
        let written = self.items.write(&service, &account, &value);
        value.fill(0);
        written
    }

    pub fn remove_credential(&self, agent_id: &str, app: &str) -> Result<bool, String> {
        let (service, account) = item(agent_id, app)?;
        self.items.remove(&service, &account)
    }

    pub fn pinned_key(&self) -> Result<Option<[u8; 32]>, String> {
        let Some(value) = self.items.read(PIN_SERVICE, PIN_ACCOUNT)? else {
            return Ok(None);
        };
        let raw = STANDARD
            .decode(value.trim_ascii())
            .map_err(|_| "pinned daemon key is malformed".to_owned())?;
        raw.try_into()
            .map(Some)
            .map_err(|_| "pinned daemon key is malformed".to_owned())
    }

    pub fn pin_key(&self, key: &[u8; 32]) -> Result<(), String> {
        self.items
            .write(PIN_SERVICE, PIN_ACCOUNT, STANDARD.encode(key).as_bytes())
    }

    /// keyd's presence signing seed, made and kept on first use.
    pub fn presence_seed(&self) -> Result<[u8; 32], String> {
        if let Some(mut value) = self.items.read(PIN_SERVICE, PRESENCE_ACCOUNT)? {
            let decoded = STANDARD.decode(value.trim_ascii());
            value.fill(0);
            let mut raw = decoded.map_err(|_| "presence key is malformed".to_owned())?;
            let seed: Result<[u8; 32], _> = raw.as_slice().try_into();
            raw.fill(0);
            return seed.map_err(|_| "presence key is malformed".to_owned());
        }
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|_| "no randomness for the presence key".to_owned())?;
        let mut value = STANDARD.encode(seed).into_bytes();
        let written = self.items.write(PIN_SERVICE, PRESENCE_ACCOUNT, &value);
        value.fill(0);
        written?;
        Ok(seed)
    }
}

#[cfg(target_os = "macos")]
pub mod keychain {
    use super::Items;
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::os::macos::passwords::find_generic_password;
    use std::path::PathBuf;

    const NOT_FOUND: i32 = -25300; // errSecItemNotFound

    /// The login keychain, or (tests) a keychain file of its own.
    pub struct Keychain {
        path: Option<PathBuf>,
    }

    impl Keychain {
        pub fn login() -> Self {
            Self { path: None }
        }

        pub fn at(path: PathBuf) -> Self {
            Self { path: Some(path) }
        }

        fn open(&self) -> Result<SecKeychain, String> {
            match &self.path {
                None => SecKeychain::default(),
                Some(path) => SecKeychain::open(path),
            }
            .map_err(|error| format!("the keychain could not be opened ({})", error.code()))
        }
    }

    impl Items for Keychain {
        fn read(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
            let keychain = self.open()?;
            match find_generic_password(Some(std::slice::from_ref(&keychain)), service, account) {
                Ok((password, _)) => Ok(Some(password.to_owned())),
                Err(error) if error.code() == NOT_FOUND => Ok(None),
                Err(error) => Err(format!("the keychain could not be read ({})", error.code())),
            }
        }

        fn write(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
            let keychain = self.open()?;
            // An existing item keeps the access list keyd gave it at creation.
            keychain
                .set_generic_password(service, account, value)
                .map_err(|error| {
                    format!("the keychain item could not be written ({})", error.code())
                })
        }

        fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
            let keychain = self.open()?;
            match keychain.find_generic_password(service, account) {
                Ok((_, item)) => {
                    item.delete();
                    Ok(true)
                }
                Err(error) if error.code() == NOT_FOUND => Ok(false),
                Err(error) => Err(format!("the keychain could not be read ({})", error.code())),
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Memory(pub Mutex<HashMap<(String, String), Vec<u8>>>);

    impl Items for Memory {
        fn read(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(&(service.into(), account.into()))
                .cloned())
        }
        fn write(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert((service.into(), account.into()), value.to_vec());
            Ok(())
        }
        fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .remove(&(service.into(), account.into()))
                .is_some())
        }
    }

    const AGENT: &str = "agent_ea588a53-c6ce-430b-9d71-89897d843ab6";

    fn exercise(store: &Store) {
        assert!(store
            .credential(AGENT, "qwts-claude-agent")
            .unwrap()
            .is_none());
        let credential = Credential {
            app_id: "123".into(),
            private_key_pem: "PEM".into(),
        };
        store
            .put_credential(AGENT, "qwts-claude-agent", &credential)
            .unwrap();
        let back = store
            .credential(AGENT, "qwts-claude-agent")
            .unwrap()
            .unwrap();
        assert_eq!(
            (back.app_id.as_str(), back.private_key_pem.as_str()),
            ("123", "PEM")
        );
        // Rotation replaces the value in place.
        let rotated = Credential {
            app_id: "123".into(),
            private_key_pem: "PEM2".into(),
        };
        store
            .put_credential(AGENT, "qwts-claude-agent", &rotated)
            .unwrap();
        assert_eq!(
            store
                .credential(AGENT, "qwts-claude-agent")
                .unwrap()
                .unwrap()
                .private_key_pem,
            "PEM2"
        );
        assert!(store.remove_credential(AGENT, "qwts-claude-agent").unwrap());
        assert!(!store.remove_credential(AGENT, "qwts-claude-agent").unwrap());
        assert!(store.pinned_key().unwrap().is_none());
        store.pin_key(&[3u8; 32]).unwrap();
        assert_eq!(store.pinned_key().unwrap(), Some([3u8; 32]));
        let seed = store.presence_seed().unwrap();
        assert_eq!(store.presence_seed().unwrap(), seed, "made once, then kept");
        assert_ne!(seed, [0u8; 32]);
        assert!(store.credential("agent_../x", "qwts-claude-agent").is_err());
    }

    #[test]
    fn memory_store_round_trips() {
        exercise(&Store::new(Box::<Memory>::default()));
    }

    #[test]
    fn decodes_the_soul_credentials_encoding() {
        // soul-credentials.mjs: base64 of JSON {appId, privateKeyPem}.
        let encoded = STANDARD.encode(br#"{"appId":"42","privateKeyPem":"-----BEGIN"}"#);
        let credential = decode(encoded.as_bytes()).unwrap();
        assert_eq!(credential.app_id, "42");
        assert!(decode(
            STANDARD
                .encode(br#"{"appId":"x","privateKeyPem":""}"#)
                .as_bytes()
        )
        .is_err());
    }

    /// A real keychain, in a file of its own under a temporary directory: the
    /// login keychain is never opened. Creating a keychain adds it to this
    /// user's search list, and deleting it removes it again.
    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_store_round_trips_in_a_temporary_keychain() {
        use security_framework::os::macos::keychain::CreateOptions;
        let dir = crate::paths::tests::short_temp_dir("kc");
        let path = dir.join("keyd-test.keychain-db");
        let keychain = CreateOptions::new()
            .password("keyd-test")
            .create(&path)
            .unwrap();
        let mut unlocked = keychain.clone();
        unlocked.unlock(Some("keyd-test")).unwrap();
        let result = std::panic::catch_unwind(|| {
            exercise(&Store::new(Box::new(keychain::Keychain::at(path.clone()))));
        });
        delete_keychain(&keychain);
        let _ = std::fs::remove_dir_all(&dir);
        result.unwrap();
    }

    #[cfg(target_os = "macos")]
    fn delete_keychain(keychain: &security_framework::os::macos::keychain::SecKeychain) {
        use core_foundation::base::TCFType;
        extern "C" {
            fn SecKeychainDelete(keychain: *mut std::ffi::c_void) -> i32;
        }
        // SAFETY: a live keychain reference; deleting removes the file and
        // its search-list entry.
        unsafe { SecKeychainDelete(keychain.as_concrete_TypeRef() as *mut _) };
    }
}
