//! The host validates public envelope headers only. It never receives a box key
//! and cannot authenticate ciphertext: clients must verify the Core AEAD/AAD.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

pub const SCHEMA: &str = include_str!("encrypted-schema.sql");
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CIPHERTEXT: usize = 1024 * 1024 + 16;

fn failure() -> Value {
    json!({"status":400,"code":"PS051","message":"PS051: Invalid encrypted storage request"})
}
fn id(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    (value.len() == 26
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
    .then_some(value)
}
fn number(value: &Value, zero: bool) -> Option<u64> {
    value
        .as_u64()
        .filter(|n| *n <= MAX_INTEGER && (zero || *n > 0))
}
fn exact_fields(value: &Value, fields: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
    })
}

pub fn valid_envelope(value: &Value, box_id: &str, item_id: &str, previous: u64) -> bool {
    let Some(next) = previous.checked_add(1).filter(|n| *n <= MAX_INTEGER) else {
        return false;
    };
    if !exact_fields(value, &["format", "context", "nonce", "ciphertext"])
        || !exact_fields(
            &value["context"],
            &["passwordBoxId", "itemId", "itemVersion", "keyEpoch"],
        )
    {
        return false;
    }
    let context = &value["context"];
    let (Some(nonce), Some(ciphertext)) = (value["nonce"].as_str(), value["ciphertext"].as_str())
    else {
        return false;
    };
    if value["format"].as_u64() != Some(1)
        || id(&context["passwordBoxId"]) != Some(box_id)
        || id(&context["itemId"]) != Some(item_id)
        || number(&context["itemVersion"], false) != Some(next)
        || number(&context["keyEpoch"], false).is_none()
        || nonce.len() != 32
        || ciphertext.len() > 4 * MAX_CIPHERTEXT.div_ceil(3)
    {
        return false;
    }
    // STANDARD uses canonical padded base64, rejecting trailing bits and other
    // alphabets. Core's nonce is exactly 24 bytes, ciphertext includes a tag.
    BASE64.decode(nonce).is_ok_and(|n| n.len() == 24)
        && BASE64
            .decode(ciphertext)
            .is_ok_and(|c| (16..=MAX_CIPHERTEXT).contains(&c.len()))
}

pub fn plan(input: &Value) -> Value {
    let Some(box_id) = id(&input["boxId"]) else {
        return failure();
    };
    // actor/session are supplied by session middleware, never taken from body.
    let Some(actor) = input["actor"].as_str().filter(|s| !s.is_empty()) else {
        return failure();
    };
    let Some(session) = input["session"].as_str().filter(|s| !s.is_empty()) else {
        return failure();
    };
    let operation = input["operation"].as_str().unwrap_or("");
    let request = &input["request"];
    let (item_id, previous, envelope, epoch) = match operation {
        "enable" if exact_fields(request, &["keyEpoch"]) && request["keyEpoch"] == 1 => {
            (Value::Null, Value::Null, Value::Null, json!(1))
        }
        "state" if request.is_null() => (Value::Null, Value::Null, Value::Null, Value::Null),
        "list" if exact_fields(request, &["after"]) => {
            let after = if request["after"].is_null() {
                Value::Null
            } else if let Some(after) = id(&request["after"]) {
                json!(after)
            } else {
                return failure();
            };
            (after, Value::Null, Value::Null, Value::Null)
        }
        "get" if request.is_null() => {
            let Some(item) = id(&input["itemId"]) else {
                return failure();
            };
            (json!(item), Value::Null, Value::Null, Value::Null)
        }
        "put" if exact_fields(request, &["expectedVersion", "envelope"]) => {
            let Some(item) = id(&input["itemId"]) else {
                return failure();
            };
            let Some(previous) = number(&request["expectedVersion"], true) else {
                return failure();
            };
            if !valid_envelope(&request["envelope"], box_id, item, previous) {
                return failure();
            }
            (
                json!(item),
                json!(previous),
                request["envelope"].clone(),
                request["envelope"]["context"]["keyEpoch"].clone(),
            )
        }
        _ => return failure(),
    };
    json!({"status":200,"body":{
        "sql":"SELECT passshare_encrypted_operation($1::uuid,$2::uuid,$3::varchar,$4::text,$5::varchar,$6::bigint,$7::jsonb,$8::bigint) AS reply",
        "params":[actor,session,box_id,operation,item_id,previous,envelope,epoch]
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        // Public synthetic headers only; real Core crypto lives in the separate
        // acceptance tool. No encryption algorithm is duplicated on the host.
        let box_id = "b".repeat(26);
        let item_id = "i".repeat(26);
        json!({"actor":"actor","session":"session","operation":"put","boxId":box_id,"itemId":item_id,
            "request":{"expectedVersion":0,"envelope":{"format":1,
                "context":{"passwordBoxId":box_id,"itemId":item_id,"itemVersion":1,"keyEpoch":1},
                "nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;16])}}})
    }
    #[test]
    fn synthetic_public_headers_pass_without_crypto_dependencies() {
        let input = fixture();
        assert_eq!(plan(&input)["status"], 200);
        assert_eq!(
            plan(&input)["body"]["params"][6],
            input["request"]["envelope"]
        );
    }
    #[test]
    fn header_scope_revision_format_generation_and_plaintext_fields_rejected() {
        let input = fixture();
        for (path, value) in [
            ("/boxId", json!("c".repeat(26))),
            ("/itemId", json!("d".repeat(26))),
            ("/request/expectedVersion", json!(1)),
            ("/request/envelope/format", json!(2)),
            ("/request/envelope/context/keyEpoch", json!(0)),
            ("/request/envelope/context/keyEpoch", json!(MAX_INTEGER + 1)),
            ("/request/envelope/nonce", json!("x".repeat(31))),
            ("/request/envelope/ciphertext", json!("a")),
            (
                "/request/envelope/ciphertext",
                json!(BASE64.encode([0u8; 15])),
            ),
            (
                "/request/envelope/ciphertext",
                json!("A".repeat(4 * MAX_CIPHERTEXT.div_ceil(3) + 4)),
            ),
        ] {
            let mut changed = input.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert_eq!(plan(&changed)["status"], 400, "{path}");
        }
        for path in ["/request", "/request/envelope", "/request/envelope/context"] {
            let mut changed = input.clone();
            changed.pointer_mut(path).unwrap()["key"] = json!("forbidden");
            assert_eq!(plan(&changed)["status"], 400);
        }
    }
    #[test]
    fn public_fields_require_exact_json_types_and_valid_ids() {
        for (path, value) in [
            ("/request/envelope/format", json!(1.0)),
            ("/request/envelope/format", json!("1")),
            ("/request/envelope/context/itemVersion", json!(1.0)),
            ("/request/envelope/context/itemVersion", json!("1")),
            ("/request/envelope/context/keyEpoch", json!(1.0)),
            ("/request/envelope/context/keyEpoch", json!(true)),
            (
                "/request/envelope/context/passwordBoxId",
                json!("B".repeat(26)),
            ),
            ("/request/envelope/context/itemId", json!("i".repeat(25))),
            ("/request/envelope/nonce", json!(vec![0; 24])),
            ("/request/envelope/ciphertext", Value::Null),
            ("/request/expectedVersion", json!(0.0)),
        ] {
            let mut input = fixture();
            *input.pointer_mut(path).unwrap() = value;
            assert_eq!(plan(&input)["status"], 400, "{path}");
        }
        let input = fixture();
        assert!(!valid_envelope(
            &input["request"]["envelope"],
            input["boxId"].as_str().unwrap(),
            input["itemId"].as_str().unwrap(),
            u64::MAX
        ));
    }
}
