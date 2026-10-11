//! Public headers only. Core owns encryption and authenticated reference checks.
use crate::encrypted::{exact_fields, id, number, valid_envelope};
use crate::shared_grant::{credentials, failure};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

/// JSON syntax is validated by serde_json first. Walk only structural tokens to
/// reject repeated decoded object keys without adding a second crypto/parser
/// dependency; strings containing braces, escapes or colons stay opaque.
pub fn dispatch_raw(input: &Value) -> Value {
    if !matches!(
        input["command"].as_str(),
        Some("encrypted-attachment-plan" | "encrypted-rotation-plan" | "encrypted-migration-plan")
    ) {
        return failure();
    }
    let Some(raw) = input["requestJson"].as_str() else {
        return failure();
    };
    let Ok(request) = serde_json::from_str::<Value>(raw) else {
        return failure();
    };
    let mut stack = Vec::<std::collections::BTreeSet<String>>::new();
    let bytes = raw.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        match bytes[pos] {
            b'{' => stack.push(Default::default()),
            b'}' => {
                stack.pop();
            }
            b'"' => {
                let start = pos;
                pos += 1;
                while pos < bytes.len() {
                    if bytes[pos] == b'\\' {
                        pos += 2;
                    } else if bytes[pos] == b'"' {
                        break;
                    } else {
                        pos += 1;
                    }
                }
                let end = pos + 1;
                let mut next = end;
                while bytes.get(next).is_some_and(u8::is_ascii_whitespace) {
                    next += 1;
                }
                if bytes.get(next) == Some(&b':') {
                    let Ok(key) = serde_json::from_str::<String>(&raw[start..end]) else {
                        return failure();
                    };
                    if !stack.last_mut().is_some_and(|keys| keys.insert(key)) {
                        return failure();
                    }
                }
            }
            _ => {}
        }
        pos += 1;
    }
    let mut normalized = input.clone();
    normalized.as_object_mut().unwrap().remove("requestJson");
    normalized["request"] = request;
    crate::dispatch(&normalized)
}

pub fn valid_attachment(
    v: &Value,
    box_id: &str,
    item: &str,
    attachment: &str,
    previous: u64,
) -> bool {
    let Some(next) = previous
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
    else {
        return false;
    };
    if !exact_fields(
        v,
        &["format", "context", "contentBytes", "nonce", "ciphertext"],
    ) || !exact_fields(
        &v["context"],
        &[
            "passwordBoxId",
            "itemId",
            "attachmentId",
            "attachmentVersion",
            "keyEpoch",
        ],
    ) {
        return false;
    }
    let c = &v["context"];
    let (Some(size), Some(nonce), Some(cipher)) = (
        number(&v["contentBytes"], true),
        v["nonce"].as_str(),
        v["ciphertext"].as_str(),
    ) else {
        return false;
    };
    v["format"].as_u64() == Some(1)
        && id(&c["passwordBoxId"]) == Some(box_id)
        && id(&c["itemId"]) == Some(item)
        && id(&c["attachmentId"]) == Some(attachment)
        && number(&c["attachmentVersion"], false) == Some(next)
        && number(&c["keyEpoch"], false).is_some()
        && size <= 1_048_576
        && nonce.len() == 32
        && BASE64.decode(nonce).is_ok_and(|b| b.len() == 24)
        && cipher.len() <= 1_403_592
        && BASE64
            .decode(cipher)
            .is_ok_and(|b| (20 + size as usize..=4116 + size as usize).contains(&b.len()))
}

