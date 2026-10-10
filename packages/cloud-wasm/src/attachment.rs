//! Opaque attachment binding. Expected scope is supplied independently by the caller.
use super::{parse, CloudPasswordBox, Plaintext, Session, INVALID, MAX_ENVELOPE};
use passshare_core::cloud_crypto::{AttachmentContext, AttachmentPlaintext, EncryptedAttachment};
use wasm_bindgen::prelude::*;

impl Session {
    /// Authenticate the full item and bind its ordered reference to a single
    /// fetch revision. Independent item/attachment expectations remain required.
    pub(crate) fn verify_attachment_source(
        &self,
        expected: &str,
        source: &str,
    ) -> Result<(), &'static str> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Source {
            item_envelope: String,
            expected_item_context: passshare_core::cloud_crypto::ItemContext,
            item_snapshot_revision: u64,
            attachment_snapshot_revision: u64,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Reference {
            attachment_id: passshare_core::ConnectId,
            attachment_version: u64,
            key_epoch: u64,
        }
        let expected = self.attachment_context(expected)?;
        let source: Source = parse(source, 2_000_000)?;
        if !(1..=9_007_199_254_740_991).contains(&source.item_snapshot_revision)
            || source.item_snapshot_revision != source.attachment_snapshot_revision
            || source.expected_item_context.password_box_id != expected.password_box_id
            || source.expected_item_context.item_id != expected.item_id
            || source.expected_item_context.key_epoch != expected.key_epoch
        {
            return Err(INVALID);
        }
        let envelope = parse(&source.item_envelope, MAX_ENVELOPE)?;
        let item = Plaintext(
            self.key()?
                .decrypt_item(&envelope, &source.expected_item_context)
                .map_err(|_| INVALID)?,
        );
        if item.0.get("id").and_then(serde_json::Value::as_str) != Some(expected.item_id.as_str())
            || item.0.get("version").and_then(serde_json::Value::as_u64)
                != Some(source.expected_item_context.item_version)
        {
            return Err(INVALID);
        }
        let references = item
            .0
            .get("attachments")
            .and_then(serde_json::Value::as_array)
            .ok_or(INVALID)?;
        if references.len() > 1024 {
            return Err(INVALID);
        }
        let mut ids = std::collections::HashSet::new();
        let mut found = false;
        for reference in references {
            let reference: Reference =
                serde::Deserialize::deserialize(reference).map_err(|_| INVALID)?;
            passshare_core::ConnectId::validate(reference.attachment_id.as_str())
                .map_err(|_| INVALID)?;
            if !ids.insert(reference.attachment_id.clone())
                || !(1..=9_007_199_254_740_991).contains(&reference.attachment_version)
                || reference.key_epoch != expected.key_epoch
            {
                return Err(INVALID);
            }
            if reference.attachment_id == expected.attachment_id {
                if reference.attachment_version != expected.attachment_version {
                    return Err(INVALID);
                }
                found = true;
            }
        }
        if found {
            Ok(())
        } else {
            Err(INVALID)
        }
    }
    fn attachment_context(&self, expected: &str) -> Result<AttachmentContext, &'static str> {
        let context: AttachmentContext = parse(expected, 512)?;
        if context.password_box_id != self.owner.password_box_id
            || context.key_epoch != self.owner.key_epoch
        {
            return Err(INVALID);
        }
        context.validate_public().map_err(|_| INVALID)?;
        Ok(context)
    }
    pub(crate) fn encrypt_attachment(
        &self,
        name: String,
        bytes: Vec<u8>,
        expected: &str,
    ) -> Result<String, &'static str> {
        // Take ownership before any fallible scope/key check, including oversize.
        let plaintext = AttachmentPlaintext::new(name, bytes).map_err(|_| INVALID)?;
        let context = self.attachment_context(expected)?;
        let envelope = self
            .key()?
            .encrypt_attachment(&plaintext, &context)
            .map_err(|_| INVALID)?;
        serde_json::to_string(&envelope).map_err(|_| INVALID)
    }
    pub(crate) fn decrypt_attachment(
        &self,
        envelope: &str,
        expected: &str,
    ) -> Result<AttachmentPlaintext, &'static str> {
        let context = self.attachment_context(expected)?;
        let envelope: EncryptedAttachment = parse(envelope, MAX_ENVELOPE)?;
        self.key()?
            .decrypt_attachment(&envelope, &context)
            .map_err(|_| INVALID)
    }
}

/// Owns an authenticated name and file body; drops erase both. No serde/Debug/key export.
#[wasm_bindgen]
pub struct CloudAttachment {
    plaintext: AttachmentPlaintext,
}
#[wasm_bindgen]
impl CloudAttachment {
    pub fn name(&self) -> JsValue {
        JsValue::from_str(self.plaintext.name())
    }
    pub fn content(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(self.plaintext.content())
    }
}
#[wasm_bindgen]
impl CloudPasswordBox {
    pub fn encrypt_attachment(
        &self,
        name: String,
        bytes: Vec<u8>,
        expected_attachment_context: &str,
    ) -> Result<String, JsValue> {
        self.session
            .encrypt_attachment(name, bytes, expected_attachment_context)
            .map_err(JsValue::from_str)
    }
    pub fn decrypt_attachment(
        &self,
        envelope: &str,
        expected_attachment_context: &str,
        attachment_source: &str,
    ) -> Result<CloudAttachment, JsValue> {
        self.session
            .verify_attachment_source(expected_attachment_context, attachment_source)
            .map_err(JsValue::from_str)?;
        self.session
            .decrypt_attachment(envelope, expected_attachment_context)
            .map(|plaintext| CloudAttachment { plaintext })
            .map_err(JsValue::from_str)
    }
}

