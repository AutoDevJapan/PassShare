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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityRecord {
    bundle_version: u64,
    identity: PublicAccountIdentity,
    bundle: IdentityBundle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityPreparation {
    account_context: String,
    own_pin: String,
    remote_record: String,
    pending_record: String,
    verification_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityPrepared {
    public_identity: String,
    record: String,
    requires_create: bool,
    has_pending: bool,
}

fn identity_record(value: &str) -> Result<Option<IdentityRecord>, &'static str> {
    if value.is_empty() {
        return Ok(None);
    }
    let record: IdentityRecord = parse(value, 4096)?;
    if !(1..=MAX_JSON_INTEGER).contains(&record.bundle_version) {
        return Err(INVALID);
    }
    let raw: serde_json::Value = parse(value, 4096)?;
    public_descriptor(&serde_json::to_string(&raw["identity"]).map_err(|_| INVALID)?)?;
    Ok(Some(record))
}

// Reconciliation policy lives with the identity, rather than in React. Empty
// strings explicitly represent absent public records; JSON null is not accepted.
pub(crate) fn prepare_identity(
    values: &str,
    secret: String,
) -> Result<(CloudAccountIdentity, String), &'static str> {
    let secret = zeroize::Zeroizing::new(secret);
    let input: IdentityPreparation = parse(values, 12_288)?;
    let context = account_context(&input.account_context)?;
    // The current server contract supports version 1; never select it from a
    // concurrently received bundle or descriptor.
    if context.identity_version != 1 || input.verification_code.len() > 256 {
        return Err(INVALID);
    }
    let remote = identity_record(&input.remote_record)?;
    let pending = identity_record(&input.pending_record)?;
    if let Some(pending) = &pending {
        if pending.bundle_version != 1 {
            return Err(INVALID);
        }
        if let Some(remote) = &remote {
            if serde_json::to_value(remote).map_err(|_| INVALID)?
                != serde_json::to_value(pending).map_err(|_| INVALID)?
            {
                return Err(INVALID);
            }
        }
    }
    let has_pending = pending.is_some();
    let requires_create = remote.is_none();
    let held = remote.or(pending);
    let identity;
    let record;
    if let Some(held) = held {
        let public = serde_json::to_string(&held.identity).map_err(|_| INVALID)?;
        let pin = if !input.verification_code.is_empty() {
            verify_public(&public, &input.account_context, &input.verification_code)?
        } else {
            let pin = public_descriptor(&input.own_pin)?;
            if pin.account_id != context.account_id
                || pin.identity_version != context.identity_version
            {
                return Err(INVALID);
            }
            let checked = verify_public(&public, &input.account_context, &pin.key_id)?;
            if serde_json::from_str::<serde_json::Value>(&checked).map_err(|_| INVALID)?
                != serde_json::to_value(&pin).map_err(|_| INVALID)?
            {
                return Err(INVALID);
            }
            checked
        };
        let pin: PublicAccountIdentity = parse(&pin, MAX_PUBLIC)?;
        identity = CloudAccountIdentity::restore(
            &serde_json::to_string(&held.bundle).map_err(|_| INVALID)?,
            secret.to_string(),
            &input.account_context,
            &pin.key_id,
        )?;
        record = held;
    } else {
        // A previously held pin with no reconstructable ciphertext never
        // authorizes replacing its key, even if an unrelated server says 404.
        if !input.own_pin.is_empty() {
            return Err(INVALID);
        }
        identity = CloudAccountIdentity::generate(&input.account_context)?;
        record = IdentityRecord {
            bundle_version: 1,
            identity: parse(&identity.public()?, MAX_PUBLIC)?,
            bundle: parse(&identity.seal(secret.to_string())?, MAX_BUNDLE)?,
        };
    }
    let output = serde_json::to_string(&IdentityPrepared {
        public_identity: identity.public()?,
        record: serde_json::to_string(&record).map_err(|_| INVALID)?,
        requires_create,
        has_pending: has_pending || requires_create,
    })
    .map_err(|_| INVALID)?;
    Ok((identity, output))
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

fn public_descriptor(value: &str) -> Result<PublicAccountIdentity, &'static str> {
    let public: PublicAccountIdentity = parse(value, MAX_PUBLIC)?;
    public.validate_public().map_err(|_| INVALID)?;
    // UUID serde also accepts compact/uppercase text; the public wire contract
    // accepts only the canonical lowercase UUID spelling.
    let raw: serde_json::Value = parse(value, MAX_PUBLIC)?;
    if raw["accountId"].as_str() != Some(public.account_id.to_string().as_str()) {
        return Err(INVALID);
    }
    Ok(public)
}

