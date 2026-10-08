//! Client-only envelopes. Keys have no serialization interface. Network/storage
//! receive ciphertext, public routing context and fresh nonces only.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Write};
use thiserror::Error;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{crypto::MasterKey, ConnectId};

mod shared_keys;
pub use shared_keys::{
    AccountIdentity, AccountIdentityContext, PublicAccountIdentity, SharedKeyContext,
    WrappedAccountIdentity, WrappedSharedPasswordBoxKey, SHARED_KEY_SUITE,
};

const FORMAT: u32 = 1;
const MAX_ITEM_BYTES: usize = 1024 * 1024;
const TAG_BYTES: usize = 16;
const MAX_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_JSON_DEPTH: usize = 127;

struct JsonSize(usize);
impl Write for JsonSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let size = self.0.saturating_add(bytes.len());
        if size > MAX_ITEM_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Item exceeds the encryption limit",
            ));
        }
        self.0 = size;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

type JsonChildren<'a> = Box<dyn Iterator<Item = &'a Value> + 'a>;
fn validate_depth(root: &Value) -> Result<()> {
    let mut frames: Vec<JsonChildren<'_>> = vec![Box::new(std::iter::once(root))];
    let mut visited = 0usize;
    while let Some(frame) = frames.last_mut() {
        let Some(value) = frame.next() else {
            frames.pop();
            continue;
        };
        visited += 1;
        if visited > MAX_ITEM_BYTES {
            return Err(CloudCryptoError::InvalidPayload);
        }
        let children: Option<JsonChildren<'_>> = match value {
            Value::Array(array) => Some(Box::new(array.iter())),
            Value::Object(object) => Some(Box::new(object.values())),
            _ => None,
        };
        if let Some(children) = children {
            if frames.len() > MAX_JSON_DEPTH {
                return Err(CloudCryptoError::InvalidPayload);
            }
            frames.push(children);
        }
    }
    Ok(())
}

