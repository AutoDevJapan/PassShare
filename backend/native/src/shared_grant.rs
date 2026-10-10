//! Public HPKE headers only. No private key, Core dependency or decryption.
use crate::encrypted::{exact_fields, id, number};
use crate::owner_key::canonical_uuid;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

pub(crate) const MAX_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) fn failure() -> Value {
    json!({"status":400,"code":"PS051","message":"PS051: Invalid sharing or rotation request"})
}
pub(crate) fn conflict() -> Value {
    json!({"status":409,"code":"PS015","message":"PS015: Safe integer limit reached"})
}
pub(crate) fn credentials(input: &Value) -> Option<(String, String, &str)> {
    let actor = input["actor"].as_str()?.to_ascii_lowercase();
    let session = input["session"].as_str()?.to_ascii_lowercase();
    (canonical_uuid(&actor) && canonical_uuid(&session)).then_some((
        actor,
        session,
        id(&input["boxId"])?,
    ))
}
fn fixed<const N: usize>(value: &Value) -> Option<[u8; N]> {
    let text = value.as_str()?;
    if text.len() != 4 * N.div_ceil(3) {
        return None;
    }
    let decoded = BASE64.decode(text).ok()?;
    let bytes: [u8; N] = decoded.as_slice().try_into().ok()?;
    (BASE64.encode(bytes) == text).then_some(bytes)
}
fn key_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(crate) fn valid_envelope(value: &Value, box_id: &str, sender: &str, recipient: &str) -> bool {
    let c = &value["context"];
    if value.to_string().len() > 2048
        || !exact_fields(value, &["format", "suite", "context", "enc", "ciphertext"])
        || !exact_fields(
            c,
            &[
                "passwordBoxId",
                "senderAccountId",
                "recipientAccountId",
                "keyEpoch",
                "senderIdentityVersion",
                "recipientIdentityVersion",
                "senderKeyId",
                "recipientKeyId",
            ],
        )
        || value["format"].as_u64() != Some(1)
        || value["suite"].as_str() != Some("hpke-auth/0x0020/0x0001/0x0003")
        || id(&c["passwordBoxId"]) != Some(box_id)
        || c["senderAccountId"].as_str() != Some(sender)
        || c["recipientAccountId"].as_str() != Some(recipient)
        || sender == recipient
        || !canonical_uuid(sender)
        || !canonical_uuid(recipient)
        || number(&c["keyEpoch"], false).is_none()
        || number(&c["senderIdentityVersion"], false).is_none()
        || number(&c["recipientIdentityVersion"], false).is_none()
        || !key_id(&c["senderKeyId"])
        || !key_id(&c["recipientKeyId"])
        || fixed::<48>(&value["ciphertext"]).is_none()
    {
        return false;
    }
    let Some(p) = fixed::<32>(&value["enc"]) else {
        return false;
    };
    p[31] & 0x80 == 0 && !(p[31] == 0x7f && p[1..31].iter().all(|&b| b == 0xff) && p[0] >= 0xed)
}
pub(crate) fn sql_plan(
    actor: &str,
    session: &str,
    box_id: &str,
    operation: &str,
    operation_id: Value,
    target: Value,
    request: Value,
) -> Value {
    json!({"status":200,"body":{
        "sql":"SELECT passshare_sharing_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::uuid,$6::text,$7::jsonb,$8::text) AS reply",
        "requiresReauthentication":operation == "commit",
        "params":[actor,session,box_id,operation,operation_id,target,request,Value::Null]}})
}
pub fn plan(input: &Value) -> Value {
    let Some((actor, session, box_id)) = credentials(input) else {
        return failure();
    };
    let request = &input["request"];
    match input["operation"].as_str() {
        Some("grant-delete") if request.is_null() => {
            let Some(recipient) = input["recipientId"].as_str().filter(|s| canonical_uuid(s))
            else {
                return failure();
            };
            sql_plan(
                &actor,
                &session,
                box_id,
                "grant-delete",
                Value::Null,
                json!(recipient),
                Value::Null,
            )
        }
        Some("grant-get") if request.is_null() => sql_plan(
            &actor,
            &session,
            box_id,
            "grant-get",
            Value::Null,
            Value::Null,
            Value::Null,
        ),
        Some("grant-put")
            if exact_fields(
                request,
                &[
                    "expectedStateRevision",
                    "keyEpoch",
                    "expectedVersion",
                    "envelope",
                ],
            ) =>
        {
            let Some(recipient) = input["recipientId"].as_str().filter(|s| canonical_uuid(s))
            else {
                return failure();
            };
            if number(&request["expectedStateRevision"], false).is_none()
                || number(&request["keyEpoch"], false).is_none()
                || number(&request["expectedVersion"], true) != Some(0)
                || !valid_envelope(&request["envelope"], box_id, &actor, recipient)
                || request["keyEpoch"] != request["envelope"]["context"]["keyEpoch"]
            {
                return failure();
            }
            sql_plan(
                &actor,
                &session,
                box_id,
                "grant-put",
                Value::Null,
                json!(recipient),
                request.clone(),
            )
        }
        _ => failure(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub const A: &str = "11111111-1111-4111-8111-111111111111";
    pub const B: &str = "22222222-2222-4222-8222-222222222222";
    pub fn envelope(epoch: u64) -> Value {
        let mut point = [0u8; 32];
        point[0] = 9;
        json!({"format":1,"suite":"hpke-auth/0x0020/0x0001/0x0003","context":{
            "passwordBoxId":"b".repeat(26),"senderAccountId":A,"recipientAccountId":B,"keyEpoch":epoch,
            "senderIdentityVersion":1,"recipientIdentityVersion":1,"senderKeyId":"a".repeat(64),"recipientKeyId":"b".repeat(64)},
            "enc":BASE64.encode(point),"ciphertext":BASE64.encode([0u8;48])})
    }
    fn input() -> Value {
        json!({"actor":A,"session":B,"boxId":"b".repeat(26),"recipientId":B,"operation":"grant-put",
            "request":{"expectedStateRevision":1,"expectedVersion":0,"keyEpoch":1,"envelope":envelope(1)}})
    }
    #[test]
    fn creates_parameterized_plan_without_credentials_and_accepts_lookup() {
        let i = input();
        let p = plan(&i);
        assert_eq!(p["status"], 200);
        assert_eq!(p["body"]["params"][6], i["request"]);
        assert_eq!(p["body"]["params"][7], Value::Null);
        let mut get = i;
        get["operation"] = json!("grant-get");
        get["request"] = Value::Null;
        assert_eq!(plan(&get)["status"], 200);
    }
    #[test]
    fn isolates_bad_public_fields_and_noncanonical_points() {
        assert_eq!(plan(&input())["status"], 200);
        for (path, bad) in [
            ("/request/expectedVersion", json!(1)),
            ("/request/keyEpoch", json!(2)),
            ("/request/expectedStateRevision", json!(MAX_INTEGER + 1)),
            ("/request/envelope/format", json!(1.0)),
            ("/request/envelope/suite", json!("hpke-base")),
            ("/request/envelope/context/senderIdentityVersion", json!(0)),
            (
                "/request/envelope/context/recipientKeyId",
                json!("A".repeat(64)),
            ),
            (
                "/request/envelope/ciphertext",
                json!(BASE64.encode([0u8; 47])),
            ),
            (
                "/request/envelope/enc",
                json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB="),
            ),
        ] {
            let mut i = input();
            *i.pointer_mut(path).unwrap() = bad;
            assert_eq!(plan(&i)["status"], 400, "{path}");
        }
        // enc has no self-fingerprint field. Keep both account fingerprints and
        // every other header unchanged to isolate its coordinate check.
        let mut p = [0xffu8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        let mut high = [0u8; 32];
        high[31] = 0x80;
        for point in [p, high] {
            let mut i = input();
            i["request"]["envelope"]["enc"] = json!(BASE64.encode(point));
            assert_eq!(plan(&i)["status"], 400);
        }
        for path in ["/request", "/request/envelope", "/request/envelope/context"] {
            let mut i = input();
            i.pointer_mut(path).unwrap()["privateKey"] = json!("sentinel");
            let p = plan(&i);
            assert_eq!(p["status"], 400);
            assert!(!p.to_string().contains("sentinel"));
        }
    }
    #[test]
    fn each_required_field_rejects_null_or_absence_independently() {
        let valid = input();
        assert_eq!(plan(&valid)["status"], 200);
        for path in ["/request", "/request/envelope", "/request/envelope/context"] {
            let keys: Vec<_> = valid
                .pointer(path)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            for field in keys {
                let mut changed = valid.clone();
                changed.pointer_mut(path).unwrap()[&field] = Value::Null;
                assert_eq!(plan(&changed)["status"], 400, "null {path}/{field}");
                changed
                    .pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(&field);
                assert_eq!(plan(&changed)["status"], 400, "missing {path}/{field}");
            }
        }
        for field in ["expectedStateRevision", "keyEpoch", "expectedVersion"] {
            for bad in [
                json!(true),
                json!("1"),
                json!(1.0),
                json!(-1),
                json!(MAX_INTEGER + 1),
            ] {
                let mut changed = valid.clone();
                changed["request"][field] = bad;
                assert_eq!(plan(&changed)["status"], 400, "type/range {field}");
            }
        }
        for field in ["actor", "session", "recipientId"] {
            let mut changed = valid.clone();
            changed[field] = json!("00000000-0000-0000-0000-000000000000");
            assert_eq!(plan(&changed)["status"], 400, "nil {field}");
        }
        let mut remove = valid;
        remove["operation"] = json!("grant-delete");
        remove["request"] = Value::Null;
        let p = plan(&remove);
        assert_eq!(p["status"], 200);
        assert_eq!(p["body"]["params"][3], "grant-delete");
    }
}
