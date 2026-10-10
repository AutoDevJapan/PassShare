//! Offline recovery uses a separate random code and an existing owner wrapper.
//! Only the sealed bundle belongs in the saved file; the code is kept separately.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use passshare_core::crypto::MasterKey;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use super::{CloudPasswordBox, OwnerBundle, Session, INVALID};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Material<'a> {
    format: u32,
    recovery_code: &'a str,
    bundle: OwnerBundle,
}

impl Session {
    pub(super) fn recovery_material(&self) -> Result<Zeroizing<String>, &'static str> {
        // Reuse the same owner-only permission, context binding and Argon2/AEAD
        // as password wrapping. Recipient sessions cannot mint an owner wrapper.
        self.key()?;
        if !self.can_wrap_owner {
            return Err(INVALID);
        }
        let random = MasterKey::generate().map_err(|_| INVALID)?;
        let code = Zeroizing::new(B64.encode(random.as_bytes()));
        let sealed = self.wrap(code.to_string())?;
        let bundle: OwnerBundle = super::parse(&sealed, 2048)?;
        // The only plaintext here is the intentionally exported recovery code.
        // Serialization fits one allocation; no recovery code is retained by Session.
        let material = Material {
            format: 1,
            recovery_code: &code,
            bundle,
        };
        let size = 4096;
        let mut bytes = Zeroizing::new(Vec::with_capacity(size));
        serde_json::to_writer(&mut *bytes, &material).map_err(|_| INVALID)?;
        if bytes.len() > size {
            return Err(INVALID);
        }
        String::from_utf8(std::mem::take(&mut *bytes))
            .map(Zeroizing::new)
            .map_err(|error| {
                use zeroize::Zeroize;
                error.into_bytes().zeroize();
                INVALID
            })
    }

    pub(super) fn recover(
        bundle: &str,
        code: String,
        expected_owner: &str,
    ) -> Result<Self, &'static str> {
        let mut code = Zeroizing::new(code);
        if code.len() != 44 {
            return Err(INVALID);
        }
        let bytes = Zeroizing::new(B64.decode(code.as_bytes()).map_err(|_| INVALID)?);
        if bytes.len() != 32 || *Zeroizing::new(B64.encode(&*bytes)) != *code {
            return Err(INVALID);
        }
        // The expected owner/box/epoch comes from the caller's trusted live scope,
        // never from the recovery file. Recovery alone performs no HTTP mutation.
        Self::unlock(bundle, std::mem::take(&mut *code), expected_owner)
    }
}

#[wasm_bindgen]
impl CloudPasswordBox {
    /// Returns a one-time client-only transfer object. Split the code from the
    /// sealed bundle before saving; do not send this object to any server.
    pub fn create_recovery_material(&self) -> Result<JsValue, JsValue> {
        let material = self
            .session
            .recovery_material()
            .map_err(JsValue::from_str)?;
        Ok(JsValue::from_str(&material))
    }

    pub fn recover(
        bundle: &str,
        recovery_code: String,
        expected_owner: &str,
    ) -> Result<CloudPasswordBox, JsValue> {
        Session::recover(bundle, recovery_code, expected_owner)
            .map(|session| Self { session })
            .map_err(JsValue::from_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn owner(epoch: u64) -> String {
        json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":epoch}).to_string()
    }

    #[test]
    fn recovery_restores_the_same_key_without_changing_original_password_bundle() {
        let expected = owner(1);
        let session = Session::generate(&expected).unwrap();
        let primary_password =
            Zeroizing::new(B64.encode(MasterKey::generate().unwrap().as_bytes()));
        let primary = session.wrap(primary_password.to_string()).unwrap();
        let context = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1}).to_string();
        let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"title":"Recovery fixture","fields":[],"extra":{"keep":[1,2,3]},"urls":[{"href":"https://example.invalid/one"},{"href":"https://example.invalid/two"}]}).to_string();
        let envelope = session.encrypt(item.clone(), &context).unwrap();
        let material = session.recovery_material().unwrap();
        let mut transfer: Value = serde_json::from_str(&material).unwrap();
        let mut code = Zeroizing::new(transfer["recoveryCode"].as_str().unwrap().to_owned());
        super::super::erase(&mut transfer["recoveryCode"]);
        let bundle = transfer["bundle"].to_string();
        assert!(!bundle.contains(code.as_str()));
        let recovered = Session::recover(&bundle, std::mem::take(&mut *code), &expected).unwrap();
        assert_eq!(*recovered.decrypt(&envelope, &context).unwrap(), item);
        let reopened = Session::unlock(&primary, primary_password.to_string(), &expected).unwrap();
        assert_eq!(*reopened.decrypt(&envelope, &context).unwrap(), item);
        assert!(!envelope.contains("Recovery fixture"));
    }

    #[test]
    fn wrong_code_stale_epoch_and_recipient_authority_are_rejected() {
        let expected = owner(1);
        let mut session = Session::generate(&expected).unwrap();
        let material = session.recovery_material().unwrap();
        let mut transfer: Value = serde_json::from_str(&material).unwrap();
        let code = Zeroizing::new(transfer["recoveryCode"].as_str().unwrap().to_owned());
        super::super::erase(&mut transfer["recoveryCode"]);
        let bundle = transfer["bundle"].to_string();
        let wrong = B64.encode(MasterKey::generate().unwrap().as_bytes());
        assert!(Session::recover(&bundle, wrong, &expected).is_err());
        assert!(Session::recover(&bundle, code.to_string(), &owner(2)).is_err());
        let other = expected.replace(
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        );
        assert!(Session::recover(&bundle, code.to_string(), &other).is_err());
        let other_box =
            expected.replace("aaaaaaaaaaaaaaaaaaaaaaaaaa", "cccccccccccccccccccccccccc");
        assert!(Session::recover(&bundle, code.to_string(), &other_box).is_err());
        let mut forged: serde_json::Value = serde_json::from_str(&bundle).unwrap();
        forged["wrapped"]["context"]["passwordBoxId"] = json!("cccccccccccccccccccccccccc");
        assert!(Session::recover(&forged.to_string(), code.to_string(), &other_box).is_err());
        let mut tampered: serde_json::Value = serde_json::from_str(&bundle).unwrap();
        tampered["wrapped"]["ciphertext"] = json!(B64.encode([0u8; 48]));
        assert!(Session::recover(&tampered.to_string(), code.to_string(), &expected).is_err());
        assert!(Session::recover(&bundle, format!(" {}", code.as_str()), &expected).is_err());
        session.can_wrap_owner = false;
        assert!(session.recovery_material().is_err());
        session.lock();
        assert!(session.recovery_material().is_err());
    }
}
