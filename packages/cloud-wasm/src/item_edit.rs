//! Client-only preparation using the same lossless form policy as native edits.
use super::{parse, serialize_plaintext, Plaintext, Session, INVALID, MAX_BODY};
use passshare_core::{cloud_crypto::ItemContext, ConnectId};
use serde_json::json;
use zeroize::Zeroizing;

#[path = "../../../backend/native/src/edit.rs"]
mod native_edit;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

impl Session {
    /// Prepare one atomic parent/attachment mutation without projecting the item.
    pub(super) fn edit_attachment_item(
        &self,
        original: String,
        values: String,
        expected: &str,
    ) -> Result<String, &'static str> {
        let original = Zeroizing::new(original);
        let values = Zeroizing::new(values);
        self.key()?;
        let context = self.context(expected)?;
        let original_item = Plaintext(parse(&original, MAX_BODY)?);
        let request = Plaintext(parse::<serde_json::Value>(&values, MAX_BODY)?);
        let request = request.0.as_object().ok_or(INVALID)?;
        let action = request
            .get("action")
            .and_then(serde_json::Value::as_str)
            .ok_or(INVALID)?;
        if request.len() != if action == "add" { 2 } else { 3 }
            || !request.contains_key("form")
            || !matches!(action, "add" | "replace" | "remove")
            || (action != "add" && !request.contains_key("attachmentId"))
        {
            return Err(INVALID);
        }
        let version = original_item
            .0
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .ok_or(INVALID)?;
        if !(1..MAX_SAFE).contains(&version)
            || context.item_version != version + 1
            || original_item
                .0
                .get("id")
                .and_then(serde_json::Value::as_str)
                != Some(context.item_id.as_str())
            || original_item
                .0
                .get("vault")
                .and_then(|v| v.get("id"))
                .and_then(serde_json::Value::as_str)
                != Some(self.owner.password_box_id.as_str())
        {
            return Err(INVALID);
        }
        let mut item = Plaintext(
            native_edit::edit_item(&original_item.0, &request["form"]).map_err(|_| INVALID)?,
        );
        if item.0.get("attachments").is_none() {
            item.0["attachments"] = json!([]);
        }
        let references = item.0["attachments"].as_array_mut().ok_or(INVALID)?;
        if references.len() > 1024 {
            return Err(INVALID);
        }
        let mut ids = std::collections::HashSet::new();
        for reference in references.iter() {
            let id = reference
                .get("attachmentId")
                .and_then(serde_json::Value::as_str)
                .ok_or(INVALID)?;
            ConnectId::validate(id).map_err(|_| INVALID)?;
            if !ids.insert(id.to_owned())
                || !reference
                    .get("attachmentVersion")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|v| (1..=MAX_SAFE).contains(&v))
                || reference
                    .get("keyEpoch")
                    .and_then(serde_json::Value::as_u64)
                    != Some(context.key_epoch)
            {
                return Err(INVALID);
            }
        }
        if action == "add" {
            if references.len() >= 1024 {
                return Err(INVALID);
            }
            let id = ConnectId::generate().map_err(|_| INVALID)?;
            if ids.contains(id.as_str()) {
                return Err(INVALID);
            }
            references.push(
                json!({"attachmentId":id,"attachmentVersion":1,"keyEpoch":context.key_epoch}),
            );
        } else {
            let id = request["attachmentId"].as_str().ok_or(INVALID)?;
            let index = references
                .iter()
                .position(|r| r["attachmentId"].as_str() == Some(id))
                .ok_or(INVALID)?;
            if action == "remove" {
                references.remove(index);
            } else {
                let version = references[index]["attachmentVersion"]
                    .as_u64()
                    .ok_or(INVALID)?;
                if version >= MAX_SAFE {
                    return Err(INVALID);
                }
                references[index]["attachmentVersion"] = json!(version + 1);
            }
        }
        item.0["version"] = json!(context.item_version);
        self.encrypt_prepared(&item, &context)
    }

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
