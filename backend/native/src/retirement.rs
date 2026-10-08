use serde_json::{json, Value};

fn error(status: u16, code: &str, message: &str) -> Value {
    json!({"status":status,"code":code,"message":message})
}
fn authenticated(input: &Value) -> bool {
    let hash = input["currentHash"].as_str().unwrap_or("");
    input["sessionExists"] == true
        && hash.starts_with("$argon2id$")
        && (60..=512).contains(&hash.len())
        && input["verifiedHash"].as_str() == Some(hash)
}

/// True when retiring `actor` would leave a shared box without an owner, so a
/// confirmed member must receive ownership first. The page lists exactly the
/// boxes for which `retire` answers 409.
pub fn needs_transfer(actor: &str, members: &[Value]) -> bool {
    members
        .iter()
        .any(|m| m["user_id"] == actor && m["role"] == "owner")
        && members.iter().any(|m| m["user_id"] != actor)
        && !members
            .iter()
            .any(|m| m["user_id"] != actor && m["role"] == "owner")
}

pub fn transfer(input: &Value) -> Value {
    if !authenticated(input) {
        return error(401, "PS024", "Session is invalid or expired");
    }
    let actor = input["userId"].as_str().unwrap_or("");
    let target = input["targetUserId"].as_str().unwrap_or("");
    let Some(members) = input["members"].as_array() else {
        return error(400, "PS018", "Invalid ownership transfer");
    };
    if actor.is_empty() || target.is_empty() || actor == target {
        return error(400, "PS018", "Invalid ownership transfer");
    }
    if !members
        .iter()
        .any(|m| m["user_id"] == actor && m["role"] == "owner")
    {
        return error(403, "PS032", "Password box owner access required");
    }
    if !members
        .iter()
        .any(|m| m["user_id"] == target && m["role"] == "member" && m["identity_confirmed"] == true)
    {
        return error(
            409,
            "PS047",
            "A confirmed member is required for ownership transfer",
        );
    }
    json!({"status":200,"body":{"action":"transfer-owner","targetUserId":target}})
}

pub fn retire(input: &Value) -> Value {
    if !authenticated(input) {
        return error(401, "PS024", "Session is invalid or expired");
    }
    let actor = input["userId"].as_str().unwrap_or("");
    let email = input["email"].as_str().unwrap_or("");
    if actor.is_empty() || email.is_empty() || input["confirmationEmail"].as_str() != Some(email) {
        return error(400, "PS048", "Confirm the account email before deletion");
    }
    let Some(boxes) = input["boxes"].as_array() else {
        return error(400, "PS018", "Invalid account deletion");
    };
    let mut private = Vec::new();
    for password_box in boxes {
        let Some(members) = password_box["members"].as_array() else {
            return error(400, "PS018", "Invalid account deletion");
        };
        if !members
            .iter()
            .any(|m| m["user_id"] == actor && m["role"] == "owner")
        {
            continue;
        }
        let others: Vec<_> = members.iter().filter(|m| m["user_id"] != actor).collect();
        if others.is_empty() {
            let Some(id) = password_box["id"].as_str().filter(|id| {
                id.len() == 26
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            }) else {
                return error(400, "PS018", "Invalid account deletion");
            };
            private.push(id);
        } else if !others.iter().any(|m| m["role"] == "owner") {
            return error(
                409,
                "PS049",
                "Transfer shared password box ownership before deleting the account",
            );
        }
    }
    json!({"status":200,"body":{"action":"delete-account","privateBoxIds":private}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let hash = format!("$argon2id${}", "a".repeat(80));
        json!({"sessionExists":true,"currentHash":hash,"verifiedHash":hash,"userId":"actor","targetUserId":"peer","email":"synthetic@example.test","confirmationEmail":"synthetic@example.test",
          "members":[{"user_id":"actor","role":"owner"},{"user_id":"peer","role":"member","identity_confirmed":true}],
          "boxes":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","members":[{"user_id":"actor","role":"owner"}]}]})
    }
    #[test]
    fn deletion_removes_only_private_owned_boxes() {
        let mut request = fixture();
        request["boxes"].as_array_mut().unwrap().push(json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","members":[{"user_id":"actor","role":"member"},{"user_id":"peer","role":"owner"}]}));
        assert_eq!(
            retire(&request)["body"]["privateBoxIds"],
            json!(["aaaaaaaaaaaaaaaaaaaaaaaaaa"])
        );
    }
    #[test]
    fn last_shared_owner_must_transfer_first() {
        let mut request = fixture();
        request["boxes"][0]["members"] = request["members"].clone();
        assert_eq!(retire(&request)["status"], 409);
        request["boxes"][0]["members"][1]["role"] = json!("owner");
        assert_eq!(retire(&request)["body"]["privateBoxIds"], json!([]));
    }
    #[test]
    fn only_confirmed_member_can_receive_ownership() {
        assert_eq!(transfer(&fixture())["status"], 200);
        for value in [Value::Null, json!(false)] {
            let mut request = fixture();
            request["members"][1]["identity_confirmed"] = value;
            assert_eq!(transfer(&request)["status"], 409);
        }
        let mut request = fixture();
        request["targetUserId"] = json!("actor");
        assert_eq!(transfer(&request)["status"], 400);
    }
    #[test]
    fn stale_or_unconfirmed_deletion_never_commits() {
        for (field, value, status) in [
            ("sessionExists", json!(false), 401),
            ("verifiedHash", json!("stale"), 401),
            ("confirmationEmail", json!("other@example.test"), 400),
        ] {
            let mut request = fixture();
            request[field] = value;
            assert_eq!(retire(&request)["status"], status);
        }
    }
}
