//! Atomic empty-box activation and initial owner bundle. No secret or key
//! reaches this module; the existing owner-bundle validator checks public shape.
use crate::{encrypted::exact_fields, encrypted::id, owner_key::valid_bundle};
use serde_json::{json, Value};

pub fn plan(input: &Value) -> Value {
    let invalid =
        || json!({"status":400,"code":"PS051","message":"PS051: Invalid encryption setup request"});
    let (Some(box_id), Some(actor), Some(session)) = (
        id(&input["boxId"]),
        input["actor"].as_str(),
        input["session"].as_str(),
    ) else {
        return invalid();
    };
    let request = &input["request"];
    if input["operation"] != "setup"
        || !exact_fields(request, &["bundle"])
        || valid_bundle(&request["bundle"], box_id, actor) != Some(1)
        || !crate::owner_key::canonical_uuid(actor)
        || !crate::owner_key::canonical_uuid(session)
    {
        return invalid();
    }
    json!({"status":200,"body":{
        "sql":"SELECT passshare_encrypted_setup($1::uuid,$2::uuid,$3::varchar,$4::jsonb) AS reply",
        "params":[actor,session,box_id,request["bundle"]]
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    fn fixture() -> Value {
        let actor = "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10";
        let box_id = "b".repeat(26);
        json!({"operation":"setup","actor":actor,"session":"4b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10","boxId":box_id,
          "request":{"bundle":{"format":1,"salt":B64.encode([1u8;16]),"wrapped":{"format":1,
            "context":{"passwordBoxId":box_id,"ownerAccountId":actor,"keyEpoch":1},
            "nonce":B64.encode([2u8;24]),"ciphertext":B64.encode([3u8;48])}}}})
    }
    #[test]
    fn initial_bundle_plan_binds_middleware_actor_and_session() {
        let input = fixture();
        let result = plan(&input);
        assert_eq!(result["status"], 200);
        assert_eq!(
            result["body"]["params"],
            json!([
                input["actor"],
                input["session"],
                input["boxId"],
                input["request"]["bundle"]
            ])
        );
    }
    #[test]
    fn setup_rejects_credentials_extra_fields_and_noninitial_epochs() {
        for path in [
            "/request",
            "/request/bundle",
            "/request/bundle/wrapped",
            "/request/bundle/wrapped/context",
        ] {
            for field in ["password", "currentPassword", "key", "expectedVersion"] {
                let mut input = fixture();
                input.pointer_mut(path).unwrap()[field] = json!("forbidden");
                assert_eq!(plan(&input)["status"], 400, "{path}/{field}");
            }
        }
        for (path, value) in [
            ("/request/bundle/wrapped/context/keyEpoch", json!(2)),
            ("/actor", json!("8b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10")),
            ("/session", json!("invalid")),
            ("/operation", json!("put")),
            ("/request/bundle/format", json!(1.0)),
            ("/boxId", json!("c".repeat(26))),
        ] {
            let mut input = fixture();
            *input.pointer_mut(path).unwrap() = value;
            assert_eq!(plan(&input)["status"], 400, "{path}");
        }
    }
}
