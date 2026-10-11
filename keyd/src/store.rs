//! Where keyd keeps keys: generic passwords in the login keychain, created by
//! keyd itself with an access whose every entry names keyd's own code, by its
//! designated requirement (Team ID and identifier for a Developer ID build).
//! Any other reader, `security` and `node` included, gets the system's
//! allow/deny prompt instead of a silent read, and an update signed by the
//! same team keeps access. Leaving an item to the framework's default access
//! is not enough: that default trusts any application to write the value, so
//! any process in this account could replace a key without a prompt (#753).
//! See [`keychain`] for what an access list does and does not stop.
//!
//! - a soul's App key: service `agent-bot.keyd.<agentId>`, account
//!   `github-app/<slug>`, value base64 of `{appId, privateKeyPem}` (the
//!   encoding soul-credentials.mjs uses). The service differs from the
//!   `agent-bot.soul.<agentId>` items `security` created (#395), so keyd never
//!   needs access to an item it did not create.
//! - an App-level key (agent-bot-identity #110), shared by every soul that
//!   acts as that App: service `agent-bot.keyd.app`, account
//!   `github-app/<slug>`, the same value encoding. An Agent ID always starts
//!   `agent_`, so this service never meets a soul's.
//! - the daemon's grant key the owner pinned: service `agent-bot.keyd`,
//!   account `daemon-grant-key`, value base64 of the raw Ed25519 public key.
//! - keyd's own presence key (agent-bot-identity #416), which signs the
//!   owner's presence for agent-bot: service `agent-bot.keyd`, account
//!   `presence-key`, value base64 of the 32-byte Ed25519 seed. keyd makes it
//!   on first use; only keyd's code can read it.
//! - the owner's statement keys as the owner last approved them
//!   (agent-bot-identity #753): service `agent-bot.keyd`, account
//!   `owner-pins`, value JSON `{digest, generation}`, the digest of the key
//!   set (pins.rs) and a count keyd raises on every approval.

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
pub const OWNER_PINS_ACCOUNT: &str = "owner-pins";
pub const APP_SERVICE: &str = "agent-bot.keyd.app";

/// The marker on a store error meaning the item is there but is not one keyd
/// controls (#753), as against a keychain that could not be read at all. A
/// caller that can replace the item — `owner/pin` over the daemon key — may
/// treat it as absent; a caller that cannot, fails on it.
const UNTRUSTED_ITEM: &str = "not one agent-bot-keyd controls";

pub fn item(agent_id: &str, app: &str) -> Result<(String, String), &'static str> {
    if !is_agent_id(agent_id) || !is_app_slug(app) {
        return Err("invalid soul or App");
    }
    Ok((
        format!("agent-bot.keyd.{agent_id}"),
        format!("github-app/{app}"),
    ))
}

pub fn app_item(app: &str) -> Result<(String, String), &'static str> {
    if !is_app_slug(app) {
        return Err("invalid App");
    }
    Ok((APP_SERVICE.to_owned(), format!("github-app/{app}")))
}

/// Raw generic-password access; everything above it is shared.
pub trait Items: Send + Sync {
    fn read(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String>;
    /// Atomically adds an absent item; false means it already exists unchanged.
    fn insert(&self, service: &str, account: &str, value: &[u8]) -> Result<bool, String>;
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
        self.read_credential(&service, &account)
    }

