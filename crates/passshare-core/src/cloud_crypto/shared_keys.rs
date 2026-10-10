//! Shares a PasswordBoxKey between account identities with RFC 9180 HPKE Auth
//! mode, fixed suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20Poly1305.
//! Callers must pass public identities they already trust out of band; nothing
//! here derives the expected sender, recipient or epoch from an envelope or a
//! server response.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable,
    Kem as KemTrait, OpModeR, OpModeS, Serializable,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use super::{open, seal, CloudCryptoError, PasswordBoxKey, Result, FORMAT, MAX_JSON_INTEGER};
use crate::{crypto::MasterKey, ConnectId};

type Aead = ChaCha20Poly1305;
type Kdf = HkdfSha256;
type Dhkem = X25519HkdfSha256;
type PrivateKey = <Dhkem as KemTrait>::PrivateKey;
type PublicKey = <Dhkem as KemTrait>::PublicKey;
type EncappedKey = <Dhkem as KemTrait>::EncappedKey;

/// HPKE mode Auth (0x02), KEM 0x0020, KDF 0x0001, AEAD 0x0003.
pub const SHARED_KEY_SUITE: &str = "hpke-auth/0x0020/0x0001/0x0003";
const POINT_BYTES: usize = 32;
const WRAPPED_KEY_BYTES: usize = 32 + 16;
const KEY_ID_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountIdentityContext {
    pub account_id: Uuid,
    pub identity_version: u64,
}

/// Public half of an account identity. `key_id` is the lowercase hex
/// SHA-256 of the raw X25519 public key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicAccountIdentity {
    pub account_id: Uuid,
    pub identity_version: u64,
    pub public_key: String,
    pub key_id: String,
}

