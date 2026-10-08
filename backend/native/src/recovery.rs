use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const SCHEMA: &str = "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hash TEXT;";

fn denied() -> Value {
    json!({"status":401,"code":"PS026","message":"Invalid recovery credentials"})
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn key(input: &Value) -> Option<&str> {
    input["recoveryKey"].as_str().filter(|s| {
        s.len() == 43
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}

pub fn prepare(input: &Value) -> Value {
    let Some(value) = key(input) else {
        return denied();
    };
    // Only the high-entropy lookup digest leaves this process.
    json!({"status":200,"body":{"recoveryHash":digest(value)}})
}

pub fn validate_password(input: &Value) -> Value {
    if key(input).is_none() {
        return denied();
    }
    let password = input["newPassword"].as_str().unwrap_or("");
    if password.chars().count() < 8 || password.len() > 1024 {
        return json!({"status":400,"code":"PS021","message":"New password must contain at least 8 characters and at most 1024 bytes"});
    }
    json!({"status":200,"body":{"action":"check-recovery"}})
}

pub fn authorize_issue(input: &Value) -> Value {
    let current = input["currentHash"].as_str().unwrap_or("");
    if input["sessionExists"] != true
        || !valid_password_hash(current)
        || input["verifiedHash"].as_str() != Some(current)
    {
        return denied();
    }
    if !valid_digest(input["recoveryHash"].as_str().unwrap_or("")) {
        return json!({"status":400,"code":"PS018","message":"Invalid recovery key"});
    }
    json!({"status":200,"body":{"action":"replace-recovery-key"}})
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_password_hash(value: &str) -> bool {
    value.starts_with("$argon2id$") && (60..=512).contains(&value.len())
}

pub fn authorize_recovery(input: &Value) -> Value {
    let supplied = input["recoveryHash"].as_str().unwrap_or("");
    let stored = input["storedRecoveryHash"].as_str().unwrap_or("");
    let current = input["currentHash"].as_str().unwrap_or("");
    let differs = supplied
        .bytes()
        .zip(stored.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if !valid_digest(supplied)
        || !valid_digest(stored)
        || differs != 0
        || !valid_password_hash(current)
        || input["verifiedHash"].as_str() != Some(current)
    {
        return denied();
    }
    // The first check deliberately precedes expensive password hashing. A second
    // identical decision executes inside the user's commit lock.
    if let Some(next) = input.get("nextHash") {
        if !next.as_str().is_some_and(valid_password_hash) {
            return json!({"status":400,"code":"PS018","message":"Invalid recovery request"});
        }
    }
    json!({"status":200,"body":{"action":"consume-key-change-password-revoke-all"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn proof() -> Value {
        let current = format!("$argon2id${}", "a".repeat(80));
        json!({"recoveryHash":digest(&"a".repeat(43)),"storedRecoveryHash":digest(&"a".repeat(43)),
            "currentHash":current,"verifiedHash":current,"nextHash":format!("$argon2id${}","b".repeat(80))})
    }
    #[test]
    fn unknown_wrong_consumed_and_stale_keys_share_one_public_error() {
        assert_eq!(authorize_recovery(&proof())["status"], 200);
        for (field, value) in [
            ("storedRecoveryHash", Value::Null),
            ("recoveryHash", json!(digest(&"b".repeat(43)))),
            ("currentHash", Value::Null),
            ("verifiedHash", json!("stale")),
            ("recoveryHash", json!("short")),
        ] {
            let mut request = proof();
            request[field] = value;
            assert_eq!(authorize_recovery(&request), denied());
        }
    }
    #[test]
    fn key_digest_never_echoes_key_and_replaces_only_after_reauthentication() {
        let secret = "A".repeat(43);
        let prepared = prepare(&json!({"recoveryKey":secret}));
        assert_eq!(prepared["status"], 200);
        assert!(!prepared.to_string().contains(&secret));
        assert_eq!(prepare(&json!({"recoveryKey":"/".repeat(43)})), denied());
        let mut request = proof();
        request["sessionExists"] = json!(true);
        assert_eq!(authorize_issue(&request)["status"], 200);
        request["sessionExists"] = json!(false);
        assert_eq!(authorize_issue(&request), denied());
    }
    #[test]
    fn invalid_new_password_and_hash_are_rejected() {
        for password in ["short".to_owned(), "x".repeat(1025)] {
            assert_eq!(
                validate_password(&json!({"recoveryKey":"A".repeat(43),"newPassword":password}))
                    ["status"],
                400
            );
        }
        let mut request = proof();
        request["nextHash"] = json!("plain-text");
        assert_eq!(authorize_recovery(&request)["status"], 400);
    }
}
