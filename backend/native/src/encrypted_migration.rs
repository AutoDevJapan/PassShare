//! Opaque migration transport validation. No key, plaintext or AEAD on host.
use crate::encrypted::{exact_fields, id, number, valid_envelope};
use crate::encrypted_attachment::valid_attachment;
use crate::owner_key::{canonical_uuid, valid_bundle};
use crate::shared_grant::{credentials, failure};
use serde_json::{json, Value};

fn context(v: &Value, file: bool) -> bool {
    let fields: &[&str] = if file {
        &[
            "passwordBoxId",
            "itemId",
            "attachmentId",
            "attachmentVersion",
            "keyEpoch",
        ]
    } else {
        &["passwordBoxId", "itemId", "itemVersion", "keyEpoch"]
    };
    exact_fields(v, fields)
        && id(&v["passwordBoxId"]).is_some()
        && id(&v["itemId"]).is_some()
        && number(&v["keyEpoch"], false).is_some()
        && if file {
            id(&v["attachmentId"]).is_some() && number(&v["attachmentVersion"], false).is_some()
        } else {
            number(&v["itemVersion"], false).is_some()
        }
}

pub fn valid_item(v: &Value, box_id: &str) -> bool {
    let b = &v["binding"];
    let t = &b["target"];
    let s = &b["source"];
    let Some(version) = number(&t["itemVersion"], false) else {
        return false;
    };
    let Some(item) = id(&t["itemId"]) else {
        return false;
    };
    let Some(files) = b["attachments"].as_array() else {
        return false;
    };
    exact_fields(v, &["binding", "envelope"])
        && exact_fields(b, &["source", "target", "attachments"])
        && context(s, false)
        && context(t, false)
        && s["passwordBoxId"] == box_id
        && t["passwordBoxId"] == box_id
        && s["itemVersion"] == t["itemVersion"]
        && valid_envelope(&v["envelope"], box_id, item, version - 1)
        && v["envelope"]["context"] == *t
        && files.len() <= 1024
        && files.iter().all(|f| {
            exact_fields(f, &["source", "target"])
                && context(&f["source"], true)
                && context(&f["target"], true)
                && f["source"]["passwordBoxId"] == box_id
                && f["target"]["passwordBoxId"] == box_id
                && f["source"]["itemId"] == s["itemId"]
                && f["target"]["itemId"] == t["itemId"]
                && f["source"]["keyEpoch"] == s["keyEpoch"]
                && f["target"]["keyEpoch"] == t["keyEpoch"]
                && f["source"]["attachmentVersion"] == f["target"]["attachmentVersion"]
        })
}

