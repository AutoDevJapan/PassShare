//! Finite bindings for existing Core account identities and Auth HPKE envelopes.
//! Trust and server membership authorization remain the caller's responsibility.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use passshare_core::{
    cloud_crypto::{
        AccountIdentity, AccountIdentityContext, OwnerKeyContext, PasswordBoxKey,
        PublicAccountIdentity, SharedKeyContext, WrappedAccountIdentity,
        WrappedSharedPasswordBoxKey,
    },
    crypto::generate_salt,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use super::{derive_root, parse, password, CloudPasswordBox, Session, INVALID};

pub(crate) const IDENTITY_LOCKED: &str = "PS057: Account identity is locked";
const MAX_CONTEXT: usize = 256;
const MAX_PUBLIC: usize = 512;
const MAX_SHARED_CONTEXT: usize = 1024;
const MAX_BUNDLE: usize = 2048;
const MAX_JSON_INTEGER: u64 = 9_007_199_254_740_991;

// Only sealed data is serializable. The identity handle has no secret getter,
// Clone, Debug or serde implementation.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityBundle {
    format: u32,
    salt: String,
    wrapped: WrappedAccountIdentity,
}

fn account_context(value: &str) -> Result<AccountIdentityContext, &'static str> {
    let context: AccountIdentityContext = parse(value, MAX_CONTEXT)?;
    if context.account_id.is_nil() || !(1..=MAX_JSON_INTEGER).contains(&context.identity_version) {
        return Err(INVALID);
    }
    Ok(context)
}

fn fingerprint(value: &str) -> Result<(), &'static str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(INVALID);
    }
    Ok(())
}

// Core's identity wrapper predates strict canonical Base64 validation. Enforce
// the fixed format-1 lengths here before KDF work, without implementing crypto.
fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], &'static str> {
    if value.len() != 4 * N.div_ceil(3) {
        return Err(INVALID);
    }
    let bytes = B64.decode(value).map_err(|_| INVALID)?;
    let bytes: [u8; N] = bytes.as_slice().try_into().map_err(|_| INVALID)?;
    if B64.encode(bytes) != value {
        return Err(INVALID);
    }
    Ok(bytes)
}

#[wasm_bindgen]
pub struct CloudAccountIdentity {
    identity: Option<AccountIdentity>,
    context: AccountIdentityContext,
}

impl CloudAccountIdentity {
    pub(crate) fn generate(value: &str) -> Result<Self, &'static str> {
        let context = account_context(value)?;
        let identity = AccountIdentity::generate(context.clone()).map_err(|_| INVALID)?;
        Ok(Self {
            identity: Some(identity),
            context,
        })
    }

    pub(crate) fn public(&self) -> Result<String, &'static str> {
        serde_json::to_string(&self.identity()?.public_identity()).map_err(|_| INVALID)
    }

    pub(crate) fn matches_account(&self, scope: &OwnerKeyContext) -> bool {
        self.context.account_id == scope.owner_account_id
    }

    fn identity(&self) -> Result<&AccountIdentity, &'static str> {
        self.identity.as_ref().ok_or(IDENTITY_LOCKED)
    }

    pub(crate) fn seal(&self, secret: String) -> Result<String, &'static str> {
        let secret = password(secret)?;
        let identity = self.identity()?;
        let salt = generate_salt().map_err(|_| INVALID)?;
        let root = derive_root(&secret, &salt)?;
        let wrapped = identity.wrap(&root).map_err(|_| INVALID)?;
        serde_json::to_string(&IdentityBundle {
            format: 1,
            salt: B64.encode(salt),
            wrapped,
        })
        .map_err(|_| INVALID)
    }

    pub(crate) fn restore(
        bundle: &str,
        secret: String,
        independently_held_context: &str,
        expected_key_id: &str,
    ) -> Result<Self, &'static str> {
        let secret = password(secret)?;
        let context = account_context(independently_held_context)?;
        fingerprint(expected_key_id)?;
        let bundle: IdentityBundle = parse(bundle, MAX_BUNDLE)?;
        if bundle.format != 1 || bundle.wrapped.format != 1 || bundle.wrapped.context != context {
            return Err(INVALID);
        }
        let salt = decode_fixed::<16>(&bundle.salt)?;
        decode_fixed::<24>(&bundle.wrapped.nonce)?;
        decode_fixed::<48>(&bundle.wrapped.ciphertext)?;
        let root = derive_root(&secret, &salt)?;
        let identity = AccountIdentity::unwrap(&bundle.wrapped, &root, &context, expected_key_id)
            .map_err(|_| INVALID)?;
        Ok(Self {
            identity: Some(identity),
            context,
        })
    }
}

