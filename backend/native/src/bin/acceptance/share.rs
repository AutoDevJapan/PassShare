use super::http;
use serde_json::{json, Value};
use std::thread;

pub fn run(port: u16, nonce: u128, owner: &str, box_id: &str, items: &str) {
    let email = format!("share-{nonce}@example.test");
    let (status, member) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":email,"password":"Synthetic-Passshare-2026!"}),
    );
    assert_eq!(status, 201, "share actor signup");
    let session = member["refreshToken"].as_str().unwrap();
    let invitations = format!("/api/auth/vaults/{box_id}/invitations");
    let (status, invitation) = http(
        port,
        "POST",
        &invitations,
        owner,
        "",
        &json!({"email":email,"role":"member"}),
    );
    assert_eq!(status, 201, "owner creates confirmation code");
    let code = invitation["confirmationCode"].as_str().unwrap();
    assert_eq!(code.len(), 43);
    let id = invitation["id"].as_str().unwrap();
    let accept = format!("/api/auth/invitations/{id}/accept");
    for token in [owner, session] {
        let list = if token == owner {
            invitations.as_str()
        } else {
            "/api/auth/invitations"
        };
        let (status, result) = http(port, "GET", list, token, "", &Value::Null);
        assert_eq!(status, 200);
        assert!(
            !result.to_string().contains(code),
            "proof must not leak through lists"
        );
        assert!(!result.to_string().contains("confirmation_hash"));
    }
    for body in [
        json!({}),
        json!({"confirmationCode":"x".repeat(43)}),
        json!({"confirmationCode":false}),
    ] {
        let (status, error) = http(port, "POST", &accept, session, "", &body);
        assert_eq!(
            status, 403,
            "claimed email and invitation id confer no access"
        );
        assert!(!error.to_string().contains(code));
    }
    assert_eq!(
        http(
            port,
            "GET",
            items,
            member["connectAccessToken"].as_str().unwrap(),
            "",
            &Value::Null
        )
        .0,
        403
    );
    assert_eq!(
        http(
            port,
            "POST",
            &accept,
            owner,
            "",
            &json!({"confirmationCode":code})
        )
        .0,
        403,
        "wrong account cannot consume proof"
    );
    let mut workers = Vec::new();
    for _ in 0..4 {
        let (session, accept, code) = (session.to_owned(), accept.clone(), code.to_owned());
        workers.push(thread::spawn(move || {
            http(
                port,
                "POST",
                &accept,
                &session,
                "",
                &json!({"confirmationCode":code}),
            )
            .0
        }));
    }
    let statuses: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        statuses.iter().filter(|&&status| status == 200).count(),
        1,
        "one acceptance commit"
    );
    assert_eq!(
        statuses.iter().filter(|&&status| status == 404).count(),
        3,
        "consumed invite is not reused"
    );
    let (status, granted) = http(
        port,
        "GET",
        "/api/auth/connect-token",
        session,
        "",
        &Value::Null,
    );
    assert_eq!(status, 200);
    let access = granted["accessToken"].as_str().unwrap();
    let (status, entries) = http(port, "GET", items, access, "", &Value::Null);
    assert_eq!(status, 200, "verified member has access");
    let item = entries[0]["id"].as_str().unwrap();
    let files = format!("{items}/{item}/files");
    let (status, file) = http(
        port,
        "POST",
        &files,
        access,
        "",
        &json!({"name":"synthetic.bin","contentBase64":"AAH+/w=="}),
    );
    assert_eq!(status, 201);
    let file_path = format!("{files}/{}", file["id"].as_str().unwrap());
    let removal = format!(
        "/api/auth/vaults/{box_id}/members/{}",
        member["user"]["id"].as_str().unwrap()
    );
    assert_eq!(
        http(port, "DELETE", &removal, owner, "", &Value::Null).0,
        204
    );
    assert_eq!(
        http(port, "GET", items, access, "", &Value::Null).0,
        401,
        "old token revoked"
    );
    assert_eq!(
        http(port, "GET", &file_path, access, "", &Value::Null).0,
        401,
        "attachments use revoked token guard"
    );
    let (_, fresh) = http(
        port,
        "GET",
        "/api/auth/connect-token",
        session,
        "",
        &Value::Null,
    );
    let fresh = fresh["accessToken"].as_str().unwrap();
    assert_eq!(
        http(port, "GET", items, fresh, "", &Value::Null).0,
        403,
        "new token does not restore membership"
    );
    assert_eq!(
        http(port, "GET", &file_path, fresh, "", &Value::Null).0,
        403
    );
    let (status, invitation) = http(
        port,
        "POST",
        &invitations,
        owner,
        "",
        &json!({"email":email}),
    );
    assert_eq!(status, 201);
    let id = invitation["id"].as_str().unwrap();
    assert_eq!(
        http(
            port,
            "DELETE",
            &format!("{invitations}/{id}"),
            owner,
            "",
            &Value::Null
        )
        .0,
        204
    );
    assert_eq!(
        http(
            port,
            "POST",
            &format!("/api/auth/invitations/{id}/accept"),
            session,
            "",
            &json!({"confirmationCode":invitation["confirmationCode"]})
        )
        .0,
        404,
        "revoked proof cannot grant membership"
    );
}
