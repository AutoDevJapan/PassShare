//! Client-only WASM boundary. No filesystem, HTTP, logging or raw-key export.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use passshare_core::{
    cloud_crypto::{
        EncryptedItem, ItemContext, OwnerKeyContext, PasswordBoxKey, WrappedPasswordBoxKey,
    },
    crypto::{derive_master_key_with_params, generate_salt, MasterKey},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

mod attachment;
mod item_edit;
mod recovery;
mod shared;
pub use shared::CloudAccountIdentity;
mod worker;

const INVALID: &str = "PS051: Invalid encrypted data";
const LOCKED: &str = "PS057: Password box is locked";
const MAX_BODY: usize = 1024 * 1024;
const MAX_ENVELOPE: usize = 1_500_000;
// Owner bundle format 1 must remain readable when Core defaults change.
const BUNDLE_MEMORY_KIB: u32 = 65_536;
const BUNDLE_TIME: u32 = 3;
const BUNDLE_PARALLELISM: u32 = 4;
fn derive_root(password: &str, salt: &[u8]) -> Result<MasterKey, &'static str> {
    derive_master_key_with_params(
        password,
        salt,
        BUNDLE_MEMORY_KIB,
        BUNDLE_TIME,
        BUNDLE_PARALLELISM,
    )
    .map_err(|_| INVALID)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerBundle {
    format: u32,
    salt: String,
    wrapped: WrappedPasswordBoxKey,
}

// Values parsed from client plaintext are erased after serialization/encryption.
// JavaScript owns its input/output strings and must clear its own UI state.
struct Plaintext(Value);
fn erase(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(erase),
        Value::Object(o) => {
            for (mut key, mut value) in std::mem::take(o) {
                key.zeroize();
                erase(&mut value);
            }
        }
        _ => *value = Value::Null,
    }
}
impl Drop for Plaintext {
    fn drop(&mut self) {
        erase(&mut self.0);
    }
}

fn parse<T: serde::de::DeserializeOwned>(value: &str, limit: usize) -> Result<T, &'static str> {
    if value.len() > limit {
        return Err(INVALID);
    }
    serde_json::from_str(value).map_err(|_| INVALID)
}
fn owner(value: &str) -> Result<OwnerKeyContext, &'static str> {
    let context: OwnerKeyContext = parse(value, 512)?;
    // Validate the same context even before any key is allocated.
    passshare_core::ConnectId::validate(context.password_box_id.as_str()).map_err(|_| INVALID)?;
    if context.owner_account_id.is_nil()
        || context.key_epoch == 0
        || context.key_epoch > 9_007_199_254_740_991
    {
        return Err(INVALID);
    }
    Ok(context)
}
fn password(value: String) -> Result<Zeroizing<String>, &'static str> {
    let value = Zeroizing::new(value);
    if value.len() > 1024 {
        return Err(INVALID);
    }
    let size = value.nfc().map(char::len_utf8).sum();
    let mut normalized = Zeroizing::new(String::with_capacity(size));
    normalized.extend(value.nfc());
    if normalized.chars().count() < 8 {
        return Err(INVALID);
    }
    Ok(normalized)
}

struct Session {
    key: Option<PasswordBoxKey>,
    owner: OwnerKeyContext,
    can_wrap_owner: bool,
}
impl Session {
    fn generate(context: &str) -> Result<Self, &'static str> {
        let owner = owner(context)?;
        let key = PasswordBoxKey::generate().map_err(|_| INVALID)?;
        Ok(Self {
            key: Some(key),
            owner,
            can_wrap_owner: true,
        })
    }
    fn unlock(bundle: &str, secret: String, expected: &str) -> Result<Self, &'static str> {
        let secret = password(secret)?;
        let owner = owner(expected)?;
        let bundle: OwnerBundle = parse(bundle, 2048)?;
        if bundle.format != 1 || bundle.wrapped.context != owner {
            return Err(INVALID);
        }
        let salt = B64.decode(bundle.salt).map_err(|_| INVALID)?;
        if salt.len() != 16 {
            return Err(INVALID);
        }
        let root = derive_root(&secret, &salt)?;
        let key = PasswordBoxKey::unwrap_for_owner(&bundle.wrapped, &root, &owner)
            .map_err(|_| INVALID)?;
        Ok(Self {
            key: Some(key),
            owner,
            can_wrap_owner: true,
        })
    }
    fn key(&self) -> Result<&PasswordBoxKey, &'static str> {
        self.key.as_ref().ok_or(LOCKED)
    }
    fn context(&self, value: &str) -> Result<ItemContext, &'static str> {
        let context: ItemContext = parse(value, 512)?;
        if context.password_box_id != self.owner.password_box_id
            || context.key_epoch != self.owner.key_epoch
        {
            return Err(INVALID);
        }
        Ok(context)
    }
    fn wrap(&self, secret: String) -> Result<String, &'static str> {
        let secret = password(secret)?;
        let key = self.key()?;
        if !self.can_wrap_owner {
            return Err(INVALID);
        }
        let salt = generate_salt().map_err(|_| INVALID)?;
        let root = derive_root(&secret, &salt)?;
        let wrapped = key
            .wrap_for_owner(&root, &self.owner)
            .map_err(|_| INVALID)?;
        serde_json::to_string(&OwnerBundle {
            format: 1,
            salt: B64.encode(salt),
            wrapped,
        })
        .map_err(|_| INVALID)
    }
    fn encrypt(&self, item: String, expected: &str) -> Result<String, &'static str> {
        let input = Zeroizing::new(item);
        let context = self.context(expected)?;
        let item = Plaintext(parse(&input, MAX_BODY)?);
        let envelope = self
            .key()?
            .encrypt_item(&item.0, &context)
            .map_err(|_| INVALID)?;
        serde_json::to_string(&envelope).map_err(|_| INVALID)
    }
    fn decrypt(&self, envelope: &str, expected: &str) -> Result<Zeroizing<String>, &'static str> {
        let context = self.context(expected)?;
        let envelope: EncryptedItem = parse(envelope, MAX_ENVELOPE)?;
        let item = Plaintext(
            self.key()?
                .decrypt_item(&envelope, &context)
                .map_err(|_| INVALID)?,
        );
        serialize_plaintext(&item.0)
    }
    fn lock(&mut self) {
        self.key = None;
    }
}