/// Account identity secret. Deliberately no Debug/Clone/serde/raw getter;
/// it leaves the client only as `WrappedAccountIdentity`.
pub struct AccountIdentity {
    context: AccountIdentityContext,
    seed: Zeroizing<[u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WrappedAccountIdentity {
    pub format: u32,
    pub context: AccountIdentityContext,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedKeyContext {
    pub password_box_id: ConnectId,
    pub sender_account_id: Uuid,
    pub recipient_account_id: Uuid,
    pub key_epoch: u64,
    pub sender_identity_version: u64,
    pub recipient_identity_version: u64,
    pub sender_key_id: String,
    pub recipient_key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WrappedSharedPasswordBoxKey {
    pub format: u32,
    pub suite: String,
    pub context: SharedKeyContext,
    pub enc: String,
    pub ciphertext: String,
}

fn decode_fixed<const N: usize>(text: &str) -> Result<[u8; N]> {
    if text.len() != 4 * N.div_ceil(3) {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    let bytes = BASE64
        .decode(text)
        .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    let bytes: [u8; N] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
    if BASE64.encode(bytes) != text {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    Ok(bytes)
}

/// Rejects non-canonical RFC 7748 u-coordinates (top bit set or >= 2^255-19).
/// Low-order points are left to the HPKE DH check, which rejects them.
fn decode_point(text: &str) -> Result<[u8; POINT_BYTES]> {
    let point = decode_fixed::<POINT_BYTES>(text)?;
    let at_least_p =
        point[31] == 0x7f && point[1..31].iter().all(|&b| b == 0xff) && point[0] >= 0xed;
    if point[31] & 0x80 != 0 || at_least_p {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    Ok(point)
}

fn key_id(public_key: &[u8]) -> String {
    Sha256::digest(public_key)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The pinned X25519 KEM consumes exactly 32 bytes once for its ephemeral IKM.
/// Buffer fallible OS entropy before calling its infallible RNG interface, and
/// erase consumed bytes and any unused bytes on drop. No PRNG state is retained.
struct EphemeralEntropy {
    bytes: Zeroizing<[u8; 32]>,
    position: usize,
}
fn os_rng() -> Result<EphemeralEntropy> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut bytes[..]).map_err(|_| CloudCryptoError::EntropyUnavailable)?;
    Ok(EphemeralEntropy { bytes, position: 0 })
}
impl hpke::rand_core::TryRng for EphemeralEntropy {
    type Error = std::convert::Infallible;
    fn try_next_u32(&mut self) -> std::result::Result<u32, Self::Error> {
        let mut bytes = Zeroizing::new([0u8; 4]);
        self.try_fill_bytes(&mut bytes[..])?;
        Ok(u32::from_le_bytes(*bytes))
    }
    fn try_next_u64(&mut self) -> std::result::Result<u64, Self::Error> {
        let mut bytes = Zeroizing::new([0u8; 8]);
        self.try_fill_bytes(&mut bytes[..])?;
        Ok(u64::from_le_bytes(*bytes))
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> std::result::Result<(), Self::Error> {
        let end = self
            .position
            .checked_add(dst.len())
            .expect("bounded HPKE entropy request");
        assert!(
            end <= self.bytes.len(),
            "pinned X25519 KEM entropy budget exceeded"
        );
        dst.copy_from_slice(&self.bytes[self.position..end]);
        self.bytes[self.position..end].zeroize();
        self.position = end;
        Ok(())
    }
}
impl hpke::rand_core::TryCryptoRng for EphemeralEntropy {}

impl AccountIdentityContext {
    fn validate(&self) -> Result<()> {
        if self.account_id.is_nil() || !(1..=MAX_JSON_INTEGER).contains(&self.identity_version) {
            return Err(CloudCryptoError::InvalidContext);
        }
        Ok(())
    }
    fn aad(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec(&("passshare.cloud.account-identity", FORMAT, self))
            .map_err(|_| CloudCryptoError::InvalidContext)
    }
}

impl PublicAccountIdentity {
    /// Checks the public descriptor's context, canonical X25519 coordinate and
    /// SHA-256 fingerprint. This does not establish trust in its source, prove
    /// possession of a private key, or perform HPKE's low-order DH check.
    pub fn validate_public(&self) -> Result<()> {
        self.validate().map(|_| ())
    }

    /// Structural check of a trusted descriptor; returns the HPKE public key.
    fn validate(&self) -> Result<PublicKey> {
        AccountIdentityContext {
            account_id: self.account_id,
            identity_version: self.identity_version,
        }
        .validate()?;
        let point = decode_point(&self.public_key).map_err(|_| CloudCryptoError::InvalidContext)?;
        if self.key_id.len() != KEY_ID_CHARS || self.key_id != key_id(&point) {
            return Err(CloudCryptoError::InvalidContext);
        }
        PublicKey::from_bytes(&point).map_err(|_| CloudCryptoError::InvalidContext)
    }
}

impl AccountIdentity {
    pub fn generate(context: AccountIdentityContext) -> Result<Self> {
        context.validate()?;
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(&mut seed[..]).map_err(|_| CloudCryptoError::EntropyUnavailable)?;
        Ok(Self { context, seed })
    }
    pub fn context(&self) -> &AccountIdentityContext {
        &self.context
    }
    fn keypair(&self) -> (PrivateKey, PublicKey) {
        Dhkem::derive_keypair(&self.seed[..])
    }
    pub fn public_identity(&self) -> PublicAccountIdentity {
        let public = self.keypair().1.to_bytes();
        PublicAccountIdentity {
            account_id: self.context.account_id,
            identity_version: self.context.identity_version,
            public_key: BASE64.encode(&public[..]),
            key_id: key_id(&public[..]),
        }
    }
    pub fn wrap(&self, root: &MasterKey) -> Result<WrappedAccountIdentity> {
        let (nonce, ciphertext) = seal(&self.seed[..], root.as_bytes(), &self.context.aad()?)?;
        Ok(WrappedAccountIdentity {
            format: FORMAT,
            context: self.context.clone(),
            nonce,
            ciphertext,
        })
    }
    pub fn unwrap(
        envelope: &WrappedAccountIdentity,
        root: &MasterKey,
        expected: &AccountIdentityContext,
        expected_key_id: &str,
    ) -> Result<Self> {
        if &envelope.context != expected
            || expected_key_id.len() != KEY_ID_CHARS
            || !expected_key_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CloudCryptoError::InvalidContext);
        }
        let bytes = open(
            envelope.format,
            &envelope.nonce,
            &envelope.ciphertext,
            root.as_bytes(),
            &expected.aad()?,
            32,
        )?;
        let mut seed = Zeroizing::new([0u8; 32]);
        if bytes.len() != seed.len() {
            return Err(CloudCryptoError::InvalidEnvelope);
        }
        seed.copy_from_slice(&bytes);
        let identity = Self {
            context: expected.clone(),
            seed,
        };
        if identity.public_identity().key_id != expected_key_id {
            return Err(CloudCryptoError::InvalidContext);
        }
        Ok(identity)
    }
}

impl SharedKeyContext {
    /// Checks the context against the actual sender and target recipient and
    /// returns the domain-separated (info, aad) pair it is bound to.
    fn bind(
        &self,
        sender: &PublicAccountIdentity,
        recipient: &PublicAccountIdentity,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        ConnectId::validate(self.password_box_id.as_str())
            .map_err(|_| CloudCryptoError::InvalidContext)?;
        if !(1..=MAX_JSON_INTEGER).contains(&self.key_epoch)
            || self.sender_account_id != sender.account_id
            || self.sender_identity_version != sender.identity_version
            || self.sender_key_id != sender.key_id
            || self.recipient_account_id != recipient.account_id
            || self.recipient_identity_version != recipient.identity_version
            || self.recipient_key_id != recipient.key_id
        {
            return Err(CloudCryptoError::InvalidContext);
        }
        let encode = |label: &str| {
            serde_json::to_vec(&(label, FORMAT, SHARED_KEY_SUITE, self))
                .map_err(|_| CloudCryptoError::InvalidContext)
        };
        Ok((
            encode("passshare.cloud.shared-box-key.info")?,
            encode("passshare.cloud.shared-box-key.aad")?,
        ))
    }
}

impl PasswordBoxKey {
    pub fn wrap_for_recipient(
        &self,
        sender: &AccountIdentity,
        recipient: &PublicAccountIdentity,
        context: &SharedKeyContext,
    ) -> Result<WrappedSharedPasswordBoxKey> {
        let recipient_key = recipient.validate()?;
        let (info, aad) = context.bind(&sender.public_identity(), recipient)?;
        let mut rng = os_rng()?;
        let (enc, ciphertext) = hpke::single_shot_seal_with_rng::<Aead, Kdf, Dhkem>(
            &OpModeS::Auth(sender.keypair()),
            &recipient_key,
            &info,
            &self.0,
            &aad,
            &mut rng,
        )
        .map_err(|_| CloudCryptoError::InvalidContext)?;
        Ok(WrappedSharedPasswordBoxKey {
            format: FORMAT,
            suite: SHARED_KEY_SUITE.to_owned(),
            context: context.clone(),
            enc: BASE64.encode(&enc.to_bytes()[..]),
            ciphertext: BASE64.encode(ciphertext),
        })
    }
    pub fn unwrap_for_recipient(
        envelope: &WrappedSharedPasswordBoxKey,
        recipient: &AccountIdentity,
        sender: &PublicAccountIdentity,
        expected: &SharedKeyContext,
    ) -> Result<Self> {
        if envelope.format != FORMAT || envelope.suite != SHARED_KEY_SUITE {
            return Err(CloudCryptoError::InvalidEnvelope);
        }
        if &envelope.context != expected {
            return Err(CloudCryptoError::InvalidContext);
        }
        let sender_key = sender.validate()?;
        let (info, aad) = expected.bind(sender, &recipient.public_identity())?;
        let enc = EncappedKey::from_bytes(&decode_point(&envelope.enc)?)
            .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
        let ciphertext = decode_fixed::<WRAPPED_KEY_BYTES>(&envelope.ciphertext)?;
        let key = Zeroizing::new(
            hpke::single_shot_open::<Aead, Kdf, Dhkem>(
                &OpModeR::Auth(sender_key),
                &recipient.keypair().0,
                &enc,
                &info,
                &ciphertext,
                &aad,
            )
            .map_err(|_| CloudCryptoError::AuthenticationFailed)?,
        );
        let key: [u8; 32] = key
            .as_slice()
            .try_into()
            .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
        Ok(Self(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_crypto::ItemContext;
    use serde_json::Value;
    #[test]
    fn ephemeral_entropy_is_consumed_once_and_erased() {
        use hpke::rand_core::TryRng;
        let mut entropy = EphemeralEntropy {
            bytes: Zeroizing::new([7u8; 32]),
            position: 0,
        };
        let mut output = Zeroizing::new([0u8; 32]);
        entropy.try_fill_bytes(&mut output[..]).unwrap();
        assert_eq!(*output, [7u8; 32]);
        assert_eq!(entropy.position, 32);
        assert_eq!(*entropy.bytes, [0u8; 32]);
    }

    fn identity() -> AccountIdentity {
        AccountIdentity::generate(AccountIdentityContext {
            account_id: Uuid::new_v4(),
            identity_version: 1,
        })
        .unwrap()
    }
    fn context(
        box_id: &ConnectId,
        key_epoch: u64,
        sender: &PublicAccountIdentity,
        recipient: &PublicAccountIdentity,
    ) -> SharedKeyContext {
        SharedKeyContext {
            password_box_id: box_id.clone(),
            sender_account_id: sender.account_id,
            recipient_account_id: recipient.account_id,
            key_epoch,
            sender_identity_version: sender.identity_version,
            recipient_identity_version: recipient.identity_version,
            sender_key_id: sender.key_id.clone(),
            recipient_key_id: recipient.key_id.clone(),
        }
    }
    fn item(box_id: &ConnectId, key_epoch: u64) -> (ItemContext, Value) {
        let context = ItemContext {
            password_box_id: box_id.clone(),
            item_id: ConnectId::generate().unwrap(),
            item_version: 1,
            key_epoch,
        };
        let item = serde_json::json!({"id":context.item_id,"version":1,"vault":{"id":box_id},"title":"Synthetic shared","fields":[{"type":"CONCEALED","value":"synthetic-shared-only"}],"urls":[{"href":"https://example.test/a"},{"href":"https://example.test/b"}],"extra":{"retained":[1,2,3]}});
        (context, item)
    }
    /// Public synthetic point descriptor (not a production key).
    fn descriptor_for(point: [u8; 32]) -> PublicAccountIdentity {
        PublicAccountIdentity {
            account_id: Uuid::new_v4(),
            identity_version: 1,
            public_key: BASE64.encode(point),
            key_id: key_id(&point),
        }
    }
    fn p_bytes() -> [u8; 32] {
        let mut p = [0xff; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        p
    }

    #[test]
    fn public_validator_reuses_descriptor_checks_without_establishing_trust() {
        let valid = identity().public_identity();
        assert!(valid.validate_public().is_ok());
        let mut bad = valid.clone();
        bad.account_id = Uuid::nil();
        assert!(bad.validate_public().is_err());
        for version in [0, MAX_JSON_INTEGER + 1] {
            let mut bad = valid.clone();
            bad.identity_version = version;
            assert!(bad.validate_public().is_err());
        }
        // The transport limits its protocol to 1; do not change Core's semantics.
        let mut future = valid.clone();
        future.identity_version = 2;
        assert!(future.validate_public().is_ok());
        let mut bad = valid.clone();
        bad.key_id = "0".repeat(64);
        assert!(bad.validate_public().is_err());
        let mut bad = valid.clone();
        bad.key_id = bad.key_id.to_uppercase();
        assert!(bad.validate_public().is_err());
        let mut bad = valid.clone();
        bad.public_key.pop();
        assert!(bad.validate_public().is_err());
        let mut bad = valid.clone();
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut chars = bad.public_key.into_bytes();
        let index = ALPHABET.iter().position(|&c| c == chars[42]).unwrap();
        chars[42] = ALPHABET[index ^ 1];
        bad.public_key = String::from_utf8(chars).unwrap();
        assert!(bad.validate_public().is_err());
        // Matching SHA-256 and otherwise valid context: isolate coordinate checks.
        for point in [[0xff; 32], p_bytes()] {
            assert!(descriptor_for(point).validate_public().is_err());
        }
        // Low-order DH rejection stays in HPKE, rather than this public check.
        assert!(descriptor_for([0; 32]).validate_public().is_ok());
    }

    #[test]
    fn a_to_b_round_trip_through_json_decrypts_whole_item() {
        let (a, b) = (identity(), identity());
        let (a_pub, b_pub) = (a.public_identity(), b.public_identity());
        let box_id = ConnectId::generate().unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        let (item_context, item) = item(&box_id, 1);
        let sealed_item = key.encrypt_item(&item, &item_context).unwrap();
        let ctx = context(&box_id, 1, &a_pub, &b_pub);
        let wrapped = key.wrap_for_recipient(&a, &b_pub, &ctx).unwrap();
        let text = serde_json::to_string(&wrapped).unwrap();
        assert!(!text.contains(&BASE64.encode(key.0)));
        let received: WrappedSharedPasswordBoxKey = serde_json::from_str(&text).unwrap();
        let unwrapped = PasswordBoxKey::unwrap_for_recipient(&received, &b, &a_pub, &ctx).unwrap();
        assert!(unwrapped.decrypt_item(&sealed_item, &item_context).unwrap() == item);
        assert_eq!(received.enc.len(), 44);
        assert_eq!(received.ciphertext.len(), 64);
    }

    #[test]
    fn identical_contexts_use_fresh_enc_and_ciphertext() {
        let (a, b) = (identity(), identity());
        let b_pub = b.public_identity();
        let ctx = context(
            &ConnectId::generate().unwrap(),
            1,
            &a.public_identity(),
            &b_pub,
        );
        let key = PasswordBoxKey::generate().unwrap();
        let first = key.wrap_for_recipient(&a, &b_pub, &ctx).unwrap();
        let second = key.wrap_for_recipient(&a, &b_pub, &ctx).unwrap();
        assert!(first.enc != second.enc && first.ciphertext != second.ciphertext);
    }

    #[test]
    fn other_accounts_and_forged_bindings_are_refused() {
        let (a, b, c) = (identity(), identity(), identity());
        let (a_pub, b_pub, c_pub) = (
            a.public_identity(),
            b.public_identity(),
            c.public_identity(),
        );
        let box_id = ConnectId::generate().unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        let ctx = context(&box_id, 1, &a_pub, &b_pub);
        let wrapped = key.wrap_for_recipient(&a, &b_pub, &ctx).unwrap();
        // C with the real context is not the target recipient.
        assert!(PasswordBoxKey::unwrap_for_recipient(&wrapped, &c, &a_pub, &ctx).is_err());
        // C relabelling the envelope as addressed to C fails HPKE.
        let c_ctx = context(&box_id, 1, &a_pub, &c_pub);
        let mut relabelled = wrapped.clone();
        relabelled.context = c_ctx.clone();
        assert_eq!(
            PasswordBoxKey::unwrap_for_recipient(&relabelled, &c, &a_pub, &c_ctx).err(),
            Some(CloudCryptoError::AuthenticationFailed)
        );
        // B trusting C as sender: descriptor mismatch, then HPKE Auth mismatch.
        assert!(PasswordBoxKey::unwrap_for_recipient(&wrapped, &b, &c_pub, &ctx).is_err());
        let c_sender = context(&box_id, 1, &c_pub, &b_pub);
        let mut resent = wrapped.clone();
        resent.context = c_sender.clone();
        assert_eq!(
            PasswordBoxKey::unwrap_for_recipient(&resent, &b, &c_pub, &c_sender).err(),
            Some(CloudCryptoError::AuthenticationFailed)
        );
        // Every bound field changed consistently in envelope and expectation.
        let mut a_v2 = a_pub.clone();
        a_v2.identity_version = 2;
        for i in 0..6 {
            let mut changed = ctx.clone();
            match i {
                0 => changed.password_box_id = ConnectId::generate().unwrap(),
                1 => changed.key_epoch = 2,
                2 => changed.sender_identity_version = 2,
                3 => changed.recipient_identity_version = 2,
                4 => changed.sender_key_id = c_pub.key_id.clone(),
                _ => changed.recipient_key_id = c_pub.key_id.clone(),
            }
            let mut forged = wrapped.clone();
            forged.context = changed.clone();
            let sender = if i == 2 { &a_v2 } else { &a_pub };
            assert!(PasswordBoxKey::unwrap_for_recipient(&forged, &b, sender, &changed).is_err());
            assert!(PasswordBoxKey::unwrap_for_recipient(&wrapped, &b, sender, &changed).is_err());
        }
        let mut changed = ctx.clone();
        changed.recipient_account_id = c_pub.account_id;
        let mut forged = wrapped.clone();
        forged.context = changed.clone();
        assert!(PasswordBoxKey::unwrap_for_recipient(&forged, &b, &a_pub, &changed).is_err());
    }

    #[test]
    fn tampered_or_non_canonical_envelopes_are_refused() {
        let (a, b) = (identity(), identity());
        let (a_pub, b_pub) = (a.public_identity(), b.public_identity());
        let ctx = context(&ConnectId::generate().unwrap(), 1, &a_pub, &b_pub);
        let wrapped = PasswordBoxKey::generate()
            .unwrap()
            .wrap_for_recipient(&a, &b_pub, &ctx)
            .unwrap();
        let refuse = |envelope: &WrappedSharedPasswordBoxKey| {
            PasswordBoxKey::unwrap_for_recipient(envelope, &b, &a_pub, &ctx).err()
        };
        let mut e = wrapped.clone();
        let mut bytes = BASE64.decode(&e.enc).unwrap();
        bytes[0] ^= 1;
        e.enc = BASE64.encode(bytes);
        assert!(refuse(&e).is_some());
        let mut e = wrapped.clone();
        let mut bytes = BASE64.decode(&e.ciphertext).unwrap();
        bytes[47] ^= 1;
        e.ciphertext = BASE64.encode(bytes);
        assert_eq!(refuse(&e), Some(CloudCryptoError::AuthenticationFailed));
        let mut e = wrapped.clone();
        e.format += 1;
        assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
        let mut e = wrapped.clone();
        e.suite = "hpke-base/0x0020/0x0001/0x0003".into();
        assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
        // Same bytes, non-zero trailing bits in the last Base64 symbol.
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut e = wrapped.clone();
        let mut chars = e.enc.clone().into_bytes();
        let index = ALPHABET.iter().position(|&c| c == chars[42]).unwrap();
        chars[42] = ALPHABET[index ^ 1];
        e.enc = String::from_utf8(chars).unwrap();
        assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
        for point in [[0xff; 32], p_bytes()] {
            let mut e = wrapped.clone();
            e.enc = BASE64.encode(point);
            assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
        }
        let mut e = wrapped.clone();
        e.enc.push_str("AAAA");
        assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
        let mut e = wrapped.clone();
        e.ciphertext.push_str("AAAA");
        assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
        let mut e = wrapped.clone();
        e.ciphertext = "A".repeat(1 << 20);
        assert_eq!(refuse(&e), Some(CloudCryptoError::InvalidEnvelope));
    }

    #[test]
    fn unknown_fields_are_denied() {
        let (a, b) = (identity(), identity());
        let (a_pub, b_pub) = (a.public_identity(), b.public_identity());
        let ctx = context(&ConnectId::generate().unwrap(), 1, &a_pub, &b_pub);
        let wrapped = PasswordBoxKey::generate()
            .unwrap()
            .wrap_for_recipient(&a, &b_pub, &ctx)
            .unwrap();
        let value = serde_json::to_value(&wrapped).unwrap();
        let mut top = value.clone();
        top["mode"] = serde_json::json!("base");
        assert!(serde_json::from_value::<WrappedSharedPasswordBoxKey>(top).is_err());
        let mut nested = value;
        nested["context"]["role"] = serde_json::json!("owner");
        assert!(serde_json::from_value::<WrappedSharedPasswordBoxKey>(nested).is_err());
        let mut descriptor = serde_json::to_value(&a_pub).unwrap();
        descriptor["trusted"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PublicAccountIdentity>(descriptor).is_err());
    }

    #[test]
    fn invalid_descriptors_and_contexts_are_refused() {
        let (a, b) = (identity(), identity());
        let (a_pub, b_pub) = (a.public_identity(), b.public_identity());
        let box_id = ConnectId::generate().unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        for version in [0, MAX_JSON_INTEGER + 1] {
            assert!(AccountIdentity::generate(AccountIdentityContext {
                account_id: Uuid::new_v4(),
                identity_version: version,
            })
            .is_err());
        }
        assert!(AccountIdentity::generate(AccountIdentityContext {
            account_id: Uuid::nil(),
            identity_version: 1,
        })
        .is_err());
        let mut bad = b_pub.clone();
        bad.key_id = bad.key_id.to_uppercase();
        let ctx = context(&box_id, 1, &a_pub, &bad);
        assert!(key.wrap_for_recipient(&a, &bad, &ctx).is_err());
        let mut bad = b_pub.clone();
        bad.public_key = a_pub.public_key.clone();
        let ctx = context(&box_id, 1, &a_pub, &bad);
        assert!(key.wrap_for_recipient(&a, &bad, &ctx).is_err());
        for point in [[0xff; 32], p_bytes()] {
            let bad = descriptor_for(point);
            let ctx = context(&box_id, 1, &a_pub, &bad);
            assert!(key.wrap_for_recipient(&a, &bad, &ctx).is_err());
        }
        for epoch in [0, MAX_JSON_INTEGER + 1] {
            let ctx = context(&box_id, epoch, &a_pub, &b_pub);
            assert!(key.wrap_for_recipient(&a, &b_pub, &ctx).is_err());
        }
        let mut ctx = context(&box_id, 1, &a_pub, &b_pub);
        ctx.password_box_id =
            serde_json::from_value(serde_json::json!(box_id.as_str().to_uppercase())).unwrap();
        assert!(key.wrap_for_recipient(&a, &b_pub, &ctx).is_err());
        // Sender context must describe the actual sending identity.
        let ctx = context(&box_id, 1, &b_pub, &b_pub);
        assert!(key.wrap_for_recipient(&a, &b_pub, &ctx).is_err());
    }

    #[test]
    fn low_order_public_keys_are_rejected_by_hpke_setup() {
        let (a, b) = (identity(), identity());
        let (a_pub, b_pub) = (a.public_identity(), b.public_identity());
        let box_id = ConnectId::generate().unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        let ctx = context(&box_id, 1, &a_pub, &b_pub);
        let wrapped = key.wrap_for_recipient(&a, &b_pub, &ctx).unwrap();
        let mut one = [0u8; 32];
        one[0] = 1;
        for point in [[0u8; 32], one] {
            let low = descriptor_for(point);
            let to_low = context(&box_id, 1, &a_pub, &low);
            assert!(key.wrap_for_recipient(&a, &low, &to_low).is_err());
            let from_low = context(&box_id, 1, &low, &b_pub);
            let mut forged = wrapped.clone();
            forged.context = from_low.clone();
            assert!(PasswordBoxKey::unwrap_for_recipient(&forged, &b, &low, &from_low).is_err());
            let mut forged = wrapped.clone();
            forged.enc = BASE64.encode(point);
            assert!(PasswordBoxKey::unwrap_for_recipient(&forged, &b, &a_pub, &ctx).is_err());
        }
    }

    #[test]
    fn local_identity_wrap_restores_same_public_identity() {
        let a = identity();
        let root = MasterKey::generate().unwrap();
        let wrapped = a.wrap(&root).unwrap();
        assert_eq!(BASE64.decode(&wrapped.ciphertext).unwrap().len(), 48);
        let pinned = a.public_identity().key_id;
        let restored = AccountIdentity::unwrap(&wrapped, &root, a.context(), &pinned).unwrap();
        assert!(restored.public_identity() == a.public_identity());
        assert!(AccountIdentity::unwrap(
            &wrapped,
            &MasterKey::generate().unwrap(),
            a.context(),
            &pinned
        )
        .is_err());
        for i in 0..2 {
            let mut expected = a.context().clone();
            if i == 0 {
                expected.account_id = Uuid::new_v4();
            } else {
                expected.identity_version = 2;
            }
            assert!(AccountIdentity::unwrap(&wrapped, &root, &expected, &pinned).is_err());
            let mut forged = wrapped.clone();
            forged.context = expected.clone();
            assert!(AccountIdentity::unwrap(&forged, &root, &expected, &pinned).is_err());
        }
        // Owner-key domain cannot be replayed as an identity wrapper.
        let owner = PasswordBoxKey::generate()
            .unwrap()
            .wrap_for_owner(
                &root,
                &crate::cloud_crypto::OwnerKeyContext {
                    password_box_id: ConnectId::generate().unwrap(),
                    owner_account_id: a.context().account_id,
                    key_epoch: 1,
                },
            )
            .unwrap();
        let mixed = WrappedAccountIdentity {
            format: FORMAT,
            context: a.context().clone(),
            nonce: owner.nonce,
            ciphertext: owner.ciphertext,
        };
        assert!(AccountIdentity::unwrap(&mixed, &root, a.context(), &pinned).is_err());
        let substitute = AccountIdentity::generate(a.context().clone())
            .unwrap()
            .wrap(&root)
            .unwrap();
        assert!(AccountIdentity::unwrap(&substitute, &root, a.context(), &pinned).is_err());
    }

    #[test]
    fn rotation_excludes_removed_member_from_future_epoch_only() {
        let (a, b, c) = (identity(), identity(), identity());
        let (a_pub, b_pub, c_pub) = (
            a.public_identity(),
            b.public_identity(),
            c.public_identity(),
        );
        let box_id = ConnectId::generate().unwrap();
        let old_key = PasswordBoxKey::generate().unwrap();
        let (old_context, old_item) = item(&box_id, 1);
        let old_sealed = old_key.encrypt_item(&old_item, &old_context).unwrap();
        let to_b = context(&box_id, 1, &a_pub, &b_pub);
        let b_old = PasswordBoxKey::unwrap_for_recipient(
            &old_key.wrap_for_recipient(&a, &b_pub, &to_b).unwrap(),
            &b,
            &a_pub,
            &to_b,
        )
        .unwrap();

        // Rotate: new key, epoch 2, wrapped only for C (A keeps it via its owner wrapper).
        let new_key = PasswordBoxKey::generate().unwrap();
        let to_c = context(&box_id, 2, &a_pub, &c_pub);
        let c_wrapper = new_key.wrap_for_recipient(&a, &c_pub, &to_c).unwrap();
        let c_new = PasswordBoxKey::unwrap_for_recipient(&c_wrapper, &c, &a_pub, &to_c).unwrap();
        let (new_context, new_item) = item(&box_id, 2);
        let new_sealed = new_key.encrypt_item(&new_item, &new_context).unwrap();
        assert!(c_new.decrypt_item(&new_sealed, &new_context).unwrap() == new_item);

        assert!(PasswordBoxKey::unwrap_for_recipient(&c_wrapper, &b, &a_pub, &to_c).is_err());
        let mut b_view = to_c.clone();
        b_view.recipient_account_id = b_pub.account_id;
        b_view.recipient_key_id = b_pub.key_id.clone();
        let mut relabelled = c_wrapper.clone();
        relabelled.context = b_view.clone();
        assert!(PasswordBoxKey::unwrap_for_recipient(&relabelled, &b, &a_pub, &b_view).is_err());
        assert!(b_old.decrypt_item(&new_sealed, &new_context).is_err());
        // Not revoked: what B already received stays readable to B.
        assert!(b_old.decrypt_item(&old_sealed, &old_context).unwrap() == old_item);
    }

    /// Interoperability with RFC 9180 Appendix A.2.3 (DHKEM(X25519, HKDF-SHA256),
    /// HKDF-SHA256, ChaCha20Poly1305, Auth mode). The fixture holds the public
    /// RFC values verbatim as lowercase hex: ikmE, ikmR, ikmS, pkEm, pkRm, pkSm,
    /// enc, info and sequence 0 of encryptions as aad, pt, ct.
    #[test]
    fn rfc9180_a2_3_auth_known_answer() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/rfc9180-a2-3-auth.json"
        );
        let raw = std::fs::read_to_string(path).expect("public RFC 9180 A.2.3 fixture");
        let vector: Value = serde_json::from_str(&raw).unwrap();
        let hex = |name: &str| -> Vec<u8> {
            let text = vector[name].as_str().expect(name);
            (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
                .collect()
        };
        let (_, pk_e) = Dhkem::derive_keypair(&hex("ikmE"));
        let (sk_r, pk_r) = Dhkem::derive_keypair(&hex("ikmR"));
        let (sk_s, pk_s) = Dhkem::derive_keypair(&hex("ikmS"));
        assert_eq!(&pk_e.to_bytes()[..], &hex("pkEm")[..]);
        assert_eq!(&pk_r.to_bytes()[..], &hex("pkRm")[..]);
        assert_eq!(&pk_s.to_bytes()[..], &hex("pkSm")[..]);
        assert_eq!(hex("enc"), hex("pkEm"));
        let mut entropy = EphemeralEntropy {
            bytes: Zeroizing::new(hex("ikmE").try_into().unwrap()),
            position: 0,
        };
        let (sent_enc, sent_ct) = hpke::single_shot_seal_with_rng::<Aead, Kdf, Dhkem>(
            &OpModeS::Auth((sk_s, pk_s.clone())),
            &pk_r,
            &hex("info"),
            &hex("pt"),
            &hex("aad"),
            &mut entropy,
        )
        .unwrap();
        assert_eq!(&sent_enc.to_bytes()[..], &hex("enc")[..]);
        assert_eq!(sent_ct, hex("ct"));
        assert_eq!(entropy.position, 32);
        assert_eq!(*entropy.bytes, [0u8; 32]);
        let enc = EncappedKey::from_bytes(&hex("enc")).unwrap();
        let plaintext = hpke::single_shot_open::<Aead, Kdf, Dhkem>(
            &OpModeR::Auth(pk_s),
            &sk_r,
            &enc,
            &hex("info"),
            &hex("ct"),
            &hex("aad"),
        )
        .unwrap();
        assert_eq!(plaintext, hex("pt"));
    }
}
