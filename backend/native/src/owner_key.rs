//! Opaque owner key bundle: public header checks only. The host never sees the
//! encryption password or a raw key, and cannot verify the AEAD. Clients must
//! unwrap with Core `unwrap_for_owner` against their own expected context.
use crate::encrypted::{exact_fields, id, number};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
// 32-byte box key + 16-byte AEAD tag.
const WRAPPED_BYTES: usize = 48;

fn failure() -> Value {
    json!({"status":400,"code":"PS051","message":"PS051: Invalid owner key bundle request"})
}

fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

fn base64_of(value: &Value, len: usize) -> bool {
    value.as_str().is_some_and(|text| {
        BASE64
            .decode(text)
            .is_ok_and(|bytes| bytes.len() == len && BASE64.encode(bytes) == text)
    })
}

/// Returns the key epoch when the bundle is the strict public client shape and
/// its context names this box and this (middleware-supplied) owner.
pub fn valid_bundle(bundle: &Value, box_id: &str, owner: &str) -> Option<u64> {
    let wrapped = &bundle["wrapped"];
    let context = &wrapped["context"];
    let valid = exact_fields(bundle, &["format", "salt", "wrapped"])
        && exact_fields(wrapped, &["format", "context", "nonce", "ciphertext"])
        && exact_fields(context, &["passwordBoxId", "ownerAccountId", "keyEpoch"])
        && bundle["format"].as_u64() == Some(1)
        && wrapped["format"].as_u64() == Some(1)
        && base64_of(&bundle["salt"], SALT_BYTES)
        && base64_of(&wrapped["nonce"], NONCE_BYTES)
        && base64_of(&wrapped["ciphertext"], WRAPPED_BYTES)
        && id(&context["passwordBoxId"]) == Some(box_id)
        && context["ownerAccountId"].as_str() == Some(owner);
    if valid {
        number(&context["keyEpoch"], false)
    } else {
        None
    }
}

pub fn plan(input: &Value) -> Value {
    let Some(box_id) = id(&input["boxId"]) else {
        return failure();
    };
    // actor/session come from session middleware, never from the body.
    let (Some(actor), Some(session)) = (input["actor"].as_str(), input["session"].as_str()) else {
        return failure();
    };
    let actor = actor.to_ascii_lowercase();
    if !canonical_uuid(&actor) {
        return failure();
    }
    let request = &input["request"];
    let (previous, bundle, epoch) = match input["operation"].as_str().unwrap_or("") {
        "get" if request.is_null() => (Value::Null, Value::Null, Value::Null),
        "put" if exact_fields(request, &["expectedVersion", "bundle"]) => {
            let Some(previous) = number(&request["expectedVersion"], true) else {
                return failure();
            };
            // The stored version is previous+1 and must remain a JS safe integer.
            let Some(epoch) = (previous < MAX_INTEGER)
                .then(|| valid_bundle(&request["bundle"], box_id, &actor))
                .flatten()
            else {
                return failure();
            };
            (json!(previous), request["bundle"].clone(), json!(epoch))
        }
        _ => return failure(),
    };
    json!({"status":200,"body":{
        "sql":"SELECT passshare_owner_key_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::bigint,$6::jsonb,$7::bigint,$8::text) AS reply",
        "requiresReauthentication": previous.as_u64().is_some_and(|n| n>0),
        "params":[actor,session,box_id,input["operation"],previous,bundle,epoch,Value::Null]
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10";

    fn fixture() -> Value {
        let box_id = "b".repeat(26);
        json!({"actor":OWNER,"session":"session","operation":"put","boxId":box_id,
            "request":{"expectedVersion":0,"bundle":{"format":1,"salt":BASE64.encode([1u8;16]),
                "wrapped":{"format":1,
                    "context":{"passwordBoxId":box_id,"ownerAccountId":OWNER,"keyEpoch":1},
                    "nonce":BASE64.encode([2u8;24]),"ciphertext":BASE64.encode([3u8;48])}}}})
    }

    #[test]
    fn synthetic_public_shape_passes_and_actor_comes_from_middleware() {
        let input = fixture();
        let plan = plan(&input);
        assert_eq!(plan["status"], 200);
        assert_eq!(plan["body"]["params"][0], OWNER);
        assert_eq!(plan["body"]["params"][5], input["request"]["bundle"]);
        assert_eq!(plan["body"]["params"][6], 1);
        let mut get = fixture();
        get["operation"] = json!("get");
        get["request"] = Value::Null;
        assert_eq!(super::plan(&get)["status"], 200);
    }

    #[test]
    fn scope_format_size_and_encoding_violations_are_rejected() {
        for (path, value) in [
            ("/boxId", json!("c".repeat(26))),
            ("/actor", json!("00000000-0000-0000-0000-000000000000")),
            ("/actor", json!("not-a-uuid")),
            ("/request/expectedVersion", json!(MAX_INTEGER)),
            ("/request/expectedVersion", json!(-1)),
            ("/request/expectedVersion", json!(0.0)),
            ("/request/bundle/format", json!(2)),
            ("/request/bundle/salt", json!(BASE64.encode([1u8; 15]))),
            ("/request/bundle/salt", json!("AAAAAAAAAAAAAAAAAAAAAB==")),
            ("/request/bundle/wrapped/format", json!(1.0)),
            (
                "/request/bundle/wrapped/nonce",
                json!(BASE64.encode([2u8; 23])),
            ),
            (
                "/request/bundle/wrapped/ciphertext",
                json!(BASE64.encode([3u8; 47])),
            ),
            (
                "/request/bundle/wrapped/ciphertext",
                json!(BASE64.encode([3u8; 64])),
            ),
            ("/request/bundle/wrapped/context/keyEpoch", json!(0)),
            (
                "/request/bundle/wrapped/context/keyEpoch",
                json!(MAX_INTEGER + 1),
            ),
            (
                "/request/bundle/wrapped/context/passwordBoxId",
                json!("c".repeat(26)),
            ),
            (
                "/request/bundle/wrapped/context/ownerAccountId",
                json!("8b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10"),
            ),
            (
                "/request/bundle/wrapped/context/ownerAccountId",
                json!(OWNER.to_uppercase()),
            ),
        ] {
            let mut changed = fixture();
            *changed.pointer_mut(path).unwrap() = value;
            assert_eq!(plan(&changed)["status"], 400, "{path}");
        }
    }

    #[test]
    fn unknown_or_plaintext_fields_and_wrong_operations_are_rejected() {
        for path in [
            "/request",
            "/request/bundle",
            "/request/bundle/wrapped",
            "/request/bundle/wrapped/context",
        ] {
            for name in ["password", "key", "kdf", "memory"] {
                let mut changed = fixture();
                changed.pointer_mut(path).unwrap()[name] = json!("forbidden");
                assert_eq!(plan(&changed)["status"], 400, "{path}/{name}");
            }
        }
        for operation in ["delete", "enable", ""] {
            let mut changed = fixture();
            changed["operation"] = json!(operation);
            assert_eq!(plan(&changed)["status"], 400);
        }
        let mut get = fixture();
        get["operation"] = json!("get");
        assert_eq!(plan(&get)["status"], 400, "GET carries no body");
    }

    #[test]
    fn largest_safe_expected_version_is_accepted() {
        let mut input = fixture();
        input["request"]["expectedVersion"] = json!(9_007_199_254_740_990u64);
        assert_eq!(plan(&input)["status"], 200);
    }
}