    fn read_credential(&self, service: &str, account: &str) -> Result<Option<Credential>, String> {
        match self.items.read(service, account)? {
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
        self.write_credential(&service, &account, credential)
    }

    fn write_credential(
        &self,
        service: &str,
        account: &str,
        credential: &Credential,
    ) -> Result<(), String> {
        let mut value = encode(credential).into_bytes();
        let written = self.items.write(service, account, &value);
        value.fill(0);
        written
    }

    pub fn remove_credential(&self, agent_id: &str, app: &str) -> Result<bool, String> {
        let (service, account) = item(agent_id, app)?;
        self.items.remove(&service, &account)
    }

    /// The App-level key for `app`, whichever soul acts as it.
    pub fn app_credential(&self, app: &str) -> Result<Option<Credential>, String> {
        let (service, account) = app_item(app)?;
        self.read_credential(&service, &account)
    }

    pub fn put_app_credential(&self, app: &str, credential: &Credential) -> Result<(), String> {
        let (service, account) = app_item(app)?;
        self.write_credential(&service, &account, credential)
    }

    pub fn insert_app_credential(&self, app: &str, credential: &Credential) -> Result<(), String> {
        let (service, account) = app_item(app)?;
        let mut value = encode(credential).into_bytes();
        let inserted = self.items.insert(&service, &account, &value);
        value.fill(0);
        if inserted? {
            Ok(())
        } else {
            Err("the App-level key already exists; it was not replaced".into())
        }
    }

    pub fn remove_app_credential(&self, app: &str) -> Result<bool, String> {
        let (service, account) = app_item(app)?;
        self.items.remove(&service, &account)
    }

    pub fn pinned_key(&self) -> Result<Option<[u8; 32]>, String> {
        // An item keyd does not control is no pin at all: nothing verifies
        // against it, `owner/status` reports the daemon as unpinned, and
        // `owner/pin` still asks the owner and writes over it. Reading it as an
        // error instead would wedge the upgrade — the one call that could fix
        // the item would be the one refusing to run.
        let value = match self.items.read(PIN_SERVICE, PIN_ACCOUNT) {
            Ok(value) => value,
            Err(error) if error.contains(UNTRUSTED_ITEM) => None,
            Err(error) => return Err(error),
        };
        let Some(value) = value else {
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

    /// The digest and generation of the key set the owner last approved;
    /// None before the first approval.
    pub fn owner_pins(&self) -> Result<Option<OwnerPins>, String> {
        let Some(value) = self.items.read(PIN_SERVICE, OWNER_PINS_ACCOUNT)? else {
            return Ok(None);
        };
        serde_json::from_slice::<OwnerPins>(&value)
            .ok()
            // Generation 0 means "never approved", which has no record.
            .filter(|record| {
                record.generation > 0
                    && record.digest.len() == 64
                    && record
                        .digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .map(Some)
            .ok_or_else(|| "the owner key record is malformed".to_owned())
    }

    pub fn put_owner_pins(&self, record: &OwnerPins) -> Result<(), String> {
        let value = serde_json::to_vec(record).map_err(|e| e.to_string())?;
        self.items.write(PIN_SERVICE, OWNER_PINS_ACCOUNT, &value)
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerPins {
    pub digest: String,
    pub generation: u64,
}

/// Keychain items whose access list names keyd's own code and nothing else.
/// The crate has no bindings for that, so the Security framework calls are
/// declared here.
///
/// An item made by `SecKeychainAddGenericPassword` — what the crate's
/// `add_generic_password` and `set_generic_password` use — gets the system's
/// default access, and the entry of that default for writing the value trusts
/// *any* application. Any process in this account can then overwrite the item
/// without a prompt, and no entry governs deleting it at all. keyd therefore
/// makes every item itself, through `SecKeychainItemCreateFromContent`, with
/// an access whose every entry is narrowed to keyd's code, and it checks that
/// access again on every read.
///
/// What an access list still cannot do: the legacy file keychain does not gate
/// every operation on one, so a process in this account can still blank or
/// delete an item it cannot read, which makes an overwrite detectable rather
/// than impossible. The check does not prove keyd made the item either — any
/// process can build an access naming keyd's code, so one that deletes an item
/// can plant a replacement this cannot tell from keyd's own. What it does
/// close is reading a value and widening an access list, so what keyd loses is
/// availability, not secrecy, and a value keyd cannot vouch for is refused
/// rather than used. The durable answer is the data-protection keychain under a
/// keychain-access-groups entitlement, which only the signed GeniusBar build
/// can carry.
#[cfg(target_os = "macos")]
pub mod keychain {
    use super::{Items, PIN_SERVICE, UNTRUSTED_ITEM};
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::string::CFString;
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::os::macos::keychain_item::SecKeychainItem;
    use security_framework::os::macos::passwords::{
        find_generic_password, SecKeychainItemPassword,
    };
    use security_framework_sys::base::{
        SecAccessRef, SecKeychainAttribute, SecKeychainAttributeList, SecKeychainItemRef,
        SecKeychainRef,
    };
    use security_framework_sys::keychain::SecKeychainSetUserInteractionAllowed;
    use security_framework_sys::keychain_item::SecKeychainItemModifyAttributesAndData;
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    // Opaque Core Foundation references the sys crate does not name. The
    // aliases keep the declarations below readable as the headers they mirror.
    type CFStringRef = *const c_void;
    type CFArrayRef = *const c_void;
    type CFDataRef = *const c_void;
    type CFTypeRef = *const c_void;
    type SecACLRef = *mut c_void;
    type SecTrustedApplicationRef = *mut c_void;

    const NOT_FOUND: i32 = -25300; // errSecItemNotFound
    const DUPLICATE: i32 = -25299; // errSecDuplicateItem
    const GENERIC_PASSWORD: u32 = 0x6765_6e70; // 'genp'
    const SERVICE: u32 = 0x7376_6365; // 'svce'
    const ACCOUNT: u32 = 0x6163_6374; // 'acct'
    /// What an item's access list says in a keychain dialog.
    const ACCESS_NAME: &str = "agent-bot-keyd";

    extern "C" {
        fn SecTrustedApplicationCreateFromPath(
            path: *const std::os::raw::c_char,
            app: *mut SecTrustedApplicationRef,
        ) -> i32;
        fn SecTrustedApplicationCopyData(
            app: SecTrustedApplicationRef,
            data: *mut CFDataRef,
        ) -> i32;
        fn SecAccessCreate(
            descriptor: CFStringRef,
            trusted: CFArrayRef,
            access: *mut SecAccessRef,
        ) -> i32;
        fn SecAccessCopyACLList(access: SecAccessRef, list: *mut CFArrayRef) -> i32;
        fn SecACLCopyContents(
            acl: SecACLRef,
            apps: *mut CFArrayRef,
            description: *mut CFStringRef,
            prompt: *mut u16,
        ) -> i32;
        fn SecACLSetContents(
            acl: SecACLRef,
            apps: CFArrayRef,
            description: CFStringRef,
            prompt: u16,
        ) -> i32;
        fn SecACLCreateWithSimpleContents(
            access: SecAccessRef,
            apps: CFArrayRef,
            description: CFStringRef,
            prompt: u16,
            acl: *mut SecACLRef,
        ) -> i32;
        fn SecACLUpdateAuthorizations(acl: SecACLRef, authorizations: CFArrayRef) -> i32;
        fn SecKeychainItemCreateFromContent(
            class: u32,
            attributes: *mut SecKeychainAttributeList,
            length: u32,
            data: *const c_void,
            keychain: SecKeychainRef,
            access: SecAccessRef,
            item: *mut SecKeychainItemRef,
        ) -> i32;
        fn SecKeychainItemCopyAccess(item: SecKeychainItemRef, access: *mut SecAccessRef) -> i32;
        // The rights the default access has no entry for at all, so nothing
        // governs them and any process in this account may exercise them.
        static kSecACLAuthorizationDelete: CFStringRef;
        static kSecACLAuthorizationKeychainItemDelete: CFStringRef;
        static kSecACLAuthorizationKeychainItemModify: CFStringRef;
        static kSecACLAuthorizationChangeOwner: CFStringRef;
        static kSecACLAuthorizationChangeACL: CFStringRef;
    }

    /// A keychain dialog is never an answer anyone gave: keyd asks the owner
    /// through LocalAuthentication instead. Turned off once for the process,
    /// because the framework's own guard re-enables interaction when it drops
    /// and keyd serves each connection on a thread, so one call finishing
    /// could open the door again for another in flight.
    fn no_prompts() -> Result<(), String> {
        static DISABLED: OnceLock<i32> = OnceLock::new();
        let status = *DISABLED.get_or_init(|| {
            // SAFETY: one flag in, one status out.
            unsafe { SecKeychainSetUserInteractionAllowed(0) }
        });
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "keychain prompts could not be turned off ({status})"
            ))
        }
    }

    /// This process's own code, as a trusted application an access list can
    /// name.
    fn self_application() -> Result<CFType, String> {
        let mut app: SecTrustedApplicationRef = std::ptr::null_mut();
        // SAFETY: a NULL path asks for this process's own code, and `app` is a
        // valid out-pointer.
        let status = unsafe { SecTrustedApplicationCreateFromPath(std::ptr::null(), &mut app) };
        if status != 0 || app.is_null() {
            return Err(format!("keyd's code identity was not available ({status})"));
        }
        // SAFETY: the new reference is ours, and CFType releases it.
        Ok(unsafe { CFType::wrap_under_create_rule(app as CFTypeRef) })
    }

    /// The record the framework matches a calling process against: keyd's
    /// designated requirement for a signed build, its path for an unsigned one.
    fn code_identity(app: CFTypeRef) -> Option<Vec<u8>> {
        let mut data: CFDataRef = std::ptr::null();
        // SAFETY: a live reference and a valid out-pointer.
        if unsafe { SecTrustedApplicationCopyData(app as _, &mut data) } != 0 || data.is_null() {
            return None;
        }
        // SAFETY: the new data is ours, and CFData releases it.
        Some(unsafe { CFData::wrap_under_create_rule(data as _) }.to_vec())
    }

    /// An access's entries. The array owns them, so it has to outlive the
    /// pointers it hands out.
    fn acl_list(access: SecAccessRef) -> Result<CFArray<*const c_void>, String> {
        let mut list: CFArrayRef = std::ptr::null();
        // SAFETY: a live access and a valid out-pointer.
        let status = unsafe { SecAccessCopyACLList(access, &mut list) };
        if status != 0 || list.is_null() {
            return Err(format!("the keychain access could not be read ({status})"));
        }
        // SAFETY: the new array is ours, and CFArray releases it.
        Ok(unsafe { CFArray::wrap_under_create_rule(list as _) })
    }

    /// Whether one entry names keyd's code and nothing else. An entry open to
    /// any application fails, and so does one that names nobody: the first is
    /// the hole, the second is not an item keyd made.
    fn entry_names_only_keyd(acl: SecACLRef, keyd: &[u8]) -> bool {
        let mut apps: CFArrayRef = std::ptr::null();
        let mut description: CFStringRef = std::ptr::null();
        let mut prompt: u16 = 0;
        // SAFETY: a live entry and valid out-pointers.
        if unsafe { SecACLCopyContents(acl, &mut apps, &mut description, &mut prompt) } != 0 {
            return false;
        }
        if !description.is_null() {
            // SAFETY: the new string is ours, and CFType releases it.
            drop(unsafe { CFType::wrap_under_create_rule(description as CFTypeRef) });
        }
        if apps.is_null() {
            return false;
        }
        // SAFETY: the new array is ours, and CFArray releases it.
        let apps = unsafe { CFArray::<*const c_void>::wrap_under_create_rule(apps as _) };
        let trusted = apps.get_all_values();
        !trusted.is_empty()
            && trusted
                .iter()
                .all(|app| code_identity(*app).as_deref() == Some(keyd))
    }

    /// keyd's code identity, taken once: it cannot change while the process
    /// runs, and every read would otherwise ask the framework for it again.
    fn keyd_identity() -> Option<&'static Vec<u8>> {
        static IDENTITY: OnceLock<Option<Vec<u8>>> = OnceLock::new();
        IDENTITY
            .get_or_init(|| {
                self_application()
                    .ok()
                    .and_then(|app| code_identity(app.as_concrete_TypeRef()))
            })
            .as_ref()
    }

    /// Whether every entry of an item's access list names keyd's code. An item
    /// that cannot be answered for is not trusted: the check is the whole
    /// point, so it fails closed.
    fn access_is_keyd_only(item: &SecKeychainItem) -> bool {
        let Some(keyd) = keyd_identity() else {
            return false;
        };
        let mut access: SecAccessRef = std::ptr::null_mut();
        // SAFETY: a live item and a valid out-pointer.
        let status = unsafe { SecKeychainItemCopyAccess(item.as_concrete_TypeRef(), &mut access) };
        if status != 0 || access.is_null() {
            return false;
        }
        // SAFETY: the new access is ours, and CFType releases it.
        let access = unsafe { CFType::wrap_under_create_rule(access as CFTypeRef) };
        let Ok(list) = acl_list(access.as_concrete_TypeRef() as SecAccessRef) else {
            return false;
        };
        let entries = list.get_all_values();
        !entries.is_empty()
            && entries
                .iter()
                .all(|acl| entry_names_only_keyd(*acl as SecACLRef, keyd))
    }

    /// An access for a new item: every entry the system's default
    /// configuration makes, narrowed to keyd's code, plus one for the rights
    /// the default leaves ungoverned.
    fn locked_access() -> Result<CFType, String> {
        let app = self_application()?;
        let trusted = CFArray::<*const c_void>::from_copyable(&[app.as_concrete_TypeRef()]);
        let name = CFString::new(ACCESS_NAME);
        let mut access: SecAccessRef = std::ptr::null_mut();
        // SAFETY: live references and a valid out-pointer.
        let status = unsafe {
            SecAccessCreate(
                name.as_concrete_TypeRef() as CFStringRef,
                trusted.as_concrete_TypeRef() as CFArrayRef,
                &mut access,
            )
        };
        if status != 0 || access.is_null() {
            return Err(format!("the keychain access could not be made ({status})"));
        }
        // SAFETY: the new access is ours, and CFType releases it.
        let access = unsafe { CFType::wrap_under_create_rule(access as CFTypeRef) };
        let raw = access.as_concrete_TypeRef() as SecAccessRef;

        // The default leaves the right to write the value open to any
        // application, so narrow every entry it made.
        let made = acl_list(raw)?;
        for acl in made.get_all_values() {
            // SAFETY: live references.
            let status = unsafe {
                SecACLSetContents(
                    acl as SecACLRef,
                    trusted.as_concrete_TypeRef() as CFArrayRef,
                    name.as_concrete_TypeRef() as CFStringRef,
                    0,
                )
            };
            if status != 0 {
                return Err(format!(
                    "the keychain access could not be locked ({status})"
                ));
            }
        }

        // Deleting and changing an item answer to no entry at all, so add one
        // for them, keyd's alone.
        // SAFETY: framework constants, valid for the process lifetime.
        let rights: Vec<CFStringRef> = unsafe {
            vec![
                kSecACLAuthorizationDelete,
                kSecACLAuthorizationKeychainItemDelete,
                kSecACLAuthorizationKeychainItemModify,
                kSecACLAuthorizationChangeOwner,
                kSecACLAuthorizationChangeACL,
            ]
        };
        let authorizations = CFArray::<*const c_void>::from_copyable(&rights);
        let mut entry: SecACLRef = std::ptr::null_mut();
        // SAFETY: live references and a valid out-pointer.
        let status = unsafe {
            SecACLCreateWithSimpleContents(
                raw,
                trusted.as_concrete_TypeRef() as CFArrayRef,
                name.as_concrete_TypeRef() as CFStringRef,
                0,
                &mut entry,
            )
        };
        if status != 0 || entry.is_null() {
            return Err(format!(
                "the keychain access could not be locked ({status})"
            ));
        }
        // SAFETY: the new entry is ours, and CFType releases it.
        let entry = unsafe { CFType::wrap_under_create_rule(entry as CFTypeRef) };
        // SAFETY: live references.
        let status = unsafe {
            SecACLUpdateAuthorizations(
                entry.as_concrete_TypeRef() as SecACLRef,
                authorizations.as_concrete_TypeRef() as CFArrayRef,
            )
        };
        if status != 0 {
            return Err(format!(
                "the keychain access could not be locked ({status})"
            ));
        }
        Ok(access)
    }

    enum Made {
        Item,
        Duplicate,
    }

    /// Makes an item under a locked access. `SecKeychainItemCreateFromContent`
    /// refuses an item that is already there, which is what makes `insert`
    /// atomic.
    fn create(
        keychain: &SecKeychain,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<Made, String> {
        create_with(keychain, &locked_access()?, service, account, value)
    }

    /// The same, under an access built beforehand: a caller that has already
    /// destroyed the item it is replacing wants no failure left before the
    /// create itself.
    fn create_with(
        keychain: &SecKeychain,
        access: &CFType,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<Made, String> {
        let service = service.as_bytes();
        let account = account.as_bytes();
        let mut attributes = [
            SecKeychainAttribute {
                tag: SERVICE,
                length: service.len() as u32,
                data: service.as_ptr() as *mut c_void,
            },
            SecKeychainAttribute {
                tag: ACCOUNT,
                length: account.len() as u32,
                data: account.as_ptr() as *mut c_void,
            },
        ];
        let mut list = SecKeychainAttributeList {
            count: attributes.len() as u32,
            attr: attributes.as_mut_ptr(),
        };
        let mut item: SecKeychainItemRef = std::ptr::null_mut();
        // SAFETY: live references, our own bytes, and valid out-pointers. The
        // attribute data outlives the call.
        let status = unsafe {
            SecKeychainItemCreateFromContent(
                GENERIC_PASSWORD,
                &mut list,
                value.len() as u32,
                value.as_ptr() as *const c_void,
                keychain.as_concrete_TypeRef(),
                access.as_concrete_TypeRef() as SecAccessRef,
                &mut item,
            )
        };
        if !item.is_null() {
            // SAFETY: the new item is ours, and CFType releases it.
            drop(unsafe { CFType::wrap_under_create_rule(item as CFTypeRef) });
        }
        match status {
            0 => Ok(Made::Item),
            DUPLICATE => Ok(Made::Duplicate),
            status => Err(format!("the keychain item could not be added ({status})")),
        }
    }

    /// Replaces an item's value in place, keeping its access list. Only an
    /// item `access_is_keyd_only` has vouched for reaches here; `replace` is
    /// what decides that, and it re-makes anything else instead.
    fn modify(item: &SecKeychainItem, value: &[u8]) -> Result<(), i32> {
        // SAFETY: a live item and our own bytes. A NULL attribute list leaves
        // the item's attributes, and so its access list, as they are.
        let status = unsafe {
            SecKeychainItemModifyAttributesAndData(
                item.as_concrete_TypeRef(),
                std::ptr::null(),
                value.len() as u32,
                value.as_ptr() as *const c_void,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(status)
        }
    }

    /// Writes over an item that is already there: in place when keyd controls
    /// it, and by replacing it when keyd does not.
    fn replace(
        keychain: &SecKeychain,
        service: &str,
        account: &str,
        item: SecKeychainItem,
        value: &[u8],
    ) -> Result<(), String> {
        if access_is_keyd_only(&item) {
            return modify(&item, value)
                .map_err(|status| format!("the keychain item could not be written ({status})"));
        }
        // Never write through an item keyd does not control: its access may let
        // any process in this account change the value, and writing would leave
        // that in place. Replace it with one keyd made — building the access
        // first, since until the create lands this item is the only copy of the
        // value, and for a legacy App key that value is a key the owner
        // imported.
        let access = locked_access()?;
        item.delete();
        match create_with(keychain, &access, service, account, value) {
            Ok(Made::Item) => Ok(()),
            Ok(Made::Duplicate) => {
                Err("the keychain item could not be written (another took its place)".into())
            }
            Err(error) => {
                // Put an App key back rather than lose it. It goes back
                // unlocked, which is the state it was found in. A pin is not
                // put back: an unlocked pin is one keyd refuses anyway, so
                // leaving it absent keeps the failure closed.
                if recreatable(service) {
                    let _ = keychain.add_generic_password(service, account, value);
                }
                Err(error)
            }
        }
    }

    /// An App key is recoverable: its value is a key the owner imported, not
    /// something agent-bot pinned. Everything under `PIN_SERVICE` — the daemon
    /// grant key, the presence seed and the owner's statement pins — is what
    /// agent-bot trusts, so an item keyd does not control is not a value keyd
    /// may hand back. Keying on the service keeps a pin account added later
    /// refused by default rather than trusted by default.
    fn recreatable(service: &str) -> bool {
        service != PIN_SERVICE
    }

    fn untrusted(account: &str) -> String {
        format!(
            "the keychain item for {account} is {UNTRUSTED_ITEM}: any process in this account can change it, so its value was refused"
        )
    }

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

        fn find(
            &self,
            keychain: &SecKeychain,
            service: &str,
            account: &str,
        ) -> Result<Option<(SecKeychainItemPassword, SecKeychainItem)>, String> {
            match find_generic_password(Some(std::slice::from_ref(keychain)), service, account) {
                Ok(found) => Ok(Some(found)),
                Err(error) if error.code() == NOT_FOUND => Ok(None),
                Err(error) => Err(format!("the keychain could not be read ({})", error.code())),
            }
        }

        /// Whether the item at `service`/`account` is one keyd controls, which
        /// is what the access-list tests assert.
        #[cfg(test)]
        pub(crate) fn trusts_only_keyd(
            &self,
            service: &str,
            account: &str,
        ) -> Result<bool, String> {
            no_prompts()?;
            let keychain = self.open()?;
            let Some((_, item)) = self.find(&keychain, service, account)? else {
                return Ok(false);
            };
            Ok(access_is_keyd_only(&item))
        }
    }

    impl Items for Keychain {
        fn read(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
            no_prompts()?;
            let keychain = self.open()?;
            let Some((password, item)) = self.find(&keychain, service, account)? else {
                return Ok(None);
            };
            if access_is_keyd_only(&item) {
                return Ok(Some(password.to_vec()));
            }
            // An item from before the access list was locked, or one another
            // process planted. Either way keyd did not make it.
            if !recreatable(service) {
                return Err(untrusted(account));
            }
            let value = password.to_vec();
            drop(password);
            replace(&keychain, service, account, item, &value)?;
            Ok(Some(value))
        }

        fn write(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
            no_prompts()?;
            let keychain = self.open()?;
            if let Some((_, item)) = self.find(&keychain, service, account)? {
                return replace(&keychain, service, account, item, value);
            }
            match create(&keychain, service, account, value)? {
                Made::Item => Ok(()),
                // Another caller made one between the look-up and the create.
                Made::Duplicate => match self.find(&keychain, service, account)? {
                    Some((_, item)) => replace(&keychain, service, account, item, value),
                    None => Err("the keychain item could not be written".into()),
                },
            }
        }

        fn insert(&self, service: &str, account: &str, value: &[u8]) -> Result<bool, String> {
            no_prompts()?;
            let keychain = self.open()?;
            // Never write over an existing item here: that would replace a late
            // item another caller made.
            Ok(matches!(
                create(&keychain, service, account, value)?,
                Made::Item
            ))
        }

        fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
            no_prompts()?;
            let keychain = self.open()?;
            match self.find(&keychain, service, account)? {
                Some((_, item)) => {
                    item.delete();
                    Ok(true)
                }
                None => Ok(false),
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    type MemoryItems = HashMap<(String, String), Vec<u8>>;

    #[derive(Clone, Default)]
    pub struct Memory(pub Arc<Mutex<MemoryItems>>);

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
        fn insert(&self, service: &str, account: &str, value: &[u8]) -> Result<bool, String> {
            let mut items = self.0.lock().unwrap();
            match items.entry((service.into(), account.into())) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(value.to_vec());
                    Ok(true)
                }
                std::collections::hash_map::Entry::Occupied(_) => Ok(false),
            }
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
        assert!(store.owner_pins().unwrap().is_none());
        let record = OwnerPins {
            digest: "a".repeat(64),
            generation: 2,
        };
        store.put_owner_pins(&record).unwrap();
        assert_eq!(store.owner_pins().unwrap(), Some(record));
        store
            .items
            .write(
                PIN_SERVICE,
                OWNER_PINS_ACCOUNT,
                br#"{"digest":"zz","generation":1}"#,
            )
            .unwrap();
        assert!(
            store.owner_pins().is_err(),
            "a bad record is an error, not none"
        );
        store
            .put_owner_pins(&OwnerPins {
                digest: "a".repeat(64),
                generation: 0,
            })
            .unwrap();
        assert!(
            store.owner_pins().is_err(),
            "a stored record is an approval"
        );
        assert!(store.credential("agent_../x", "qwts-claude-agent").is_err());

        // An App-level key is its own item: a soul's key never answers for
        // it, and it never answers for a soul.
        store
            .put_credential(AGENT, "qwts-claude-agent", &credential)
            .unwrap();
        assert!(store.app_credential("qwts-claude-agent").unwrap().is_none());
        let app_key = Credential {
            app_id: "123".into(),
            private_key_pem: "APP-PEM".into(),
        };
        store
            .insert_app_credential("qwts-claude-agent", &credential)
            .unwrap();
        assert!(store
            .insert_app_credential("qwts-claude-agent", &app_key)
            .is_err());
        assert_eq!(
            store
                .app_credential("qwts-claude-agent")
                .unwrap()
                .unwrap()
                .private_key_pem,
            "PEM",
            "create-only never replaces an existing item"
        );
        assert!(store.remove_app_credential("qwts-claude-agent").unwrap());
        store
            .put_app_credential("qwts-claude-agent", &app_key)
            .unwrap();
        assert_eq!(
            store
                .app_credential("qwts-claude-agent")
                .unwrap()
                .unwrap()
                .private_key_pem,
            "APP-PEM"
        );
        assert_eq!(
            store
                .credential(AGENT, "qwts-claude-agent")
                .unwrap()
                .unwrap()
                .private_key_pem,
            "PEM"
        );
        assert!(store.remove_app_credential("qwts-claude-agent").unwrap());
        assert!(!store.remove_app_credential("qwts-claude-agent").unwrap());
        assert!(
            store
                .credential(AGENT, "qwts-claude-agent")
                .unwrap()
                .is_some(),
            "removing the App key leaves the soul's"
        );
        assert!(store.remove_credential(AGENT, "qwts-claude-agent").unwrap());
        assert!(store.app_credential("../x").is_err());
    }

    #[test]
    fn memory_store_round_trips() {
        exercise(&Store::new(Box::<Memory>::default()));
    }

    #[test]
    fn simultaneous_create_only_writes_have_one_winner() {
        let items = Memory::default();
        let start = Arc::new(std::sync::Barrier::new(8));
        let writers: Vec<_> = (0..8)
            .map(|i| {
                let items = items.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    items
                        .insert(APP_SERVICE, "github-app/test-app", &[i])
                        .unwrap()
                })
            })
            .collect();
        let winners = writers
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
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

    /// Tests that open a real keychain run only with KEYD_KEYCHAIN_TESTS=1,
    /// which CI's macOS job sets (agent-bot-identity #753). A run on someone's
    /// Mac without it never touches a keychain, so it can never put a
    /// keychain prompt in front of them.
    #[cfg(target_os = "macos")]
    pub(crate) fn keychain_tests_enabled() -> bool {
        let enabled = std::env::var("KEYD_KEYCHAIN_TESTS").as_deref() == Ok("1");
        if !enabled {
            eprintln!("skipped: set KEYD_KEYCHAIN_TESTS=1 to run keychain tests");
        }
        enabled
    }

    /// A real keychain, in a file of its own under a temporary directory: the
    /// login keychain is never opened. Creating a keychain adds it to this
    /// user's search list, and deleting it removes it again — whether or not
    /// `body` panics, since a keychain left in the search list is a dialog
    /// waiting for a password nobody owes it.
    #[cfg(target_os = "macos")]
    pub(crate) fn with_temporary_keychain(body: impl FnOnce(&std::path::Path)) {
        use security_framework::os::macos::keychain::CreateOptions;
        let dir = crate::paths::tests::short_temp_dir("kc");
        let path = dir.join("keyd-test.keychain-db");
        let keychain = CreateOptions::new()
            .password("keyd-test")
            .create(&path)
            .unwrap();
        let mut unlocked = keychain.clone();
        unlocked.unlock(Some("keyd-test")).unwrap();
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(path.as_path())));
        delete_keychain(&keychain);
        let _ = std::fs::remove_dir_all(&dir);
        result.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_store_round_trips_in_a_temporary_keychain() {
        if !keychain_tests_enabled() {
            return;
        }
        with_temporary_keychain(|path| {
            exercise(&Store::new(Box::new(keychain::Keychain::at(
                path.to_path_buf(),
            ))));
        });
    }

    /// Every entry of a keyd item's access list names keyd's own code, so no
    /// other process in this account can write the value or widen the access
    /// (agent-bot-identity #753). An item made the way the framework's default
    /// makes one does not: its write right is open to any application.
    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_items_trust_only_keyd() {
        if !keychain_tests_enabled() {
            return;
        }
        with_temporary_keychain(|path| {
            use security_framework::os::macos::keychain::SecKeychain;
            let items = keychain::Keychain::at(path.to_path_buf());
            let keychain = SecKeychain::open(path).unwrap();

            // Every item keyd makes is locked, whichever service it is under.
            for (service, account) in [
                (PIN_SERVICE, PRESENCE_ACCOUNT),
                (PIN_SERVICE, PIN_ACCOUNT),
                (PIN_SERVICE, OWNER_PINS_ACCOUNT),
                (APP_SERVICE, "github-app/test-app"),
            ] {
                items.write(service, account, b"value").unwrap();
                assert!(
                    items.trusts_only_keyd(service, account).unwrap(),
                    "{service}/{account} should name only keyd"
                );
                assert_eq!(
                    items.read(service, account).unwrap().as_deref(),
                    Some(b"value".as_slice()),
                    "keyd still reads what it made"
                );
            }

            // An App key from before the lock is one any process in this
            // account can write. Reading it re-makes it, value and all, so an
            // owner's imported key survives the upgrade.
            let legacy_app = "github-app/legacy";
            keychain
                .add_generic_password(APP_SERVICE, legacy_app, b"legacy")
                .unwrap();
            assert!(
                !items.trusts_only_keyd(APP_SERVICE, legacy_app).unwrap(),
                "the framework's default access lets any application write"
            );
            assert_eq!(
                items.read(APP_SERVICE, legacy_app).unwrap().as_deref(),
                Some(b"legacy".as_slice())
            );
            assert!(
                items.trusts_only_keyd(APP_SERVICE, legacy_app).unwrap(),
                "re-made under the lock, with the same value"
            );

            // A pin from before the lock is refused instead: its value is what
            // agent-bot trusts, so keyd neither hands back one it cannot vouch
            // for nor quietly makes another. Every account under `PIN_SERVICE`
            // is such a pin, the owner's statement keys included.
            for account in [PRESENCE_ACCOUNT, PIN_ACCOUNT, OWNER_PINS_ACCOUNT] {
                items.remove(PIN_SERVICE, account).unwrap();
                keychain
                    .add_generic_password(PIN_SERVICE, account, b"legacy")
                    .unwrap();
                assert!(
                    !items.trusts_only_keyd(PIN_SERVICE, account).unwrap(),
                    "{account} should be an item keyd did not make"
                );
                let refused = items.read(PIN_SERVICE, account);
                assert!(refused.is_err(), "an untrusted {account} is not read");
                assert!(
                    refused
                        .unwrap_err()
                        .contains("not one agent-bot-keyd controls"),
                    "and the refusal says why"
                );
            }
        });
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
