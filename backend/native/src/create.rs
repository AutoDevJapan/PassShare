use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS mutation_operations (actor TEXT NOT NULL, resource TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, result JSONB NOT NULL, PRIMARY KEY(actor, resource, operation, request_key))";

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub fn record(input: &Value) -> Value {
    let result = &input["result"];
    let identity = if input["operation"] == "item" {
        "id"
    } else {
        "vaultId"
    };
    if scope(input).is_err() || !result[identity].is_string() {
        return json!({"status":400,"message":"PS018: Invalid creation result"});
    }
    let mut metadata = json!({"digest":digest(result)});
    metadata[identity] = result[identity].clone();
    json!({"status":200,"body":{"request_hash":digest(&input["request"]),"result":metadata}})
}

pub fn scope(input: &Value) -> Result<Value, &'static str> {
    let actor = input["actor"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or("invalid actor")?;
    let resource = input["resource"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or("invalid resource")?;
    let operation = input["operation"]
        .as_str()
        .filter(|value| matches!(*value, "item" | "box"))
        .ok_or("invalid operation")?;
    let key = input["key"]
        .as_str()
        .filter(|value| {
            (16..=80).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .ok_or("invalid key")?;
    if !input["request"].is_object() {
        return Err("invalid request");
    }
    let parts = json!([actor, resource, operation, key]);
    Ok(json!({"parts":parts, "lock":parts.to_string()}))
}

pub fn decide(input: &Value) -> Value {
    if scope(input).is_err() {
        return json!({"status":400,"message":"PS018: Invalid creation operation"});
    }
    if input["existing"].is_null() {
        return json!({"status":200,"body":{"action":"insert"}});
    }
    let existing = &input["existing"];
    if existing["request_hash"] != digest(&input["request"])
        || input["live"].is_null()
        || existing["result"]["digest"] != digest(&input["live"])
    {
        return json!({"status":409,"message":"PS015: Creation result changed; review it before starting another operation"});
    }
    json!({"status":200,"body":{"action":"replay","result":input["live"]}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Value {
        json!({"actor":"actor-a","resource":"box-a","operation":"item","key":"synthetic-operation-0001","request":{"title":"Card","fields":[{"value":"synthetic"}]},"existing":null})
    }

    #[test]
    fn first_request_is_insert_and_exact_replay_is_the_same_result() {
        let mut input = request();
        assert_eq!(decide(&input)["body"]["action"], "insert");
        let result = json!({"id":"synthetic-id","version":1,"title":"Card"});
        input["result"] = result.clone();
        input["existing"] = record(&input)["body"].clone();
        input["live"] = result.clone();
        assert_eq!(
            decide(&input)["body"],
            json!({"action":"replay","result":result})
        );
    }

    #[test]
    fn changed_or_deleted_results_and_changed_payload_are_conflicts() {
        let mut input = request();
        input["result"] = json!({"id":"x","version":1});
        input["existing"] = record(&input)["body"].clone();
        assert_eq!(decide(&input)["status"], 409);
        input["live"] = json!({"id":"x","version":2});
        assert_eq!(decide(&input)["status"], 409);
        input["live"] = input["result"].clone();
        input["request"]["title"] = json!("Changed");
        assert_eq!(decide(&input)["status"], 409);
    }

    #[test]
    fn actor_box_kind_and_key_are_independent_parts_of_scope() {
        let input = request();
        let base = scope(&input).unwrap()["lock"].clone();
        for (field, value) in [
            ("actor", "actor-b"),
            ("resource", "box-b"),
            ("operation", "box"),
            ("key", "synthetic-operation-0002"),
        ] {
            let mut other = input.clone();
            other[field] = json!(value);
            assert_ne!(scope(&other).unwrap()["lock"], base);
        }
        let mut ambiguous = input.clone();
        ambiguous["actor"] = json!("actor-a:box-a");
        ambiguous["resource"] = json!("box");
        assert_ne!(scope(&ambiguous).unwrap()["lock"], base);
    }

    #[test]
    fn invalid_inputs_are_rejected_without_echoing_values() {
        for field in ["actor", "resource", "operation", "key", "request"] {
            let mut input = request();
            input[field] = Value::Null;
            assert_eq!(decide(&input)["status"], 400);
        }
        for key in ["short", "has space and more", "line\nsynthetic-operation"] {
            let mut input = request();
            input["key"] = json!(key);
            assert_eq!(decide(&input)["status"], 400);
        }
    }
}