#[wasm_bindgen]
impl CloudAccountIdentity {
    #[wasm_bindgen(constructor)]
    pub fn new(account_context_json: &str) -> Result<CloudAccountIdentity, JsValue> {
        Self::generate(account_context_json).map_err(JsValue::from_str)
    }

    #[wasm_bindgen(js_name = publicIdentity)]
    pub fn public_identity(&self) -> Result<String, JsValue> {
        // Serialize Core's descriptor in its fixed field order, with no cached
        // descriptor surviving lock and no private material crossing the ABI.
        self.public().map_err(JsValue::from_str)
    }

    pub fn wrap(&self, encryption_password: String) -> Result<String, JsValue> {
        self.seal(encryption_password).map_err(JsValue::from_str)
    }

    pub fn unlock(
        bundle_json: &str,
        encryption_password: String,
        independently_held_account_context_json: &str,
        expected_key_id: &str,
    ) -> Result<CloudAccountIdentity, JsValue> {
        Self::restore(
            bundle_json,
            encryption_password,
            independently_held_account_context_json,
            expected_key_id,
        )
        .map_err(JsValue::from_str)
    }

    pub fn lock(&mut self) {
        self.identity = None;
    }
}

#[wasm_bindgen]
impl CloudPasswordBox {
    #[wasm_bindgen(js_name = wrapForRecipient)]
    pub fn wrap_for_recipient(
        &self,
        sender: &CloudAccountIdentity,
        trusted_recipient_public_json: &str,
        independently_held_shared_key_context_json: &str,
    ) -> Result<String, JsValue> {
        self.session
            .share(
                sender,
                trusted_recipient_public_json,
                independently_held_shared_key_context_json,
            )
            .map_err(JsValue::from_str)
    }

    #[wasm_bindgen(js_name = unlockForRecipient)]
    pub fn unlock_for_recipient(
        envelope_json: &str,
        recipient: &CloudAccountIdentity,
        trusted_sender_public_json: &str,
        expected_shared_key_context_json: &str,
    ) -> Result<CloudPasswordBox, JsValue> {
        Session::receive(
            envelope_json,
            recipient,
            trusted_sender_public_json,
            expected_shared_key_context_json,
        )
        .map(|session| Self { session })
        .map_err(JsValue::from_str)
    }
}

impl Session {
    pub(crate) fn share(
        &self,
        sender: &CloudAccountIdentity,
        trusted_recipient: &str,
        independently_held_context: &str,
    ) -> Result<String, &'static str> {
        let key = self.key()?;
        let identity = sender.identity()?;
        let recipient: PublicAccountIdentity = parse(trusted_recipient, MAX_PUBLIC)?;
        let context: SharedKeyContext = parse(independently_held_context, MAX_SHARED_CONTEXT)?;
        // Session.owner is the current caller's operational scope, not proof
        // of server ownership. A recipient may only act as that recipient.
        if sender.context.account_id != self.owner.owner_account_id
            || context.sender_account_id != self.owner.owner_account_id
            || context.password_box_id != self.owner.password_box_id
            || context.key_epoch != self.owner.key_epoch
        {
            return Err(INVALID);
        }
        let envelope = key
            .wrap_for_recipient(identity, &recipient, &context)
            .map_err(|_| INVALID)?;
        serde_json::to_string(&envelope).map_err(|_| INVALID)
    }

    pub(crate) fn receive(
        envelope_json: &str,
        recipient: &CloudAccountIdentity,
        trusted_sender: &str,
        independently_held_context: &str,
    ) -> Result<Self, &'static str> {
        let identity = recipient.identity()?;
        let sender: PublicAccountIdentity = parse(trusted_sender, MAX_PUBLIC)?;
        let expected: SharedKeyContext = parse(independently_held_context, MAX_SHARED_CONTEXT)?;
        let envelope: WrappedSharedPasswordBoxKey = parse(envelope_json, MAX_BUNDLE)?;
        let key = PasswordBoxKey::unwrap_for_recipient(&envelope, identity, &sender, &expected)
            .map_err(|_| INVALID)?;
        // All scope values come from independent expectations and the current
        // recipient, never from the received envelope or the sender as owner.
        let scope = OwnerKeyContext {
            password_box_id: expected.password_box_id,
            owner_account_id: recipient.context.account_id,
            key_epoch: expected.key_epoch,
        };
        Ok(Self {
            key: Some(key),
            owner: scope,
            can_wrap_owner: false,
        })
    }
}