pub fn plan(input: &Value) -> Value {
    let Some((actor, session, box_id)) = credentials(input) else {
        return failure();
    };
    let op = input["operation"].as_str().unwrap_or("");
    let r = &input["request"];
    let operation = input["operationId"].as_str().filter(|s| canonical_uuid(s));
    let item = id(&input["itemId"]);
    let file = id(&input["attachmentId"]);
    let valid = match op {
        "snapshot" => r.is_null(),
        "items" | "item" | "file" => {
            exact_fields(
                r,
                if op == "items" {
                    &["revision", "after"]
                } else {
                    &["revision"]
                },
            ) && number(&r["revision"], false).is_some()
                && (op != "items" || r["after"].is_null() || id(&r["after"]).is_some())
                && (op == "items" || item.is_some())
                && (op != "file" || file.is_some())
        }
        "start" => {
            exact_fields(
                r,
                &[
                    "format",
                    "operationId",
                    "ownerContext",
                    "sourcePasswordBoxId",
                    "sourceRevision",
                    "itemCount",
                    "attachmentCount",
                    "ownerBundle",
                ],
            ) && r["format"].as_u64() == Some(1)
                && r["operationId"].as_str() == operation
                && r["sourcePasswordBoxId"] == box_id
                && number(&r["sourceRevision"], false).is_some()
                && number(&r["itemCount"], true).is_some()
                && number(&r["attachmentCount"], true).is_some_and(|n| n <= 1024)
                && exact_fields(
                    &r["ownerContext"],
                    &["passwordBoxId", "ownerAccountId", "keyEpoch"],
                )
                && r["ownerContext"]["passwordBoxId"] == box_id
                && r["ownerContext"]["ownerAccountId"] == actor
                && r["ownerContext"]["keyEpoch"] == 1
                && valid_bundle(&r["ownerBundle"], box_id, &actor) == Some(1)
        }
        "stage-item" => valid_item(r, box_id) && r["binding"]["target"]["itemId"].as_str() == item,
        "stage-file" => {
            exact_fields(r, &["envelope"])
                && item.zip(file).is_some_and(|(item, file)| {
                    number(&r["envelope"]["context"]["attachmentVersion"], false).is_some_and(|n| {
                        valid_attachment(&r["envelope"], box_id, item, file, n - 1)
                    })
                })
        }
        "status" | "abort" | "commit" => r.is_null(),
        "staged-item" => r.is_null() && item.is_some(),
        "staged-file" => r.is_null() && item.is_some() && file.is_some(),
        _ => false,
    };
    if !valid || (!matches!(op, "snapshot" | "items" | "item" | "file") && operation.is_none()) {
        return failure();
    }
    json!({"status":200,"body":{
        "sql":"WITH migration_reply AS MATERIALIZED (SELECT passshare_migration_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::uuid,$6::varchar,$7::varchar,$8::jsonb) AS r) SELECT r->>'status' AS migration_status,r->>'code' AS migration_code,r->>'message' AS migration_message,(r->'body')::text AS migration_body FROM migration_reply",
        "replyEncoding":"json-text",
        "params":[actor,session,box_id,op,operation,item,file,r]
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    fn item() -> Value {
        let context = json!({"passwordBoxId":"b".repeat(26),"itemId":"i".repeat(26),"itemVersion":17,"keyEpoch":1});
        json!({"binding":{"source":context,"target":context,"attachments":[]},"envelope":{"format":1,"context":context,
            "nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;16])}})
    }
    #[test]
    fn stages_preserve_source_positive_versions_and_exact_context() {
        let good = item();
        let box_id = "b".repeat(26);
        assert!(valid_item(&good, &box_id));
        for (path, value) in [
            ("/binding/source/itemVersion", json!(1)),
            ("/binding/target/itemVersion", json!(1)),
            ("/envelope/context/keyEpoch", json!(2)),
            ("/binding/source/passwordBoxId", json!("c".repeat(26))),
            ("/binding/target/itemId", json!("j".repeat(26))),
            ("/binding/attachments", Value::Null),
        ] {
            let mut changed = good.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert!(!valid_item(&changed, &box_id), "invalid public binding");
        }
        for field in ["plaintext", "name", "password", "key", "original"] {
            let mut changed = good.clone();
            changed[field] = json!("forbidden");
            assert!(!valid_item(&changed, &box_id));
        }
    }
    #[test]
    fn prepared_stage_raw_rejects_duplicate_and_lexically_float_revision() {
        let stage = item();
        let input = json!({"command":"encrypted-migration-plan","actor":"11111111-1111-1111-1111-111111111111",
            "session":"22222222-2222-2222-2222-222222222222","boxId":"b".repeat(26),"itemId":"i".repeat(26),
            "operationId":"33333333-3333-4333-a333-333333333333","operation":"stage-item","requestJson":stage.to_string()});
        assert!(crate::dispatch(&input)["status"] == 200);
        for raw in [
            stage
                .to_string()
                .replacen("\"itemVersion\":17", "\"itemVersion\":17.0", 1),
            stage
                .to_string()
                .replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
        ] {
            let mut changed = input.clone();
            changed["requestJson"] = json!(raw);
            assert!(crate::dispatch(&changed)["status"] == 400);
        }
    }
    #[test]
    fn bounded_file_body_and_owner_only_header_never_accept_secret_fields() {
        let mut i = json!({"actor":"11111111-1111-1111-1111-111111111111","session":"22222222-2222-2222-2222-222222222222",
            "boxId":"b".repeat(26),"operationId":"33333333-3333-4333-a333-333333333333","operation":"commit","request":null});
        assert!(plan(&i)["status"] == 200);
        for request in [
            json!({"key":"forbidden"}),
            json!({}),
            json!({"currentPassword":"forbidden"}),
            json!([]),
        ] {
            i["request"] = request;
            assert!(plan(&i)["status"] == 400);
        }
        i["request"] = Value::Null;
        i["operationId"] = json!("00000000-0000-0000-0000-000000000000");
        assert!(plan(&i)["status"] == 400);
    }
    #[test]
    fn owner_lookup_has_exact_revision_and_cursor() {
        let mut i = json!({"actor":"11111111-1111-1111-1111-111111111111","session":"22222222-2222-2222-2222-222222222222","boxId":"b".repeat(26),"operation":"items","request":{"revision":17,"after":null}});
        assert!(plan(&i)["status"] == 200);
        for value in [
            json!(0),
            json!(17.0),
            json!("17"),
            json!(9007199254740992u64),
        ] {
            i["request"]["revision"] = value;
            assert!(plan(&i)["status"] == 400);
        }
        i["request"] = json!({"revision":17,"after":null,"key":"forbidden"});
        assert!(plan(&i)["status"] == 400);
    }
}
