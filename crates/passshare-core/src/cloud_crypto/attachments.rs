//! Independent file envelopes; item JSON contains only ordered file references.
//! Expected context comes from trusted caller state, never from this envelope.
use chacha20poly1305::aead::AeadInOut;

use super::*;

/// Technical per-file bound, not a commercial plan/storage allowance.
pub const MAX_ATTACHMENT_BYTES: usize = 1024 * 1024;
/// UTF-8 bytes, not characters. Names are encrypted, including an empty name.
pub const MAX_ATTACHMENT_NAME_BYTES: usize = 4096;
const HEADER_BYTES: usize = 4;
const MAX_FRAME_BYTES: usize = HEADER_BYTES + MAX_ATTACHMENT_NAME_BYTES + MAX_ATTACHMENT_BYTES;

/// File revision is independent of item JSON revision. Every file replacement
/// or key rotation advances it; ordinary item edits need not reseal the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "ContextWire")]
pub struct AttachmentContext {
    pub password_box_id: ConnectId,
    pub item_id: ConnectId,
    pub attachment_id: ConnectId,
    pub attachment_version: u64,
    pub key_epoch: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextWire {
    password_box_id: ConnectId,
    item_id: ConnectId,
    attachment_id: ConnectId,
    attachment_version: u64,
    key_epoch: u64,
}

impl TryFrom<ContextWire> for AttachmentContext {
    type Error = CloudCryptoError;
    fn try_from(wire: ContextWire) -> Result<Self> {
        let context = Self {
            password_box_id: wire.password_box_id,
            item_id: wire.item_id,
            attachment_id: wire.attachment_id,
            attachment_version: wire.attachment_version,
            key_epoch: wire.key_epoch,
        };
        context.validate_public()?;
        Ok(context)
    }
}

/// Only public routing context, authenticated content length, nonce and
/// ciphertext leave the client. The encrypted name length is not published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "EnvelopeWire")]
pub struct EncryptedAttachment {
    pub format: u32,
    pub context: AttachmentContext,
    pub content_bytes: u64,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvelopeWire {
    format: u32,
    context: AttachmentContext,
    content_bytes: u64,
    nonce: String,
    ciphertext: String,
}

impl TryFrom<EnvelopeWire> for EncryptedAttachment {
    type Error = CloudCryptoError;
    fn try_from(wire: EnvelopeWire) -> Result<Self> {
        let envelope = Self {
            format: wire.format,
            context: wire.context,
            content_bytes: wire.content_bytes,
            nonce: wire.nonce,
            ciphertext: wire.ciphertext,
        };
        envelope.validate_public()?;
        Ok(envelope)
    }
}

/// Owned plaintext DTO. No Debug/Clone/serde/raw-key interface. Both fields
/// erase on drop, including constructor and post-authentication parse failures.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct AttachmentPlaintext {
    name: String,
    content: Vec<u8>,
}

impl AttachmentPlaintext {
    pub fn new(name: String, content: Vec<u8>) -> Result<Self> {
        let plaintext = Self { name, content };
        plaintext.validate()?;
        Ok(plaintext)
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn content(&self) -> &[u8] {
        &self.content
    }
    fn validate(&self) -> Result<()> {
        if self.name.len() > MAX_ATTACHMENT_NAME_BYTES || self.content.len() > MAX_ATTACHMENT_BYTES
        {
            return Err(CloudCryptoError::InvalidPayload);
        }
        Ok(())
    }
}

impl AttachmentContext {
    pub fn validate_public(&self) -> Result<()> {
        for id in [&self.password_box_id, &self.item_id, &self.attachment_id] {
            ConnectId::validate(id.as_str()).map_err(|_| CloudCryptoError::InvalidContext)?;
        }
        if !(1..=MAX_JSON_INTEGER).contains(&self.attachment_version)
            || !(1..=MAX_JSON_INTEGER).contains(&self.key_epoch)
        {
            return Err(CloudCryptoError::InvalidContext);
        }
        Ok(())
    }
    fn aad(&self, content_bytes: u64) -> Result<Vec<u8>> {
        self.validate_public()?;
        if content_bytes > MAX_ATTACHMENT_BYTES as u64 {
            return Err(CloudCryptoError::InvalidEnvelope);
        }
        serde_json::to_vec(&("passshare.cloud.attachment", FORMAT, self, content_bytes))
            .map_err(|_| CloudCryptoError::InvalidContext)
    }
}

fn decode_nonce(text: &str) -> Result<[u8; 24]> {
    if text.len() != 32 {
        return Err(CloudCryptoError::InvalidEnvelope);
    }
    BASE64
        .decode(text)
        .map_err(|_| CloudCryptoError::InvalidEnvelope)?
        .try_into()
        .map_err(|_| CloudCryptoError::InvalidEnvelope)
}

impl EncryptedAttachment {
    fn check_header(&self) -> Result<()> {
        self.context.validate_public()?;
        if self.format != FORMAT
            || self.content_bytes > MAX_ATTACHMENT_BYTES as u64
            || self.ciphertext.len() > 4 * (MAX_FRAME_BYTES + TAG_BYTES).div_ceil(3)
        {
            return Err(CloudCryptoError::InvalidEnvelope);
        }
        Ok(())
    }
    fn check_ciphertext_len(&self, len: usize) -> Result<()> {
        let min = HEADER_BYTES + self.content_bytes as usize + TAG_BYTES;
        if !(min..=min + MAX_ATTACHMENT_NAME_BYTES).contains(&len) {
            return Err(CloudCryptoError::InvalidEnvelope);
        }
        Ok(())
    }
    /// Structural check only: no authentication, membership or deletion check.
    /// Standard Base64 requires padding and rejects nonzero trailing pad bits.
    pub fn validate_public(&self) -> Result<()> {
        self.check_header()?;
        decode_nonce(&self.nonce)?;
        let ciphertext = BASE64
            .decode(&self.ciphertext)
            .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
        self.check_ciphertext_len(ciphertext.len())
    }
}

impl PasswordBoxKey {
    pub fn encrypt_attachment(
        &self,
        plaintext: &AttachmentPlaintext,
        context: &AttachmentContext,
    ) -> Result<EncryptedAttachment> {
        plaintext.validate()?;
        let content_bytes = plaintext.content.len() as u64;
        let aad = context.aad(content_bytes)?;
        // Reserve exactly once; no discarded allocation ever holds plaintext.
        let size = HEADER_BYTES + plaintext.name.len() + plaintext.content.len();
        let mut buffer = Zeroizing::new(Vec::with_capacity(size + TAG_BYTES));
        buffer.extend_from_slice(&(plaintext.name.len() as u32).to_be_bytes());
        buffer.extend_from_slice(plaintext.name.as_bytes());
        buffer.extend_from_slice(&plaintext.content);
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| CloudCryptoError::EntropyUnavailable)?;
        let cipher = XChaCha20Poly1305::new_from_slice(&self.0)
            .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
        cipher
            .encrypt_in_place(&XNonce::from(nonce), &aad, &mut *buffer)
            .map_err(|_| CloudCryptoError::AuthenticationFailed)?;
        Ok(EncryptedAttachment {
            format: FORMAT,
            context: context.clone(),
            content_bytes,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(&*buffer),
        })
    }

