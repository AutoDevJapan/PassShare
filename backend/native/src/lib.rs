pub mod create;
pub mod edit;
pub mod share;

use serde_json::{json, Value};

pub fn dispatch(input: &Value) -> Value {
    match input.get("command").and_then(Value::as_str) {
        Some("invitation-proof") => share::prepare(input),
        Some("invitation-accept") => share::accept(input),
        Some("schema") => json!({"status":200,"body":create::SCHEMA}),
        Some("scope") => match create::scope(input) {
            Ok(body) => json!({"status":200,"body":body}),
            Err(_) => json!({"status":400,"message":"PS018: Invalid creation operation"}),
        },
        Some("create") => create::decide(input),
        Some("record") => create::record(input),
        Some("edit") => {
            let original = &input["original"];
            let expected = input["version"].as_u64().filter(|value| *value > 0);
            if expected.is_none() || expected != original["version"].as_u64() {
                return json!({"status":409,"message":"PS015: Item changed since it was read"});
            }
            match edit::edit_item(original, &input["values"]) {
                Ok(body) => json!({"status":200,"body":body}),
                Err(_) => json!({"status":400,"message":"PS018: Invalid item edit"}),
            }
        }
        _ => json!({"status":400,"message":"PS018: Invalid mutation request"}),
    }
}