/// A finite structured-clone surface; object fields/types are checked in Rust.
/// Input bytes never pass through JSON/Base64. SharedArrayBuffer is not accepted.
pub(crate) fn exchange(
    worker: &mut super::worker::WorkerSession,
    data: JsValue,
) -> (JsValue, js_sys::Array) {
    use js_sys::{Array, ArrayBuffer, Object, Reflect, Uint8Array};
    let mut input: Option<Uint8Array> = None;
    let parsed = (|| {
        if let Some(message) = data.as_string() {
            return Ok((message, None));
        }
        if !data.is_object() || data.is_null() || Array::is_array(&data) {
            return Err(INVALID);
        }
        let body = Reflect::get(&data, &"bytes".into()).map_err(|_| INVALID)?;
        let bytes = if body.is_instance_of::<Uint8Array>() {
            body.unchecked_into::<Uint8Array>()
        } else if body.is_instance_of::<ArrayBuffer>() {
            Uint8Array::new(&body)
        } else {
            return Err(INVALID);
        };
        input = Some(bytes.clone());
        let keys = Reflect::own_keys(&data).map_err(|_| INVALID)?;
        if keys.length() != 2
            || !(0..2).all(|i| {
                keys.get(i)
                    .as_string()
                    .is_some_and(|s| s == "message" || s == "bytes")
            })
        {
            return Err(INVALID);
        }
        if !bytes.buffer().is_instance_of::<ArrayBuffer>()
            || bytes.length() as usize > passshare_core::cloud_crypto::MAX_ATTACHMENT_BYTES
        {
            return Err(INVALID);
        }
        let message = Reflect::get(&data, &"message".into())
            .map_err(|_| INVALID)?
            .as_string()
            .ok_or(INVALID)?;
        Ok((message, Some(bytes.to_vec())))
    })();
    let (header, plaintext) = match parsed {
        Ok((message, bytes)) => worker.handle_output(message, bytes),
        Err(_) => (worker.invalid(), None),
    };
    if let Some(bytes) = input {
        bytes.fill(0, 0, bytes.length());
    }
    let transfers = Array::new();
    let Some(plaintext) = plaintext else {
        return (JsValue::from_str(&header), transfers);
    };
    let bytes = Uint8Array::from(plaintext.content());
    let object = Object::new();
    // Fresh ordinary object, fixed keys: setters cannot invoke caller code.
    Reflect::set(&object, &"message".into(), &JsValue::from_str(&header)).expect("fresh object");
    Reflect::set(&object, &"bytes".into(), &bytes).expect("fresh object");
    transfers.push(&bytes.buffer());
    (object.into(), transfers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::{json, Value};
    use zeroize::Zeroizing;
    #[test]
    fn native_exported_binding_owns_the_attachment_dto() {
        let owner=json!({"passwordBoxId":"a".repeat(26),"ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1}).to_string();
        let mut binding = CloudPasswordBox::new(&owner).unwrap();
        let context=json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"attachmentId":"c".repeat(26),"attachmentVersion":1,"keyEpoch":1}).to_string();
        let item_context = json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"itemVersion":3,"keyEpoch":1});
        let item = json!({"id":"b".repeat(26),"version":3,"vault":{"id":"a".repeat(26)},"attachments":[{"attachmentId":"c".repeat(26),"attachmentVersion":1,"keyEpoch":1}]});
        let source=json!({"itemEnvelope":binding.session.encrypt(item.to_string(),&item_context.to_string()).unwrap(),"expectedItemContext":item_context,"itemSnapshotRevision":17,"attachmentSnapshotRevision":17}).to_string();
        let envelope = binding
            .encrypt_attachment("添付🦀".into(), vec![0, 255, 128], &context)
            .unwrap();
        let output = binding
            .decrypt_attachment(&envelope, &context, &source)
            .unwrap();
        assert!(output.plaintext.name() == "添付🦀" && output.plaintext.content() == [0, 255, 128]);
        drop(output);
        binding.lock();
        assert!(binding.is_locked());
    }
    #[test]
    fn authenticated_item_reference_and_same_snapshot_are_required() {
        let owner=json!({"passwordBoxId":"a".repeat(26),"ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1}).to_string();
        let session = Session::generate(&owner).unwrap();
        let context=json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"attachmentId":"c".repeat(26),"attachmentVersion":1,"keyEpoch":1}).to_string();
        let item_context = json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"itemVersion":3,"keyEpoch":1});
        let item = json!({"id":"b".repeat(26),"version":3,"vault":{"id":"a".repeat(26)},"attachments":[{"attachmentId":"c".repeat(26),"attachmentVersion":1,"keyEpoch":1}]});
        let source = json!({"itemEnvelope":session.encrypt(item.to_string(),&item_context.to_string()).unwrap(),"expectedItemContext":item_context,"itemSnapshotRevision":17,"attachmentSnapshotRevision":17});
        assert!(session
            .verify_attachment_source(&context, &source.to_string())
            .is_ok());
        for (field, value) in [
            ("itemSnapshotRevision", json!(18)),
            ("attachmentSnapshotRevision", json!(18)),
            ("itemSnapshotRevision", Value::Null),
            ("attachmentSnapshotRevision", json!(17.0)),
            ("unknown", Value::Null),
            ("itemEnvelope", json!("{}")),
        ] {
            let mut bad = source.clone();
            bad[field] = value;
            assert!(session
                .verify_attachment_source(&context, &bad.to_string())
                .is_err());
        }
        for (field, value) in [
            ("attachmentId", json!("d".repeat(26))),
            ("attachmentVersion", json!(2)),
            ("keyEpoch", json!(2)),
            ("attachmentVersion", Value::Null),
            ("unknown", json!("private-copy-must-not-escape")),
        ] {
            let mut bad = item.clone();
            bad["attachments"][0][field] = value;
            let mut bad_source = source.clone();
            bad_source["itemEnvelope"] = json!(session
                .encrypt(bad.to_string(), &item_context.to_string())
                .unwrap());
            assert!(session
                .verify_attachment_source(&context, &bad_source.to_string())
                .is_err());
        }
        let mut duplicate = item.clone();
        duplicate["attachments"]
            .as_array_mut()
            .unwrap()
            .push(item["attachments"][0].clone());
        let mut bad = source;
        bad["itemEnvelope"] = json!(session
            .encrypt(duplicate.to_string(), &item_context.to_string())
            .unwrap());
        assert!(session
            .verify_attachment_source(&context, &bad.to_string())
            .is_err());
        assert!(session.wrap(String::new()).is_err());
    }
    #[test]
    fn opaque_native_attachment_bytes_bounds_context_key_and_purpose() {
        let owner = json!({"passwordBoxId":"a".repeat(26),"ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1}).to_string();
        let mut session = Session::generate(&owner).unwrap();
        let context = json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"attachmentId":"c".repeat(26),"attachmentVersion":1,"keyEpoch":1});
        for bytes in [vec![], vec![0, 255, 128, 1], vec![255; 1_048_576]] {
            let envelope = session
                .encrypt_attachment("添付🦀\0".into(), bytes.clone(), &context.to_string())
                .unwrap();
            let plain = session
                .decrypt_attachment(&envelope, &context.to_string())
                .unwrap();
            assert!(plain.name() == "添付🦀\0" && plain.content() == bytes);
            assert!(Session::generate(&owner)
                .unwrap()
                .decrypt_attachment(&envelope, &context.to_string())
                .is_err());
            for (key, value) in [
                ("passwordBoxId", json!("d".repeat(26))),
                ("itemId", json!("d".repeat(26))),
                ("attachmentId", json!("d".repeat(26))),
                ("attachmentVersion", json!(2)),
                ("keyEpoch", json!(2)),
            ] {
                let mut wrong = context.clone();
                wrong[key] = value;
                assert!(session
                    .decrypt_attachment(&envelope, &wrong.to_string())
                    .is_err());
            }
            let mut tampered: Value = serde_json::from_str(&envelope).unwrap();
            let cipher = tampered["ciphertext"].as_str().unwrap();
            tampered["ciphertext"] = json!(format!(
                "{}{}",
                if cipher.starts_with('A') { "B" } else { "A" },
                &cipher[1..]
            ));
            assert!(session
                .decrypt_attachment(&tampered.to_string(), &context.to_string())
                .is_err());
            let item_context = json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"itemVersion":1,"keyEpoch":1}).to_string();
            assert!(session.decrypt(&envelope, &item_context).is_err());
            let item = session
                .encrypt(
                    json!({"id":"b".repeat(26),"version":1,"vault":{"id":"a".repeat(26)}})
                        .to_string(),
                    &item_context,
                )
                .unwrap();
            assert!(session
                .decrypt_attachment(&item, &context.to_string())
                .is_err());
        }
        assert!(session
            .encrypt_attachment(String::new(), vec![0; 1_048_577], &context.to_string())
            .is_err());
        assert!(session
            .encrypt_attachment("x".repeat(4097), vec![], &context.to_string())
            .is_err());
        session.can_wrap_owner = false;
        assert!(session
            .encrypt_attachment(String::new(), vec![], &context.to_string())
            .is_ok());
        let secret = Zeroizing::new(
            super::super::B64.encode(
                passshare_core::crypto::MasterKey::generate()
                    .unwrap()
                    .as_bytes(),
            ),
        );
        assert!(session.wrap(secret.to_string()).is_err());
        assert!(session.recovery_material().is_err());
        session.lock();
        assert!(session
            .encrypt_attachment(String::new(), vec![], &context.to_string())
            .is_err());
    }
}