    pub fn decrypt_attachment(
        &self,
        envelope: &EncryptedAttachment,
        expected: &AttachmentContext,
    ) -> Result<AttachmentPlaintext> {
        expected.validate_public()?;
        if &envelope.context != expected {
            return Err(CloudCryptoError::InvalidContext);
        }
        envelope.check_header()?;
        let nonce = decode_nonce(&envelope.nonce)?;
        let aad = expected.aad(envelope.content_bytes)?;
        // Own the buffer before in-place decryption: any partially decrypted
        // bytes also erase on authentication failure. No secret parse errors.
        let mut buffer = Zeroizing::new(
            BASE64
                .decode(&envelope.ciphertext)
                .map_err(|_| CloudCryptoError::InvalidEnvelope)?,
        );
        envelope.check_ciphertext_len(buffer.len())?;
        let cipher = XChaCha20Poly1305::new_from_slice(&self.0)
            .map_err(|_| CloudCryptoError::InvalidEnvelope)?;
        cipher
            .decrypt_in_place(&XNonce::from(nonce), &aad, &mut *buffer)
            .map_err(|_| CloudCryptoError::AuthenticationFailed)?;
        let name_len = u32::from_be_bytes(
            buffer[..HEADER_BYTES]
                .try_into()
                .map_err(|_| CloudCryptoError::InvalidPayload)?,
        ) as usize;
        if name_len > MAX_ATTACHMENT_NAME_BYTES
            || buffer.len() != HEADER_BYTES + name_len + envelope.content_bytes as usize
        {
            return Err(CloudCryptoError::InvalidPayload);
        }
        let name = std::str::from_utf8(&buffer[HEADER_BYTES..HEADER_BYTES + name_len])
            .map_err(|_| CloudCryptoError::InvalidPayload)?;
        // Construct the erasing DTO before allocating/copying its contents.
        let mut plaintext = AttachmentPlaintext {
            name: String::new(),
            content: Vec::new(),
        };
        plaintext.name.push_str(name);
        plaintext
            .content
            .extend_from_slice(&buffer[HEADER_BYTES + name_len..]);
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> AttachmentContext {
        AttachmentContext {
            password_box_id: ConnectId::generate().unwrap(),
            item_id: ConnectId::generate().unwrap(),
            attachment_id: ConnectId::generate().unwrap(),
            attachment_version: 1,
            key_epoch: 1,
        }
    }
    fn plaintext() -> AttachmentPlaintext {
        AttachmentPlaintext::new("添付-秘密.bin".to_owned(), vec![0, 0xff, 0x80, 0x41, 0]).unwrap()
    }
    fn fixture() -> (PasswordBoxKey, AttachmentContext, EncryptedAttachment) {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let envelope = key.encrypt_attachment(&plaintext(), &context).unwrap();
        assert!(key.decrypt_attachment(&envelope, &context).is_ok());
        (key, context, envelope)
    }
    fn matches_plaintext(value: &AttachmentPlaintext, expected: &AttachmentPlaintext) -> bool {
        value.name() == expected.name() && value.content() == expected.content()
    }

    #[test]
    fn arbitrary_bytes_and_unicode_name_round_trip_with_fresh_nonces() {
        let (key, context, envelope) = fixture();
        let second = key.encrypt_attachment(&plaintext(), &context).unwrap();
        assert!(envelope.nonce != second.nonce && envelope.ciphertext != second.ciphertext);
        let wire = serde_json::to_string(&envelope).unwrap();
        assert!(!wire.contains(plaintext().name()));
        let decoded: EncryptedAttachment = serde_json::from_str(&wire).unwrap();
        assert!(matches_plaintext(
            &key.decrypt_attachment(&decoded, &context).unwrap(),
            &plaintext()
        ));
    }

    #[test]
    fn multiple_attachments_keep_reference_order_and_original_contents() {
        let key = PasswordBoxKey::generate().unwrap();
        let first = context();
        let mut second = first.clone();
        second.attachment_id = ConnectId::generate().unwrap();
        let a = plaintext();
        let b = AttachmentPlaintext::new("別の添付".to_owned(), vec![0xff, 0, 1, 2]).unwrap();
        let references = [(&second, &b), (&first, &a)];
        let sealed: Vec<_> = references
            .iter()
            .map(|(context, bytes)| key.encrypt_attachment(bytes, context).unwrap())
            .collect();
        for (envelope, (expected, bytes)) in sealed.iter().zip(references) {
            assert!(matches_plaintext(
                &key.decrypt_attachment(envelope, expected).unwrap(),
                bytes
            ));
        }
        assert!(matches!(
            key.decrypt_attachment(&sealed[0], &first),
            Err(CloudCryptoError::InvalidContext)
        ));
    }

    macro_rules! context_rejection {
        ($expected_test:ident, $forged_test:ident, $field:ident, $value:expr) => {
            #[test]
            fn $expected_test() {
                let (key, mut expected, envelope) = fixture();
                expected.$field = $value;
                assert!(matches!(
                    key.decrypt_attachment(&envelope, &expected),
                    Err(CloudCryptoError::InvalidContext)
                ));
            }
            #[test]
            fn $forged_test() {
                let (key, _, mut envelope) = fixture();
                envelope.context.$field = $value;
                assert!(matches!(
                    key.decrypt_attachment(&envelope, &envelope.context),
                    Err(CloudCryptoError::AuthenticationFailed)
                ));
            }
        };
    }
    context_rejection!(
        wrong_box,
        forged_box,
        password_box_id,
        ConnectId::generate().unwrap()
    );
    context_rejection!(
        wrong_item,
        forged_item,
        item_id,
        ConnectId::generate().unwrap()
    );
    context_rejection!(
        wrong_file,
        forged_file,
        attachment_id,
        ConnectId::generate().unwrap()
    );
    context_rejection!(wrong_version, forged_version, attachment_version, 2);
    context_rejection!(wrong_epoch, forged_epoch, key_epoch, 2);

    #[test]
    fn wrong_key_is_rejected() {
        let (_, context, envelope) = fixture();
        assert!(matches!(
            PasswordBoxKey::generate()
                .unwrap()
                .decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn ciphertext_tampering_is_rejected() {
        let (key, context, mut envelope) = fixture();
        let mut bytes = BASE64.decode(&envelope.ciphertext).unwrap();
        bytes[0] ^= 1;
        envelope.ciphertext = BASE64.encode(bytes);
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn tag_tampering_is_rejected() {
        let (key, context, mut envelope) = fixture();
        let mut bytes = BASE64.decode(&envelope.ciphertext).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        envelope.ciphertext = BASE64.encode(bytes);
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn public_length_tampering_reaches_authentication_and_is_rejected() {
        let (key, context, mut envelope) = fixture();
        envelope.content_bytes += 1;
        assert!(envelope.validate_public().is_ok());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn valid_nonce_substitution_is_rejected() {
        let (key, context, mut envelope) = fixture();
        let mut nonce = BASE64.decode(&envelope.nonce).unwrap();
        nonce[0] ^= 1;
        envelope.nonce = BASE64.encode(nonce);
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn zero_byte_file_and_empty_name_round_trip() {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let bytes = AttachmentPlaintext::new(String::new(), Vec::new()).unwrap();
        let envelope = key.encrypt_attachment(&bytes, &context).unwrap();
        assert!(envelope.content_bytes == 0);
        assert!(BASE64.decode(&envelope.ciphertext).unwrap().len() == HEADER_BYTES + TAG_BYTES);
        assert!(matches_plaintext(
            &key.decrypt_attachment(&envelope, &context).unwrap(),
            &bytes
        ));
    }
    #[test]
    fn maximum_file_and_utf8_name_round_trip() {
        let key = PasswordBoxKey::generate().unwrap();
        let mut context = context();
        context.attachment_version = MAX_JSON_INTEGER;
        context.key_epoch = MAX_JSON_INTEGER;
        let bytes =
            AttachmentPlaintext::new("名".repeat(1365) + "x", vec![0xff; MAX_ATTACHMENT_BYTES])
                .unwrap();
        let envelope = key.encrypt_attachment(&bytes, &context).unwrap();
        assert!(envelope.content_bytes == MAX_ATTACHMENT_BYTES as u64);
        assert!(envelope.ciphertext.len() == 4 * (MAX_FRAME_BYTES + TAG_BYTES).div_ceil(3));
        assert!(envelope.validate_public().is_ok());
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= 1_404_000);
        assert!(matches_plaintext(
            &key.decrypt_attachment(&envelope, &context).unwrap(),
            &bytes
        ));
    }
    #[test]
    fn file_one_byte_above_maximum_is_rejected() {
        assert!(matches!(
            AttachmentPlaintext::new(String::new(), vec![0; MAX_ATTACHMENT_BYTES + 1]),
            Err(CloudCryptoError::InvalidPayload)
        ));
    }
    #[test]
    fn name_one_utf8_byte_above_maximum_is_rejected() {
        assert!(matches!(
            AttachmentPlaintext::new("名".repeat(1365) + "xx", Vec::new()),
            Err(CloudCryptoError::InvalidPayload)
        ));
    }

    macro_rules! invalid_envelope {
        ($test:ident, $field:ident, $value:expr) => {
            #[test]
            fn $test() {
                let (key, context, mut envelope) = fixture();
                envelope.$field = $value;
                assert!(matches!(
                    key.decrypt_attachment(&envelope, &context),
                    Err(CloudCryptoError::InvalidEnvelope)
                ));
                assert!(envelope.validate_public().is_err());
                assert!(serde_json::from_str::<EncryptedAttachment>(
                    &serde_json::to_string(&envelope).unwrap()
                )
                .is_err());
            }
        };
    }
    invalid_envelope!(unsupported_format, format, FORMAT + 1);
    invalid_envelope!(short_nonce, nonce, BASE64.encode([0u8; 23]));
    invalid_envelope!(long_nonce, nonce, BASE64.encode([0u8; 25]));
    invalid_envelope!(invalid_nonce_alphabet, nonce, "!".repeat(32));
    invalid_envelope!(nonce_base64_whitespace, nonce, " ".repeat(32));
    invalid_envelope!(invalid_ciphertext_alphabet, ciphertext, "!".repeat(32));
    invalid_envelope!(noncanonical_pad_bits, ciphertext, "AB==".to_owned());
    invalid_envelope!(unpadded_ciphertext, ciphertext, "AA".to_owned());
    invalid_envelope!(extra_padding, ciphertext, "AAAA====".to_owned());
    invalid_envelope!(ciphertext_whitespace, ciphertext, "AAAA\n".to_owned());
    invalid_envelope!(
        truncated_frame,
        ciphertext,
        BASE64.encode([0u8; HEADER_BYTES + TAG_BYTES - 1])
    );
    invalid_envelope!(
        oversized_ciphertext,
        ciphertext,
        "A".repeat(4 * (MAX_FRAME_BYTES + TAG_BYTES).div_ceil(3) + 4)
    );
    invalid_envelope!(
        oversized_public_length,
        content_bytes,
        MAX_ATTACHMENT_BYTES as u64 + 1
    );
    invalid_envelope!(overflowing_public_length, content_bytes, u64::MAX);

    #[test]
    fn context_deserialization_rejects_invalid_ids_and_integer_ranges() {
        let context = context();
        let base = serde_json::to_value(&context).unwrap();
        for field in ["passwordBoxId", "itemId", "attachmentId"] {
            let mut value = base.clone();
            value[field] = serde_json::json!("invalid");
            assert!(serde_json::from_value::<AttachmentContext>(value).is_err());
        }
        for field in ["attachmentVersion", "keyEpoch"] {
            for invalid in [
                serde_json::json!(0),
                serde_json::json!(MAX_JSON_INTEGER + 1),
                serde_json::json!(u64::MAX),
                serde_json::json!(-1),
                serde_json::json!(1.5),
                serde_json::json!("1"),
                Value::Null,
            ] {
                let mut value = base.clone();
                value[field] = invalid;
                assert!(serde_json::from_value::<AttachmentContext>(value).is_err());
            }
        }
    }
    #[test]
    fn unknown_missing_duplicate_and_mistyped_attributes_are_rejected() {
        let (_, _, envelope) = fixture();
        let base = serde_json::to_value(&envelope).unwrap();
        for field in ["format", "context", "contentBytes", "nonce", "ciphertext"] {
            let mut value = base.clone();
            value.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<EncryptedAttachment>(value).is_err());
        }
        for path in ["", "/context"] {
            let mut value = base.clone();
            value.pointer_mut(path).unwrap()["extra"] = Value::Null;
            assert!(serde_json::from_value::<EncryptedAttachment>(value).is_err());
        }
        for invalid in [
            serde_json::json!(-1),
            serde_json::json!(0.5),
            serde_json::json!("0"),
            Value::Null,
        ] {
            let mut value = base.clone();
            value["contentBytes"] = invalid;
            assert!(serde_json::from_value::<EncryptedAttachment>(value).is_err());
        }
        let wire = serde_json::to_string(&envelope).unwrap();
        let duplicate = wire.replacen("\"format\":1", "\"format\":1,\"format\":1", 1);
        assert!(duplicate != wire);
        assert!(serde_json::from_str::<EncryptedAttachment>(&duplicate).is_err());
        let duplicate = wire.replacen("\"keyEpoch\":1", "\"keyEpoch\":1,\"keyEpoch\":1", 1);
        assert!(duplicate != wire);
        assert!(serde_json::from_str::<EncryptedAttachment>(&duplicate).is_err());
    }

    #[test]
    fn directly_constructed_invalid_context_is_rejected_before_crypto() {
        let (key, context, mut envelope) = fixture();
        for field in 0..2 {
            for value in [0, MAX_JSON_INTEGER + 1, u64::MAX] {
                let mut invalid = context.clone();
                if field == 0 {
                    invalid.attachment_version = value;
                } else {
                    invalid.key_epoch = value;
                }
                assert!(matches!(
                    key.encrypt_attachment(&plaintext(), &invalid),
                    Err(CloudCryptoError::InvalidContext)
                ));
                envelope.context = invalid.clone();
                assert!(matches!(
                    key.decrypt_attachment(&envelope, &invalid),
                    Err(CloudCryptoError::InvalidContext)
                ));
            }
        }
    }

    #[test]
    fn decoded_ciphertext_over_maximum_with_same_base64_length_is_rejected() {
        let (_, _, mut envelope) = fixture();
        envelope.content_bytes = MAX_ATTACHMENT_BYTES as u64;
        let max = MAX_FRAME_BYTES + TAG_BYTES;
        envelope.ciphertext = BASE64.encode(vec![0u8; max]);
        let encoded_len = envelope.ciphertext.len();
        assert!(envelope.validate_public().is_ok());
        envelope.ciphertext = BASE64.encode(vec![0u8; max + 1]);
        assert!(envelope.ciphertext.len() == encoded_len);
        assert!(matches!(
            envelope.validate_public(),
            Err(CloudCryptoError::InvalidEnvelope)
        ));
    }

    #[test]
    fn noncanonical_pad_bits_of_otherwise_valid_size_are_rejected() {
        let (key, context, _) = fixture();
        // A 31-byte frame/tag has two trailing padding characters.
        let bytes = AttachmentPlaintext::new(String::new(), vec![0; 11]).unwrap();
        let mut envelope = key.encrypt_attachment(&bytes, &context).unwrap();
        let mut text = envelope.ciphertext.into_bytes();
        assert!(text.ends_with(b"=="));
        // Low four bits of the last significant sextet must be zero.
        let last = text.len() - 3;
        text[last] = match text[last] {
            b'A' => b'B',
            b'Q' => b'R',
            b'g' => b'h',
            b'w' => b'x',
            _ => unreachable!(),
        };
        envelope.ciphertext = String::from_utf8(text).unwrap();
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::InvalidEnvelope)
        ));
    }

    fn sealed_frame(
        key: &PasswordBoxKey,
        context: &AttachmentContext,
        frame: &[u8],
        content_bytes: u64,
        aad: &[u8],
    ) -> EncryptedAttachment {
        let (nonce, ciphertext) = seal(frame, &key.0, aad).unwrap();
        EncryptedAttachment {
            format: FORMAT,
            context: context.clone(),
            content_bytes,
            nonce,
            ciphertext,
        }
    }
    fn valid_frame() -> Zeroizing<Vec<u8>> {
        Zeroizing::new(vec![0, 0, 0, 1, b'x', 0xff])
    }
    #[test]
    fn authenticated_invalid_utf8_is_rejected() {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let frame = Zeroizing::new(vec![0, 0, 0, 1, 0xff, 0]);
        let envelope = sealed_frame(&key, &context, &frame, 1, &context.aad(1).unwrap());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::InvalidPayload)
        ));
    }
    #[test]
    fn authenticated_wrong_name_length_is_rejected() {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let frame = Zeroizing::new(vec![0xff, 0xff, 0xff, 0xff, 0, 0]);
        let envelope = sealed_frame(&key, &context, &frame, 1, &context.aad(1).unwrap());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::InvalidPayload)
        ));
    }
    #[test]
    fn authenticated_wrong_content_length_is_rejected() {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let envelope = sealed_frame(&key, &context, &valid_frame(), 0, &context.aad(0).unwrap());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::InvalidPayload)
        ));
    }

    #[test]
    fn item_aad_cannot_open_as_attachment_even_with_same_key_and_valid_frame() {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let item = ItemContext {
            password_box_id: context.password_box_id.clone(),
            item_id: context.item_id.clone(),
            item_version: 1,
            key_epoch: 1,
        };
        let envelope = sealed_frame(&key, &context, &valid_frame(), 1, &item.aad().unwrap());
        assert!(envelope.validate_public().is_ok());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn owner_key_aad_cannot_open_as_attachment_even_with_same_key_and_valid_frame() {
        let key = PasswordBoxKey::generate().unwrap();
        let context = context();
        let owner = OwnerKeyContext {
            password_box_id: context.password_box_id.clone(),
            owner_account_id: Uuid::new_v4(),
            key_epoch: 1,
        };
        let envelope = sealed_frame(&key, &context, &valid_frame(), 1, &owner.aad().unwrap());
        assert!(envelope.validate_public().is_ok());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }

    #[test]
    fn account_identity_wrapper_cannot_open_as_attachment_with_same_key() {
        let root = MasterKey::generate().unwrap();
        let key = PasswordBoxKey(*root.as_bytes());
        let identity = AccountIdentity::generate(AccountIdentityContext {
            account_id: Uuid::new_v4(),
            identity_version: 1,
        })
        .unwrap();
        let wrapped = identity.wrap(&root).unwrap();
        let context = context();
        let envelope = EncryptedAttachment {
            format: FORMAT,
            context: context.clone(),
            content_bytes: 28,
            nonce: wrapped.nonce,
            ciphertext: wrapped.ciphertext,
        };
        assert!(envelope.validate_public().is_ok());
        assert!(matches!(
            key.decrypt_attachment(&envelope, &context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn attachment_aad_cannot_open_as_item() {
        let (key, context, envelope) = fixture();
        let item_context = ItemContext {
            password_box_id: context.password_box_id,
            item_id: context.item_id,
            item_version: 1,
            key_epoch: 1,
        };
        let item = EncryptedItem {
            format: FORMAT,
            context: item_context.clone(),
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
        };
        assert!(matches!(
            key.decrypt_item(&item, &item_context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn attachment_aad_cannot_unwrap_as_owner_key() {
        let root = MasterKey::generate().unwrap();
        let key = PasswordBoxKey(*root.as_bytes());
        let context = context();
        let bytes = AttachmentPlaintext::new(String::new(), vec![0; 28]).unwrap();
        let envelope = key.encrypt_attachment(&bytes, &context).unwrap();
        let owner_context = OwnerKeyContext {
            password_box_id: context.password_box_id,
            owner_account_id: Uuid::new_v4(),
            key_epoch: 1,
        };
        let owner = WrappedPasswordBoxKey {
            format: FORMAT,
            context: owner_context.clone(),
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
        };
        // Exact wrapped-key ciphertext size, so failure tests AAD, not length.
        assert!(BASE64.decode(&owner.ciphertext).unwrap().len() == 32 + TAG_BYTES);
        assert!(matches!(
            PasswordBoxKey::unwrap_for_owner(&owner, &root, &owner_context),
            Err(CloudCryptoError::AuthenticationFailed)
        ));
    }
    #[test]
    fn plaintext_dto_implements_explicit_and_drop_erasure() {
        fn erasing<T: Zeroize + ZeroizeOnDrop>() {}
        erasing::<AttachmentPlaintext>();
        let mut value = plaintext();
        value.zeroize();
        assert!(value.name().is_empty() && value.content().is_empty());
    }
}
