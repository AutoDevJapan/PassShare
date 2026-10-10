//! Client-only preparation using the same lossless form policy as native edits.
use super::{parse, serialize_plaintext, Plaintext, Session, INVALID, MAX_BODY};
use passshare_core::{cloud_crypto::ItemContext, ConnectId};
use serde_json::json;
use zeroize::Zeroizing;

#[path = "../../../backend/native/src/edit.rs"]
mod native_edit;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

impl Session {
    pub(super) fn create_item(&self, values: String) -> Result<String, &'static str> {
        let input = Zeroizing::new(values);
        self.key()?;
        let values = Plaintext(parse(&input, MAX_BODY)?);
        // The shared validator checks the complete form, title and category.
        let id = ConnectId::generate().map_err(|_| INVALID)?;
        let seed = Plaintext(json!({
            "id": id, "version": 1, "vault": {"id": self.owner.password_box_id},
            "title": values.0.get("title"), "category": values.0.get("category"),
            "fields": [], "urls": [], "tags": [], "favorite": false
        }));
        let edited = Plaintext(native_edit::edit_item(&seed.0, &values.0).map_err(|_| INVALID)?);
        let context = ItemContext {
            password_box_id: self.owner.password_box_id.clone(),
            item_id: id,
            item_version: 1,
            key_epoch: self.owner.key_epoch,
        };
        self.encrypt_prepared(&edited, &context)
    }

    pub(super) fn edit_item(
        &self,
        original: String,
        values: String,
        expected: &str,
    ) -> Result<String, &'static str> {
        let original = Zeroizing::new(original);
        let values = Zeroizing::new(values);
        self.key()?;
        let context = self.context(expected)?;
        let original = Plaintext(parse(&original, MAX_BODY)?);
        let values = Plaintext(parse(&values, MAX_BODY)?);
        let version = original
            .0
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .filter(|version| (1..MAX_SAFE).contains(version))
            .ok_or(INVALID)?;
        if original.0.get("id").and_then(serde_json::Value::as_str)
            != Some(context.item_id.as_str())
            || context.item_version != version + 1
            || original
                .0
                .get("vault")
                .and_then(|v| v.get("id"))
                .is_some_and(|id| id.as_str() != Some(self.owner.password_box_id.as_str()))
        {
            return Err(INVALID);
        }
        let mut edited =
            Plaintext(native_edit::edit_item(&original.0, &values.0).map_err(|_| INVALID)?);
        edited.0["version"] = json!(context.item_version);
        self.encrypt_prepared(&edited, &context)
    }

    fn encrypt_prepared(
        &self,
        item: &Plaintext,
        context: &ItemContext,
    ) -> Result<String, &'static str> {
        let item = serialize_plaintext(&item.0)?;
        let context = serde_json::to_string(context).map_err(|_| INVALID)?;
        self.encrypt(item.to_string(), &context)
    }
}
