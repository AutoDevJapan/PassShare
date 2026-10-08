//! The host validates public envelope headers only. It never receives a box key
//! and cannot authenticate ciphertext: clients must verify the Core AEAD/AAD.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use passshare_core::{cloud_crypto::EncryptedItem, ConnectId};
use serde_json::{json, Value};

pub const SCHEMA: &str = include_str!("encrypted-schema.sql");
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CIPHERTEXT: usize = 1024 * 1024 + 16;

fn failure() -> Value {
    json!({"status":400,"code":"PS051","message":"PS051: Invalid encrypted storage request"})
}
fn id(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    ConnectId::validate(value).ok()?;
    Some(value)
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
    let Ok(envelope) = serde_json::from_value::<EncryptedItem>(value.clone()) else {
        return false;
    };
    let context = &envelope.context;
    if envelope.format != 1
        || context.password_box_id.as_str() != box_id
        || context.item_id.as_str() != item_id
        || Some(context.item_version) != previous.checked_add(1)
        || context.item_version > MAX_INTEGER
        || !(1..=MAX_INTEGER).contains(&context.key_epoch)
        || envelope.nonce.len() != 32
        || envelope.ciphertext.len() > 4 * MAX_CIPHERTEXT.div_ceil(3)
    {
        return false;
    }
    // STANDARD uses canonical padded base64, rejecting trailing bits and other
    // alphabets. Core's nonce is exactly 24 bytes, ciphertext includes a tag.
    BASE64.decode(&envelope.nonce).is_ok_and(|n| n.len() == 24)
        && BASE64
            .decode(&envelope.ciphertext)
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
    use passshare_core::cloud_crypto::{ItemContext, PasswordBoxKey};
    fn fixture() -> Value {
        let context = ItemContext {
            password_box_id: ConnectId::generate().unwrap(),
            item_id: ConnectId::generate().unwrap(),
            item_version: 1,
            key_epoch: 1,
        };
        let key = PasswordBoxKey::generate().unwrap();
        let item = json!({"id":context.item_id,"version":1,"vault":{"id":context.password_box_id},"title":"Synthetic"});
        json!({"actor":"actor","session":"session","operation":"put","boxId":context.password_box_id,"itemId":context.item_id,
            "request":{"expectedVersion":0,"envelope":key.encrypt_item(&item,&context).unwrap()}})
    }
    #[test]
    fn core_envelope_is_accepted_without_any_server_key() {
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
            ("/boxId", json!(ConnectId::generate().unwrap())),
            ("/itemId", json!(ConnectId::generate().unwrap())),
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
}