fn serialize_plaintext(value: &Value) -> Result<Zeroizing<String>, &'static str> {
    struct Size(usize);
    impl std::io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_BODY {
                return Err(std::io::Error::other("plaintext size limit"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut size = Size(0);
    serde_json::to_writer(&mut size, value).map_err(|_| INVALID)?;
    // Exact capacity avoids leaving previous plaintext allocations behind.
    let mut bytes = Zeroizing::new(Vec::with_capacity(size.0));
    serde_json::to_writer(&mut *bytes, value).map_err(|_| INVALID)?;
    String::from_utf8(std::mem::take(&mut *bytes))
        .map(Zeroizing::new)
        .map_err(|error| {
            error.into_bytes().zeroize();
            INVALID
        })
}

#[wasm_bindgen]
pub struct CloudPasswordBox {
    session: Session,
}
#[wasm_bindgen]
impl CloudPasswordBox {
    #[wasm_bindgen(constructor)]
    pub fn new(owner_context: &str) -> Result<CloudPasswordBox, JsValue> {
        Session::generate(owner_context)
            .map(|session| Self { session })
            .map_err(JsValue::from_str)
    }
    pub fn unlock(
        bundle: &str,
        encryption_password: String,
        expected_owner: &str,
    ) -> Result<CloudPasswordBox, JsValue> {
        Session::unlock(bundle, encryption_password, expected_owner)
            .map(|session| Self { session })
            .map_err(JsValue::from_str)
    }
    pub fn wrap_for_owner(&self, encryption_password: String) -> Result<String, JsValue> {
        self.session
            .wrap(encryption_password)
            .map_err(JsValue::from_str)
    }
    pub fn encrypt_item(&self, item: String, expected_context: &str) -> Result<String, JsValue> {
        self.session
            .encrypt(item, expected_context)
            .map_err(JsValue::from_str)
    }
    pub fn decrypt_item(&self, envelope: &str, expected_context: &str) -> Result<JsValue, JsValue> {
        let plaintext = self
            .session
            .decrypt(envelope, expected_context)
            .map_err(JsValue::from_str)?;
        Ok(JsValue::from_str(&plaintext))
    }
    pub fn lock(&mut self) {
        self.session.lock();
    }
    pub fn is_locked(&self) -> bool {
        self.session.key.is_none()
    }
}

#[wasm_bindgen]
extern "C" {
    type DedicatedWorkerGlobalScope;
    type MessageEvent;
    #[wasm_bindgen(thread_local_v2, js_name = globalThis)]
    static GLOBAL: JsValue;
    #[wasm_bindgen(method, setter, js_name = onmessage)]
    fn set_onmessage(this: &DedicatedWorkerGlobalScope, handler: &JsValue);
    #[wasm_bindgen(method, js_name = postMessage)]
    fn post_message(this: &DedicatedWorkerGlobalScope, message: &JsValue);
    #[wasm_bindgen(method, js_name = postMessage)]
    fn post_message_transfer(
        this: &DedicatedWorkerGlobalScope,
        message: &JsValue,
        transfer: &JsValue,
    );
    #[wasm_bindgen(method, getter)]
    fn data(this: &MessageEvent) -> JsValue;
}
thread_local! {
    static STARTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Attaches the message dispatcher. Only a DedicatedWorkerGlobalScope may call this
/// successfully; importing the module elsewhere registers nothing and creates no key.
/// A `ready` reply (requestId null, ok true) is posted once the listener is attached.
#[wasm_bindgen]
pub fn start_worker() -> Result<(), JsValue> {
    let scope: DedicatedWorkerGlobalScope = GLOBAL
        .with(|global| global.clone())
        .dyn_into()
        .map_err(|_| JsValue::from_str("PS060: Not a dedicated worker"))?;
    if STARTED.replace(true) {
        return Err(JsValue::from_str("PS060: Worker already started"));
    }
    let mut worker = worker::WorkerSession::new();
    let ready = worker.ready();
    let replies: DedicatedWorkerGlobalScope =
        <DedicatedWorkerGlobalScope as AsRef<JsValue>>::as_ref(&scope)
            .clone()
            .unchecked_into();
    let handler = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
        let (reply, transfers) = attachment::exchange(&mut worker, event.data());
        replies.post_message_transfer(&reply, &transfers);
    });
    scope.set_onmessage(handler.as_ref());
    handler.forget();
    scope.post_message(&JsValue::from_str(&ready));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (String, String, String) {
        let owner = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1}).to_string();
        let context = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1}).to_string();
        let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"title":"Synthetic title","fields":[{"value":"Client-only synthetic secret"}],"extra":{"keep":[1,2,3]},"urls":[{"href":"https://example.test/one"},{"href":"https://example.test/two"}]}).to_string();
        (owner, context, item)
    }
    #[test]
    fn whole_json_context_nonces_and_lock_are_enforced() {
        let (owner, context, item) = fixture();
        let mut session = Session::generate(&owner).unwrap();
        let envelope = session.encrypt(item.clone(), &context).unwrap();
        assert!(!envelope.contains("Client-only") && !envelope.contains("Synthetic title"));
        assert_ne!(envelope, session.encrypt(item.clone(), &context).unwrap());
        assert_eq!(
            parse::<Value>(&session.decrypt(&envelope, &context).unwrap(), MAX_BODY).unwrap(),
            parse::<Value>(&item, MAX_BODY).unwrap()
        );
        assert!(session
            .decrypt(
                &envelope,
                &context.replace("\"itemVersion\":1", "\"itemVersion\":2")
            )
            .is_err());
        assert!(session
            .encrypt(
                item.clone(),
                &context.replace("\"keyEpoch\":1", "\"keyEpoch\":2")
            )
            .is_err());
        session.lock();
        assert_eq!(session.encrypt(item, &context), Err(LOCKED));
        assert_eq!(session.decrypt(&envelope, &context).unwrap_err(), LOCKED);
        assert_eq!(session.wrap("Synthetic password!".into()), Err(LOCKED));
    }
    #[test]
    fn owner_bundle_survives_key_drop_and_rejects_wrong_password_or_owner() {
        let (owner, context, item) = fixture();
        let session = Session::generate(&owner).unwrap();
        let encrypted = session.encrypt(item.clone(), &context).unwrap();
        let bundle = session
            .wrap("Synthetic encryption password!".into())
            .unwrap();
        drop(session);
        let restored =
            Session::unlock(&bundle, "Synthetic encryption password!".into(), &owner).unwrap();
        assert_eq!(
            parse::<Value>(&restored.decrypt(&encrypted, &context).unwrap(), MAX_BODY).unwrap(),
            parse::<Value>(&item, MAX_BODY).unwrap()
        );
        assert!(Session::unlock(&bundle, "Different synthetic password!".into(), &owner).is_err());
        assert!(Session::unlock(
            &bundle,
            "Synthetic encryption password!".into(),
            &owner.replace("11111111", "22222222")
        )
        .is_err());
    }
    #[test]
    fn unknown_fields_oversized_input_and_plaintext_cleanup_are_checked() {
        let (owner, context, item) = fixture();
        let session = Session::generate(&owner).unwrap();
        assert!(session.encrypt("x".repeat(MAX_BODY + 1), &context).is_err());
        assert!(session
            .decrypt(&format!("{{\"plaintext\":{item}}}"), &context)
            .is_err());
        assert!(Session::generate(&owner.replace("\"keyEpoch\":1", "\"keyEpoch\":0")).is_err());
        let mut value = json!({"synthetic secret key":[{"secret":"Synthetic value"}]});
        erase(&mut value);
        assert_eq!(value, json!({}));
    }
    #[test]
    fn fixed_format1_vector_and_unicode_password_remain_readable() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/format1-vector.json")).unwrap();
        let session = Session::unlock(
            &fixture["bundle"].to_string(),
            "Synthetic format1 e\u{301} password!".into(),
            &fixture["owner"].to_string(),
        )
        .unwrap();
        let body = session
            .decrypt(
                &fixture["envelope"].to_string(),
                &fixture["context"].to_string(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            fixture["item"]
        );
    }
}
