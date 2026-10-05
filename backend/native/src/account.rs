use serde_json::{json, Value};

pub fn validate_input(input: &Value) -> Value {
    let current = input["currentPassword"].as_str();
    let next = input["newPassword"].as_str();
    if current.is_none_or(|value| value.encode_utf16().count() < 8)
        || next.is_none_or(|value| value.chars().count() < 8 || value.len() > 1024)
    {
        return json!({"status":400,"code":"PS021","message":"New password must contain at least 8 characters and at most 1024 bytes"});
    }
    if current == next {
        return json!({"status":400,"code":"PS046","message":"New password must differ from current password"});
    }
    json!({"status":200,"body":{"action":"verify-current-password"}})
}

// The adapter verifies and hashes passwords with the existing Argon2id module.
// This decision executes against the user/session read inside the commit lock.
// Output is an action only; no credentials are returned or logged by native IPC.
pub fn authorize_change(input: &Value) -> Value {
    let current = input["currentHash"]
        .as_str()
        .filter(|value| value.starts_with("$argon2id$") && (60..=512).contains(&value.len()));
    let expected = input["verifiedHash"].as_str();
    if input["sessionExists"] != true || current.is_none() || current != expected {
        return json!({"status":401,"code":"PS024","message":"Session is invalid or expired"});
    }
    let next = input["nextHash"].as_str().unwrap_or("");
    if !next.starts_with("$argon2id$")
        || next.len() < 60
        || next.len() > 512
        || Some(next) == current
    {
        return json!({"status":400,"code":"PS046","message":"Invalid password change"});
    }
    json!({"status":200,"body":{"action":"change-password-and-revoke-all"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let old = format!("$argon2id${}", "a".repeat(80));
        json!({"sessionExists":true,"currentHash":old,"verifiedHash":old,
          "nextHash":format!("$argon2id${}", "x".repeat(80))})
    }
    #[test]
    fn invalid_or_unchanged_input_never_reaches_hashing() {
        let valid = json!({"currentPassword":"old-value-123","newPassword":"new-value-456"});
        assert_eq!(validate_input(&valid)["status"], 200);
        let mut legacy = valid.clone();
        legacy["currentPassword"] = json!("x".repeat(2048));
        assert_eq!(
            validate_input(&legacy)["status"],
            200,
            "existing long passwords remain changeable"
        );
        legacy["currentPassword"] = json!("😀😀😀😀");
        assert_eq!(
            validate_input(&legacy)["status"],
            200,
            "retain signup UTF-16 length contract"
        );
        for value in [
            Value::Null,
            json!("short"),
            json!("x".repeat(1025)),
            json!("old-value-123"),
        ] {
            let mut input = valid.clone();
            input["newPassword"] = value;
            assert_eq!(validate_input(&input)["status"], 400);
        }
    }
    #[test]
    fn matching_authenticated_snapshot_rotates_without_returning_hashes() {
        assert_eq!(
            authorize_change(&fixture())["body"],
            json!({"action":"change-password-and-revoke-all"})
        );
    }
    #[test]
    fn revoked_or_changed_credentials_cannot_commit() {
        for (key, value) in [
            ("sessionExists", json!(false)),
            ("currentHash", json!("new-current")),
            ("verifiedHash", Value::Null),
        ] {
            let mut input = fixture();
            input[key] = value;
            assert_eq!(authorize_change(&input)["status"], 401);
        }
    }
    #[test]
    fn malformed_new_hash_is_denied() {
        for value in [Value::Null, json!("plain-text"), json!("$argon2id$short")] {
            let mut input = fixture();
            input["nextHash"] = value;
            assert_eq!(authorize_change(&input)["status"], 400);
        }
    }
}