pub fn plan(input: &Value) -> Value {
    let Some((actor, session, box_id)) = credentials(input) else {
        return failure();
    };
    // The public CAS selector uses the very same live authorization as files.
    // It has no item, attachment, key material or client-supplied selector.
    if input["operation"] == "state" {
        if !input["request"].is_null()
            || !input["itemId"].is_null()
            || !input["attachmentId"].is_null()
        {
            return failure();
        }
        return json!({"status":200,"body":{
            "sql":"SELECT passshare_attachment_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::varchar,$6::varchar,$7::jsonb) AS reply",
            "params":[actor,session,box_id,"state",null,null,null]
        }});
    }
    if input["operation"] == "item" {
        let Some(item) = id(&input["itemId"]) else {
            return failure();
        };
        let request = &input["request"];
        if !input["attachmentId"].is_null()
            || !exact_fields(request, &["revision"])
            || number(&request["revision"], false).is_none()
        {
            return failure();
        }
        return json!({"status":200,"body":{
            "sql":"SELECT passshare_attachment_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::varchar,$6::varchar,$7::jsonb) AS reply",
            "params":[actor,session,box_id,"item",item,null,request]
        }});
    }
    let (Some(item), Some(attachment)) = (id(&input["itemId"]), id(&input["attachmentId"])) else {
        return failure();
    };
    let r = &input["request"];
    let op = input["operation"].as_str().unwrap_or("");
    if op == "get" {
        if !exact_fields(r, &["revision"]) || number(&r["revision"], false).is_none() {
            return failure();
        }
    } else {
        let fields: &[&str] = if op == "put" {
            &[
                "expectedStateRevision",
                "item",
                "expectedVersion",
                "envelope",
            ]
        } else if op == "delete" {
            &[
                "expectedStateRevision",
                "item",
                "expectedVersion",
                "keyEpoch",
            ]
        } else {
            return failure();
        };
        let (Some(_revision), Some(item_previous), Some(previous)) = (
            number(&r["expectedStateRevision"], false),
            number(&r["item"]["expectedVersion"], false),
            number(&r["expectedVersion"], op == "put"),
        ) else {
            return failure();
        };
        if !exact_fields(r, fields)
            || !exact_fields(&r["item"], &["expectedVersion", "envelope"])
            || !valid_envelope(&r["item"]["envelope"], box_id, item, item_previous)
        {
            return failure();
        }
        let epoch = &r["item"]["envelope"]["context"]["keyEpoch"];
        if op == "put" {
            if !valid_attachment(&r["envelope"], box_id, item, attachment, previous)
                || &r["envelope"]["context"]["keyEpoch"] != epoch
            {
                return failure();
            }
        } else if number(&r["keyEpoch"], false).is_none() || &r["keyEpoch"] != epoch {
            return failure();
        }
    }
    json!({"status":200,"body":{
        "sql":"SELECT passshare_attachment_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::varchar,$6::varchar,$7::jsonb) AS reply",
        "params":[actor,session,box_id,op,item,attachment,r]
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        let b = "b".repeat(26);
        let i = "i".repeat(26);
        let a = "a".repeat(26);
        json!({"actor":"11111111-1111-1111-1111-111111111111","session":"22222222-2222-2222-2222-222222222222",
            "boxId":b,"itemId":i,"attachmentId":a,"operation":"put","request":{"expectedStateRevision":1,"expectedVersion":0,
            "item":{"expectedVersion":1,"envelope":{"format":1,"context":{"passwordBoxId":b,"itemId":i,"itemVersion":2,"keyEpoch":1},"nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;16])}},
            "envelope":{"format":1,"context":{"passwordBoxId":b,"itemId":i,"attachmentId":a,"attachmentVersion":1,"keyEpoch":1},"contentBytes":0,"nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;20])}}})
    }
    #[test]
    fn state_uses_attachment_authorization_without_item_or_request() {
        let mut v = input();
        v["command"] = json!("encrypted-attachment-plan");
        v["operation"] = json!("state");
        for field in ["request", "itemId", "attachmentId"] {
            v.as_object_mut().unwrap().remove(field);
        }
        let plan = crate::dispatch(&v);
        assert_eq!(plan["status"], 200);
        assert_eq!(
            plan["body"]["params"],
            json!([
                v["actor"],
                v["session"],
                v["boxId"],
                "state",
                null,
                null,
                null
            ])
        );
        for field in ["request", "itemId", "attachmentId"] {
            let mut bad = v.clone();
            bad[field] = json!({});
            assert_eq!(crate::dispatch(&bad)["status"], 400);
        }
        for field in ["actor", "session", "boxId"] {
            let mut bad = v.clone();
            bad[field] = json!("invalid");
            assert_eq!(crate::dispatch(&bad)["status"], 400);
        }
    }
    #[test]
    fn item_snapshot_requires_independent_revision_and_no_attachment_selector() {
        let mut v = input();
        v["operation"] = json!("item");
        v.as_object_mut().unwrap().remove("attachmentId");
        v["request"] = json!({"revision":17});
        let result = plan(&v);
        assert_eq!(result["status"], 200);
        assert_eq!(result["body"]["params"][4], v["itemId"]);
        assert!(result["body"]["params"][5].is_null());
        assert_eq!(result["body"]["params"][6], v["request"]);
        for request in [
            json!({}),
            json!({"revision":0}),
            json!({"revision":"17"}),
            json!({"revision":9007199254740992u64}),
            json!({"revision":17,"keyEpoch":1}),
        ] {
            let mut bad = v.clone();
            bad["request"] = request;
            assert_eq!(plan(&bad)["status"], 400);
        }
        v["attachmentId"] = json!("a".repeat(26));
        assert_eq!(plan(&v)["status"], 400);
    }
    #[test]
    fn headers_plan_one_atomic_statement_and_independent_versions() {
        let v = input();
        assert_eq!(plan(&v)["status"], 200);
        assert_eq!(plan(&v)["body"]["params"][6], v["request"]);
        let mut d = v;
        d["operation"] = json!("delete");
        d["request"].as_object_mut().unwrap().remove("envelope");
        d["request"]["expectedVersion"] = json!(1);
        d["request"]["keyEpoch"] = json!(1);
        assert_eq!(plan(&d)["status"], 200);
        d["operation"] = json!("get");
        d["request"] = json!({"revision":1});
        assert_eq!(plan(&d)["status"], 200);
    }
    #[test]
    fn malformed_scope_shape_safe_numbers_lengths_and_plaintext_rejected() {
        let v = input();
        for path in [
            "/request/expectedStateRevision",
            "/request/expectedVersion",
            "/request/item/expectedVersion",
            "/request/envelope/contentBytes",
            "/request/envelope/context/attachmentVersion",
            "/request/envelope/context/keyEpoch",
        ] {
            for n in [
                json!(-1),
                json!(1.0),
                json!("1"),
                json!(9_007_199_254_740_992u64),
                Value::Null,
                json!(true),
            ] {
                let mut bad = v.clone();
                *bad.pointer_mut(path).unwrap() = n;
                assert_eq!(plan(&bad)["status"], 400, "{path}");
            }
        }
        for path in [
            "/request",
            "/request/item",
            "/request/item/envelope",
            "/request/envelope",
            "/request/envelope/context",
        ] {
            for key in ["name", "bytes", "rootKey"] {
                let mut bad = v.clone();
                bad.pointer_mut(path).unwrap()[key] = json!("forbidden");
                assert_eq!(plan(&bad)["status"], 400);
            }
        }
        for (path, n) in [
            ("/attachmentId", json!("z".repeat(26))),
            ("/request/envelope/contentBytes", json!(1)),
            ("/request/envelope/context/keyEpoch", json!(2)),
            ("/request/envelope/nonce", json!("bad")),
            (
                "/request/envelope/ciphertext",
                json!(BASE64.encode([0u8; 19])),
            ),
        ] {
            let mut bad = v.clone();
            *bad.pointer_mut(path).unwrap() = n;
            assert_eq!(plan(&bad)["status"], 400);
        }
    }
    #[test]
    fn maximum_core_public_envelope_fits_transport_and_overflow_rejected() {
        let mut v = input();
        v["request"]["envelope"]["contentBytes"] = json!(1_048_576);
        v["request"]["envelope"]["ciphertext"] = json!(BASE64.encode(vec![0u8; 1_052_692]));
        assert_eq!(plan(&v)["status"], 200);
        assert!(v.to_string().len() < 2 * 1024 * 1024);
        v["request"]["envelope"]["contentBytes"] = json!(1_048_577);
        assert_eq!(plan(&v)["status"], 400);
    }
    #[test]
    fn raw_json_preserves_integer_types_and_rejects_decoded_duplicate_keys() {
        let mut v = input();
        v["command"] = json!("encrypted-attachment-plan");
        let raw = v["request"].to_string();
        v.as_object_mut().unwrap().remove("request");
        v["requestJson"] = json!(raw);
        assert_eq!(crate::dispatch(&v)["status"], 200);
        for raw in [
            raw.replacen("\"format\":1", "\"format\":1.0", 1),
            raw.replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
            raw.replacen("\"format\":1", "\"format\":1,\"f\\u006frmat\":1", 1),
            raw.replacen(
                "\"expectedVersion\":0",
                "\"expectedVersion\":0,\"expectedVersion\":0",
                1,
            ),
        ] {
            v["requestJson"] = json!(raw);
            assert_eq!(crate::dispatch(&v)["status"], 400);
        }
    }
    #[test]
    fn rotation_attachment_stage_and_composite_pages_bind_each_id() {
        let v = input();
        let mut stage = v.clone();
        stage["operationId"] = v["session"].clone();
        stage["operation"] = json!("stage-attachment");
        stage["request"] = json!({"expectedVersion":1,"envelope":v["request"]["envelope"]});
        stage["request"]["envelope"]["context"]["attachmentVersion"] = json!(2);
        stage["request"]["envelope"]["context"]["keyEpoch"] = json!(2);
        assert_eq!(crate::encrypted_rotation::plan(&stage)["status"], 200);
        for op in ["attachments", "attachment"] {
            stage["operation"] = json!(op);
            stage["request"] = if op == "attachments" {
                json!({"revision":1,"after":format!("{}:{}",v["itemId"].as_str().unwrap(),v["attachmentId"].as_str().unwrap())})
            } else {
                json!({"revision":1})
            };
            assert_eq!(crate::encrypted_rotation::plan(&stage)["status"], 200);
        }
        stage["operation"] = json!("attachments");
        for cursor in [
            "bad",
            "a:b",
            &format!("{}:{}:{}", "a".repeat(26), "b".repeat(26), "c".repeat(26)),
        ] {
            stage["request"] = json!({"revision":1,"after":cursor});
            assert_eq!(crate::encrypted_rotation::plan(&stage)["status"], 400);
        }
    }
}
