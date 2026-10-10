//! Incremental staging plans; all live-state decisions execute atomically in SQL.
use crate::encrypted::{exact_fields, id, number};
use crate::owner_key::{canonical_uuid, valid_bundle};
use crate::shared_grant::{conflict, credentials, failure, sql_plan, MAX_INTEGER};
use serde_json::{json, Value};

pub fn plan(input: &Value) -> Value {
    let Some((actor, session, box_id)) = credentials(input) else {
        return failure();
    };
    let r = &input["request"];
    if r.to_string().len() > 2 * 1024 * 1024 {
        return failure();
    }
    let op = input["operation"].as_str().unwrap_or("");
    if op == "snapshot" && r.is_null() {
        return sql_plan(
            &actor,
            &session,
            box_id,
            op,
            Value::Null,
            Value::Null,
            Value::Null,
        );
    }
    if ["members", "items", "item"].contains(&op) {
        let fields: &[&str] = if op == "item" {
            &["revision"]
        } else {
            &["revision", "after"]
        };
        if !exact_fields(r, fields) || number(&r["revision"], false).is_none() {
            return failure();
        }
        let target = if op == "item" {
            let Some(item) = id(&input["itemId"]) else {
                return failure();
            };
            json!(item)
        } else {
            if !r["after"].is_null()
                && !(if op == "members" {
                    r["after"].as_str().is_some_and(canonical_uuid)
                } else {
                    id(&r["after"]).is_some()
                })
            {
                return failure();
            }
            Value::Null
        };
        return sql_plan(&actor, &session, box_id, op, Value::Null, target, r.clone());
    }
    let Some(operation_id) = input["operationId"].as_str().filter(|s| canonical_uuid(s)) else {
        return failure();
    };
    let target = match op {
        "start"
            if exact_fields(
                r,
                &[
                    "expectedStateRevision",
                    "expectedKeyEpoch",
                    "expectedOwnerBundleVersion",
                    "removeAccountId",
                    "bundle",
                ],
            ) =>
        {
            let (Some(_revision), Some(epoch), Some(version), Some(remove)) = (
                number(&r["expectedStateRevision"], false),
                number(&r["expectedKeyEpoch"], false),
                number(&r["expectedOwnerBundleVersion"], false),
                r["removeAccountId"].as_str().filter(|s| canonical_uuid(s)),
            ) else {
                return failure();
            };
            if epoch == MAX_INTEGER
                || version == MAX_INTEGER
                || r["expectedStateRevision"].as_u64() == Some(MAX_INTEGER)
            {
                return conflict();
            }
            if remove == actor || valid_bundle(&r["bundle"], box_id, &actor) != Some(epoch + 1) {
                return failure();
            }
            Value::Null
        }
        "stage-item" if exact_fields(r, &["expectedVersion", "envelope"]) => {
            let (Some(item), Some(previous)) =
                (id(&input["itemId"]), number(&r["expectedVersion"], false))
            else {
                return failure();
            };
            if previous == MAX_INTEGER {
                return conflict();
            }
            if !crate::encrypted::valid_envelope(&r["envelope"], box_id, item, previous) {
                return failure();
            }
            json!(item)
        }
        "stage-grant" if exact_fields(r, &["envelope"]) => {
            let Some(recipient) = input["recipientId"].as_str().filter(|s| canonical_uuid(s))
            else {
                return failure();
            };
            if !crate::shared_grant::valid_envelope(&r["envelope"], box_id, &actor, recipient) {
                return failure();
            }
            json!(recipient)
        }
        "commit" if exact_fields(r, &[]) => Value::Null,
        "status" | "abort" if r.is_null() => Value::Null,
        _ => return failure(),
    };
    sql_plan(
        &actor,
        &session,
        box_id,
        op,
        json!(operation_id),
        target,
        r.clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_grant::tests::{A, B};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    fn input() -> Value {
        json!({"actor":A,"session":B,"boxId":"b".repeat(26),"operationId":B,"operation":"start","request":{
            "expectedStateRevision":1,"expectedKeyEpoch":1,"expectedOwnerBundleVersion":1,"removeAccountId":B,
            "bundle":{"format":1,"salt":BASE64.encode([0u8;16]),"wrapped":{"format":1,
                "context":{"passwordBoxId":"b".repeat(26),"ownerAccountId":A,"keyEpoch":2},
                "nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;48])}}}})
    }
    #[test]
    fn start_commit_status_abort_and_page_positive_controls() {
        assert_eq!(plan(&input())["status"], 200);
        for op in [
            "commit", "status", "abort", "snapshot", "members", "items", "item",
        ] {
            let mut i = input();
            i["operation"] = json!(op);
            i["itemId"] = json!("i".repeat(26));
            i["request"] = match op {
                "commit" => json!({}),
                "members" | "items" => json!({"revision":1,"after":null}),
                "item" => json!({"revision":1}),
                _ => Value::Null,
            };
            let p = plan(&i);
            assert_eq!(p["status"], 200, "{op}");
            assert_eq!(p["body"]["requiresReauthentication"], op == "commit");
            assert_eq!(p["body"]["params"][7], Value::Null);
        }
        let mut i = input();
        i["operation"] = json!("stage-grant");
        i["recipientId"] = json!(B);
        i["request"] = json!({"envelope":crate::shared_grant::tests::envelope(2)});
        assert_eq!(plan(&i)["status"], 200);
        i["operation"] = json!("stage-item");
        i["itemId"] = json!("i".repeat(26));
        i["request"] = json!({"expectedVersion":1,"envelope":{"format":1,"context":{"passwordBoxId":"b".repeat(26),"itemId":"i".repeat(26),"itemVersion":2,"keyEpoch":2},"nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;16])}});
        assert_eq!(plan(&i)["status"], 200);
        i["request"]["envelope"]["context"]["itemVersion"] = json!(1);
        assert_eq!(plan(&i)["status"], 400);
    }
    #[test]
    fn isolates_scope_shapes_overflow_and_no_password_forwarding() {
        for (path, v) in [
            (
                "/operationId",
                json!("00000000-0000-0000-0000-000000000000"),
            ),
            ("/request/expectedKeyEpoch", json!(1.0)),
            ("/request/removeAccountId", json!(A)),
            ("/request/bundle/wrapped/context/keyEpoch", json!(3)),
            ("/request/bundle/wrapped/format", json!("1")),
        ] {
            let mut i = input();
            *i.pointer_mut(path).unwrap() = v;
            assert_eq!(plan(&i)["status"], 400, "{path}");
        }
        for field in [
            "expectedStateRevision",
            "expectedKeyEpoch",
            "expectedOwnerBundleVersion",
        ] {
            let mut i = input();
            i["request"][field] = json!(MAX_INTEGER);
            assert_eq!(plan(&i)["status"], 409, "{field}");
            i["request"][field] = json!(MAX_INTEGER + 1);
            assert_eq!(plan(&i)["status"], 400);
        }
        for path in [
            "/request",
            "/request/bundle",
            "/request/bundle/wrapped",
            "/request/bundle/wrapped/context",
        ] {
            let mut i = input();
            i.pointer_mut(path).unwrap()["currentPassword"] = json!("sentinel");
            let p = plan(&i);
            assert_eq!(p["status"], 400);
            assert!(!p.to_string().contains("sentinel"));
        }
        let mut i = input();
        i["operation"] = json!("commit");
        i["request"] = json!({"currentPassword":"sentinel"});
        assert_eq!(plan(&i)["status"], 400);
    }
    #[test]
    fn each_header_subobject_requires_all_fields_and_each_page_requires_a_typed_cursor() {
        let valid = input();
        assert_eq!(plan(&valid)["status"], 200);
        for path in [
            "/request",
            "/request/bundle",
            "/request/bundle/wrapped",
            "/request/bundle/wrapped/context",
        ] {
            let fields: Vec<_> = valid
                .pointer(path)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            for field in fields {
                let mut i = valid.clone();
                i.pointer_mut(path).unwrap()[&field] = Value::Null;
                assert_eq!(plan(&i)["status"], 400, "null {path}/{field}");
                i.pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(&field);
                assert_eq!(plan(&i)["status"], 400, "missing {path}/{field}");
            }
        }
        for op in ["members", "items"] {
            let mut i = valid.clone();
            i["operation"] = json!(op);
            i["request"] = json!({"revision":MAX_INTEGER,"after":if op=="members" {B.to_string()} else {"i".repeat(26)}});
            assert_eq!(plan(&i)["status"], 200, "positive {op}");
            for bad in [json!(""), json!([]), json!(0), json!(true)] {
                let mut changed = i.clone();
                changed["request"]["after"] = bad;
                assert_eq!(plan(&changed)["status"], 400, "{op} cursor");
            }
            for bad in [json!(0), json!(1.0), json!("1"), json!(MAX_INTEGER + 1)] {
                let mut changed = i.clone();
                changed["request"]["revision"] = bad;
                assert_eq!(plan(&changed)["status"], 400, "{op} revision");
            }
            i["request"]["extra"] = json!(true);
            assert_eq!(plan(&i)["status"], 400);
        }
    }
}