// User-supplied out-of-band code. No server value can substitute for this input.
pub(crate) fn verify_public(
    value: &str,
    context: &str,
    code: &str,
) -> Result<String, &'static str> {
    if code.len() > 256 {
        return Err(INVALID);
    }
    let mut normalized = String::with_capacity(64);
    for byte in code.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if !byte.is_ascii_hexdigit() || normalized.len() == 64 {
            return Err(INVALID);
        }
        normalized.push(char::from(byte.to_ascii_lowercase()));
    }
    fingerprint(&normalized)?;
    let expected = account_context(context)?;
    let public = public_descriptor(value)?;
    if public.account_id != expected.account_id
        || public.identity_version != expected.identity_version
        || public.key_id != normalized
    {
        return Err(INVALID);
    }
    serde_json::to_string(&public).map_err(|_| INVALID)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharingSelection {
    password_box_id: String,
    caller_account_id: String,
    key_epoch: u64,
    sender: PublicAccountIdentity,
    recipient: PublicAccountIdentity,
    members: Vec<SharingMember>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharingMember {
    account_id: String,
    role: String,
    membership_confirmed: bool,
}

// Membership comes from the authenticated API; trust comes from independently
// pinned descriptors. The server must independently enforce current membership.
pub(crate) fn sharing_context(value: &str) -> Result<String, &'static str> {
    let selection: SharingSelection = parse(value, 65_536)?;
    passshare_core::ConnectId::validate(&selection.password_box_id).map_err(|_| INVALID)?;
    if !(1..=MAX_JSON_INTEGER).contains(&selection.key_epoch) || selection.members.len() > 1000 {
        return Err(INVALID);
    }
    selection.sender.validate_public().map_err(|_| INVALID)?;
    selection.recipient.validate_public().map_err(|_| INVALID)?;
    let sender_id = selection.sender.account_id.to_string();
    let recipient_id = selection.recipient.account_id.to_string();
    let mut ids = std::collections::HashSet::new();
    let mut owners = 0;
    for member in &selection.members {
        if !ids.insert(&member.account_id)
            || !matches!(member.role.as_str(), "owner" | "member" | "readonly")
        {
            return Err(INVALID);
        }
        if member.role == "owner" {
            owners += 1;
        }
    }
    if owners != 1
        || sender_id == recipient_id
        || (selection.caller_account_id != sender_id && selection.caller_account_id != recipient_id)
        || !selection
            .members
            .iter()
            .any(|m| m.account_id == sender_id && m.role == "owner" && m.membership_confirmed)
        || !selection
            .members
            .iter()
            .any(|m| m.account_id == recipient_id && m.role != "owner" && m.membership_confirmed)
    {
        return Err(INVALID);
    }
    serde_json::to_string(&SharedKeyContext {
        password_box_id: selection.password_box_id.parse().map_err(|_| INVALID)?,
        sender_account_id: selection.sender.account_id,
        recipient_account_id: selection.recipient.account_id,
        key_epoch: selection.key_epoch,
        sender_identity_version: selection.sender.identity_version,
        recipient_identity_version: selection.recipient.identity_version,
        sender_key_id: selection.sender.key_id,
        recipient_key_id: selection.recipient.key_id,
    })
    .map_err(|_| INVALID)
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
