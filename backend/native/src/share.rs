use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn error(status: u16, code: &str, message: &str) -> Value {
    json!({"status":status,"code":code,"message":message})
}

fn digest(code: &Value) -> Option<String> {
    let code = code.as_str()?;
    if code.len() != 43
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(format!("{:x}", Sha256::digest(code.as_bytes())))
}

// Only the owner receives the random code at creation. The database and list
// endpoints contain no usable proof. Deliver it to the person through a known,
// independently verified channel, never to an address supplied by the claimant.
pub fn secret(input: &Value) -> Value {
    match digest(&input["confirmationCode"]) {
        Some(hash) => json!({"status":200,"body":{"confirmationHash":hash}}),
        None => error(400, "PS045", "Invalid invitation confirmation code"),
    }
}

pub fn accept(input: &Value) -> Value {
    let invitation = &input["invitation"];
    if invitation["status"].as_str() != Some("pending") {
        return error(404, "PS039", "Invitation not found");
    }
    let (Some(expires), Some(now)) = (invitation["expiresMs"].as_i64(), input["nowMs"].as_i64())
    else {
        return error(410, "PS040", "Invitation has expired");
    };
    if expires <= now {
        return error(410, "PS040", "Invitation has expired");
    }
    if input["email"].as_str().filter(|email| !email.is_empty())
        != invitation["invitee_email"]
            .as_str()
            .filter(|email| !email.is_empty())
        || input["email"].as_str().is_none_or(|email| email.is_empty())
    {
        return error(403, "PS041", "Invitation is for a different email address");
    }
    if input["inviterRole"].as_str() != Some("owner") {
        return error(403, "PS032", "Invitation owner no longer has access");
    }
    if invitation["role"].as_str() != Some("member") {
        return error(403, "PS033", "Invitation role must be member");
    }
    let Some(hash) = digest(&input["confirmationCode"]) else {
        return error(403, "PS045", "Invitation confirmation required");
    };
    let stored = invitation["confirmation_hash"].as_str().unwrap_or("");
    // Fixed-size comparison, including rejection of legacy invitations without
    // proof. No code or digest is reflected in denial responses.
    let differs = stored.len() != hash.len()
        || stored
            .bytes()
            .zip(hash.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            != 0;
    if differs {
        return error(403, "PS045", "Invitation confirmation required");
    }
    json!({"status":200,"body":{"vaultId":invitation["vault_id"],"role":"member"}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let code = "a".repeat(43);
        json!({"email":"member@example.test","nowMs":10,"confirmationCode":code,
            "inviterRole":"owner","invitation":{"status":"pending","expiresMs":20,
                "invitee_email":"member@example.test","role":"member","vault_id":"box",
                "confirmation_hash":digest(&json!(code)).unwrap()}})
    }

    #[test]
    fn verified_channel_proof_allows_member_only() {
        assert_eq!(
            accept(&fixture())["body"],
            json!({"vaultId":"box","role":"member"})
        );
    }

    #[test]
    fn knowing_email_and_invitation_id_does_not_grant_access() {
        for proof in [Value::Null, json!(""), json!("b".repeat(43)), json!(12)] {
            let mut input = fixture();
            input["confirmationCode"] = proof;
            let result = accept(&input);
            assert_eq!(result["status"], 403);
            assert!(result.get("body").is_none());
        }
    }

    #[test]
    fn legacy_or_wrong_account_or_owner_is_denied() {
        for (path, value) in [
            ("/invitation/confirmation_hash", Value::Null),
            ("/email", json!("other@example.test")),
            ("/inviterRole", Value::Null),
            ("/invitation/role", json!("owner")),
        ] {
            let mut input = fixture();
            *input.pointer_mut(path).unwrap() = value;
            assert_eq!(accept(&input)["status"], 403);
        }
    }

    #[test]
    fn revoked_declined_accepted_and_expired_invites_are_denied() {
        for state in ["revoked", "declined", "accepted", "invalid"] {
            let mut input = fixture();
            input["invitation"]["status"] = json!(state);
            assert_eq!(accept(&input)["status"], 404);
        }
        for expiry in [json!(10), Value::Null, json!("NaN")] {
            let mut input = fixture();
            input["invitation"]["expiresMs"] = expiry;
            assert_eq!(accept(&input)["status"], 410);
        }
    }

    #[test]
    fn malformed_proof_never_becomes_a_stored_hash() {
        for code in [
            json!("a".repeat(42)),
            json!("a".repeat(44)),
            json!("!".repeat(43)),
            Value::Null,
        ] {
            assert_eq!(secret(&json!({"confirmationCode":code}))["status"], 400);
        }
    }
}