struct LimitedJson(Zeroizing<Vec<u8>>);
impl Write for LimitedJson {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_ITEM_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Item exceeds the encryption limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CloudCryptoError {
    #[error("PS050: 暗号化する項目の識別子や版が正しくありません")]
    InvalidContext,
    #[error("PS051: 暗号化データの形式が正しくありません")]
    InvalidEnvelope,
    #[error("PS052: 暗号化データの確認に失敗しました")]
    AuthenticationFailed,
    #[error("PS053: 暗号化する項目の形式や大きさが正しくありません")]
    InvalidPayload,
    #[error("PS054: 暗号化に必要な乱数を生成できません")]
    EntropyUnavailable,
}
type Result<T> = std::result::Result<T, CloudCryptoError>;

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct PasswordBoxKey([u8; 32]);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemContext {
    pub password_box_id: ConnectId,
    pub item_id: ConnectId,
    pub item_version: u64,
    pub key_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerKeyContext {
    pub password_box_id: ConnectId,
    pub owner_account_id: Uuid,
    pub key_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedItem {
    pub format: u32,
    pub context: ItemContext,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WrappedPasswordBoxKey {
    pub format: u32,
    pub context: OwnerKeyContext,
    pub nonce: String,
    pub ciphertext: String,
}

impl ItemContext {
    fn validate(&self) -> Result<()> {
        ConnectId::validate(self.password_box_id.as_str())
            .map_err(|_| CloudCryptoError::InvalidContext)?;
        ConnectId::validate(self.item_id.as_str()).map_err(|_| CloudCryptoError::InvalidContext)?;
        if !(1..=MAX_JSON_INTEGER).contains(&self.item_version)
            || !(1..=MAX_JSON_INTEGER).contains(&self.key_epoch)
        {
            return Err(CloudCryptoError::InvalidContext);
        }
        Ok(())
    }
    fn aad(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec(&("passshare.cloud.item", FORMAT, self))
            .map_err(|_| CloudCryptoError::InvalidContext)
    }
}
impl OwnerKeyContext {
    fn aad(&self) -> Result<Vec<u8>> {
        ConnectId::validate(self.password_box_id.as_str())
            .map_err(|_| CloudCryptoError::InvalidContext)?;
        if !(1..=MAX_JSON_INTEGER).contains(&self.key_epoch) || self.owner_account_id.is_nil() {
            return Err(CloudCryptoError::InvalidContext);
        }
        serde_json::to_vec(&("passshare.cloud.owner-key", FORMAT, self))
            .map_err(|_| CloudCryptoError::InvalidContext)
    }
}

fn seal(bytes: &[u8], key: &[u8; 32], aad: &[u8]) -> Result<(String, String)> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| CloudCryptoError::EntropyUnavailable)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    let ciphertext = cipher
        .encrypt(&XNonce::from(nonce), Payload { msg: bytes, aad })
        .map_err(|_| CloudCryptoError::AuthenticationFailed)?;
    Ok((BASE64.encode(nonce), BASE64.encode(ciphertext)))
}
fn open(
    format: u32,
    nonce: &str,
    ciphertext: &str,
    key: &[u8; 32],
    aad: &[u8],
    max: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    if format != FORMAT
        || nonce.len() != 32
        || ciphertext.len() > 4 * ((max + TAG_BYTES).div_ceil(3))
    {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    let nonce = BASE64
        .decode(nonce)
        .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    if nonce.len() != 24 {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    let ciphertext = BASE64
        .decode(ciphertext)
        .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    if ciphertext.len() < TAG_BYTES || ciphertext.len() > max + TAG_BYTES {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    let nonce: [u8; 24] = nonce
        .as_slice()
        .try_into()
        .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    cipher
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CloudCryptoError::AuthenticationFailed)
}

fn check_item(item: &Value, context: &ItemContext) -> Result<()> {
    if !item.is_object()
        || item["id"].as_str() != Some(context.item_id.as_str())
        || item["version"].as_u64() != Some(context.item_version)
        || item.pointer("/vault/id").and_then(Value::as_str)
            != Some(context.password_box_id.as_str())
    {
        return Err(CloudCryptoError::InvalidPayload);
    }
    Ok(())
}

impl PasswordBoxKey {
    pub fn generate() -> Result<Self> {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).map_err(|_| CloudCryptoError::EntropyUnavailable)?;
        Ok(Self(key))
    }
    pub fn encrypt_item(&self, item: &Value, context: &ItemContext) -> Result<EncryptedItem> {
        context.validate()?;
        check_item(item, context)?;
        validate_depth(item)?;
        let mut size = JsonSize(0);
        serde_json::to_writer(&mut size, item).map_err(|_| CloudCryptoError::InvalidPayload)?;
        let mut bytes = LimitedJson(Zeroizing::new(Vec::with_capacity(size.0)));
        serde_json::to_writer(&mut bytes, item).map_err(|_| CloudCryptoError::InvalidPayload)?;
        let (nonce, ciphertext) = seal(&bytes.0, &self.0, &context.aad()?)?;
        Ok(EncryptedItem {
            format: FORMAT,
            context: context.clone(),
            nonce,
            ciphertext,
        })
    }
    pub fn decrypt_item(&self, envelope: &EncryptedItem, expected: &ItemContext) -> Result<Value> {
        if &envelope.context != expected {
            return Err(CloudCryptoError::InvalidContext);
        }
        let bytes = open(
            envelope.format,
            &envelope.nonce,
            &envelope.ciphertext,
            &self.0,
            &expected.aad()?,
            MAX_ITEM_BYTES,
        )?;
        let item = serde_json::from_slice(&bytes).map_err(|_| CloudCryptoError::InvalidPayload)?;
        check_item(&item, expected)?;
        Ok(item)
    }
    pub fn wrap_for_owner(
        &self,
        owner_root: &MasterKey,
        context: &OwnerKeyContext,
    ) -> Result<WrappedPasswordBoxKey> {
        let (nonce, ciphertext) = seal(&self.0, owner_root.as_bytes(), &context.aad()?)?;
        Ok(WrappedPasswordBoxKey {
            format: FORMAT,
            context: context.clone(),
            nonce,
            ciphertext,
        })
    }
    pub fn unwrap_for_owner(
        envelope: &WrappedPasswordBoxKey,
        owner_root: &MasterKey,
        expected: &OwnerKeyContext,
    ) -> Result<Self> {
        if &envelope.context != expected {
            return Err(CloudCryptoError::InvalidContext);
        }
        let bytes = open(
            envelope.format,
            &envelope.nonce,
            &envelope.ciphertext,
            owner_root.as_bytes(),
            &expected.aad()?,
            32,
        )?;
        let key: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
        Ok(Self(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (ItemContext, Value) {
        let context = ItemContext {
            password_box_id: ConnectId::generate().unwrap(),
            item_id: ConnectId::generate().unwrap(),
            item_version: 1,
            key_epoch: 1,
        };
        let item = json_item(&context);
        (context, item)
    }
    fn json_item(context: &ItemContext) -> Value {
        serde_json::json!({"id":context.item_id,"version":context.item_version,"vault":{"id":context.password_box_id},"title":"Synthetic","fields":[{"type":"CONCEALED","value":"synthetic-client-only"}],"urls":[{"href":"https://example.test/one"},{"href":"https://example.test/two"}],"extra":{"retained":[1,2,3]}})
    }
    #[test]
    fn full_json_round_trip_uses_fresh_nonces_and_no_plaintext_network_fields() {
        let (context, item) = fixture();
        let key = PasswordBoxKey::generate().unwrap();
        let a = key.encrypt_item(&item, &context).unwrap();
        let b = key.encrypt_item(&item, &context).unwrap();
        assert!(a.nonce != b.nonce && a.ciphertext != b.ciphertext);
        assert!(!serde_json::to_string(&a)
            .unwrap()
            .contains("synthetic-client-only"));
        assert!(key.decrypt_item(&a, &context).unwrap() == item);
    }
    #[test]
    fn destination_version_epoch_and_ciphertext_tampering_are_rejected() {
        let (context, item) = fixture();
        let key = PasswordBoxKey::generate().unwrap();
        let sealed = key.encrypt_item(&item, &context).unwrap();
        for i in 0..4 {
            let mut changed = context.clone();
            match i {
                0 => changed.password_box_id = ConnectId::generate().unwrap(),
                1 => changed.item_id = ConnectId::generate().unwrap(),
                2 => changed.item_version += 1,
                _ => changed.key_epoch += 1,
            }
            let mut forged = sealed.clone();
            forged.context = changed.clone();
            assert!(key.decrypt_item(&forged, &changed).is_err());
        }
        let mut changed = sealed.clone();
        let mut bytes = BASE64.decode(&changed.ciphertext).unwrap();
        bytes[0] ^= 1;
        changed.ciphertext = BASE64.encode(bytes);
        assert!(key.decrypt_item(&changed, &context).is_err());
        assert!(PasswordBoxKey::generate()
            .unwrap()
            .decrypt_item(&sealed, &context)
            .is_err());
    }
    #[test]
    fn owner_key_is_bound_to_account_box_and_epoch() {
        let (item_context, item) = fixture();
        let key = PasswordBoxKey::generate().unwrap();
        let root = MasterKey::generate().unwrap();
        let context = OwnerKeyContext {
            password_box_id: item_context.password_box_id.clone(),
            owner_account_id: Uuid::new_v4(),
            key_epoch: 1,
        };
        let wrapped = key.wrap_for_owner(&root, &context).unwrap();
        let recovered = PasswordBoxKey::unwrap_for_owner(&wrapped, &root, &context).unwrap();
        let item_envelope = key.encrypt_item(&item, &item_context).unwrap();
        assert!(
            recovered
                .decrypt_item(&item_envelope, &item_context)
                .unwrap()
                == item
        );
        let mut forged = wrapped.clone();
        forged.context.owner_account_id = Uuid::new_v4();
        assert!(PasswordBoxKey::unwrap_for_owner(&forged, &root, &forged.context).is_err());
        for target in 0..2 {
            let mut expected = context.clone();
            if target == 0 {
                expected.password_box_id = ConnectId::generate().unwrap();
            } else {
                expected.key_epoch += 1;
            }
            assert!(PasswordBoxKey::unwrap_for_owner(&wrapped, &root, &expected).is_err());
            let mut replaced = wrapped.clone();
            replaced.context = expected.clone();
            assert!(PasswordBoxKey::unwrap_for_owner(&replaced, &root, &expected).is_err());
        }
        let owner_key = root.as_bytes();
        let (nonce, ciphertext) = seal(&key.0, owner_key, &item_context.aad().unwrap()).unwrap();
        let mixed = WrappedPasswordBoxKey {
            format: FORMAT,
            context: context.clone(),
            nonce,
            ciphertext,
        };
        assert!(
            PasswordBoxKey::unwrap_for_owner(&mixed, &root, &context).is_err(),
            "item domain cannot be used as owner-key domain"
        );
        assert!(PasswordBoxKey::unwrap_for_owner(
            &wrapped,
            &MasterKey::generate().unwrap(),
            &context
        )
        .is_err());
    }
    #[test]
    fn invalid_headers_and_payload_identity_are_rejected() {
        let (mut context, mut item) = fixture();
        let key = PasswordBoxKey::generate().unwrap();
        item["id"] = serde_json::json!(ConnectId::generate().unwrap());
        assert!(key.encrypt_item(&item, &context).is_err());
        item = json_item(&context);
        let mut envelope = key.encrypt_item(&item, &context).unwrap();
        envelope.format += 1;
        assert!(key.decrypt_item(&envelope, &context).is_err());
        envelope.format = FORMAT;
        envelope.nonce = "x".repeat(31);
        assert!(key.decrypt_item(&envelope, &context).is_err());
        context.key_epoch = 0;
        assert!(key.encrypt_item(&item, &context).is_err());
    }
    #[test]
    fn oversized_plaintext_and_non_interoperable_versions_are_rejected() {
        let (mut context, mut item) = fixture();
        let key = PasswordBoxKey::generate().unwrap();
        item["oversized"] = serde_json::json!("x".repeat(MAX_ITEM_BYTES));
        assert!(key.encrypt_item(&item, &context).is_err());
        context.item_version = MAX_JSON_INTEGER + 1;
        assert!(key.encrypt_item(&json_item(&context), &context).is_err());
    }
    #[test]
    fn depth_boundary_round_trips_and_excess_depth_never_seals() {
        let (context, mut item) = fixture();
        let key = PasswordBoxKey::generate().unwrap();
        let mut nested = Value::Null;
        for _ in 0..MAX_JSON_DEPTH - 1 {
            nested = Value::Array(vec![nested]);
        }
        item["deep"] = nested;
        let sealed = key.encrypt_item(&item, &context).unwrap();
        assert!(key.decrypt_item(&sealed, &context).unwrap() == item);
        item["deep"] = Value::Array(vec![item["deep"].take()]);
        assert!(key.encrypt_item(&item, &context).is_err());
    }
    #[test]
    fn serialization_never_reallocates_a_plaintext_buffer() {
        let (context, item) = fixture();
        check_item(&item, &context).unwrap();
        let mut size = JsonSize(0);
        serde_json::to_writer(&mut size, &item).unwrap();
        let mut bytes = LimitedJson(Zeroizing::new(Vec::with_capacity(size.0)));
        let pointer = bytes.0.as_ptr();
        let capacity = bytes.0.capacity();
        serde_json::to_writer(&mut bytes, &item).unwrap();
        assert!(pointer == bytes.0.as_ptr() && capacity == bytes.0.capacity());
        assert_eq!(bytes.0.len(), size.0);
    }
}
