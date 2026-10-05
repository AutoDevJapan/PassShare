//! Exercise the cookie/CSRF flow used by the approved Web sharing screen.
//! Synthetic cookies, tokens and invitation codes never appear in diagnostics.
use super::{http, http_raw};
use serde_json::{json, Value};

const FIELD_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

struct WebActor {
    cookies: String,
    csrf: String,
    user_id: String,
}

fn cookie(headers: &str, name: &str) -> String {
    let prefix = format!("set-cookie: {name}=");
    headers
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with(&prefix))
        .expect("synthetic web cookie issued")
        .split_once(':')
        .unwrap()
        .1
        .trim()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

impl WebActor {
    fn signup(port: u16, email: &str) -> Self {
        let (status, headers, bytes) = http_raw(port, "GET", "/api/auth/csrf", "", &Value::Null);
        assert_eq!(status, 200);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let headers = format!(
            "Cookie: {}\r\nX-CSRF-Token: {}\r\n",
            cookie(&headers, "passshare_csrf"),
            body["csrfToken"].as_str().unwrap()
        );
        let (status, headers, bytes) = http_raw(
            port,
            "POST",
            "/api/auth/signup",
            &headers,
            &json!({"email":email,"password":"Synthetic-Web-Share-2026!"}),
        );
        assert_eq!(status, 201);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body.get("refreshToken").is_none());
        Self {
            cookies: format!(
                "Cookie: {}; {}\r\n",
                cookie(&headers, "passshare_session"),
                cookie(&headers, "passshare_csrf")
            ),
            csrf: body["csrfToken"].as_str().unwrap().to_owned(),
            user_id: body["user"]["id"].as_str().unwrap().to_owned(),
        }
    }

    fn request(&self, port: u16, method: &str, path: &str, body: &Value) -> (u16, Value) {
        let headers = format!("{}X-CSRF-Token: {}\r\n", self.cookies, self.csrf);
        let (status, _, bytes) = http_raw(port, method, path, &headers, body);
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("web sharing response JSON")
        };
        (status, body)
    }

    fn connect_token(&self, port: u16) -> String {
        let (status, body) = self.request(port, "GET", "/api/auth/connect-token", &Value::Null);
        assert_eq!(status, 200);
        body["accessToken"].as_str().unwrap().to_owned()
    }
}

pub fn run(port: u16, nonce: u128) {
    let owner = WebActor::signup(port, &format!("web-owner-{nonce}@example.test"));
    let email = format!("web-member-{nonce}@example.test");
    let member = WebActor::signup(port, &email);
    let owner_access = owner.connect_token(port);
    let (status, boxes) = http(port, "GET", "/v1/vaults", &owner_access, "", &Value::Null);
    assert_eq!(status, 200);
    let box_id = boxes[0]["id"].as_str().unwrap();
    let invitations = format!("/api/auth/vaults/{box_id}/invitations");
    let members = format!("/api/auth/vaults/{box_id}/members");
    let items = format!("/v1/vaults/{box_id}/items");
    let (status, created) = http(
        port,
        "POST",
        &items,
        &owner_access,
        "web-sharing-fixture-item",
        &json!({"title":"Synthetic web shared item","category":"LOGIN",
            "fields":[{"id":FIELD_ID,"type":"CONCEALED","label":"password",
                "value":"synthetic-web-share-secret"}]}),
    );
    assert_eq!(status, 201);
    let (status, stored_items) = http(port, "GET", &items, &owner_access, "", &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(stored_items.as_array().unwrap().len(), 1);
    let detail = format!("{items}/{}", created["id"].as_str().unwrap());
    let (status, stored_detail) = http(port, "GET", &detail, &owner_access, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        stored_detail == created,
        "the persisted baseline matches the complete created item"
    );
    assert!(
        stored_detail["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field["id"] == FIELD_ID && field["value"] == "synthetic-web-share-secret"),
        "the persisted baseline includes the synthetic password"
    );
    let (status, before) = owner.request(port, "GET", &members, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(before["members"].as_array().unwrap().len(), 1);

    let invite_body = json!({"email":email});
    let (status, _, _) = http_raw(port, "POST", &invitations, &owner.cookies, &invite_body);
    assert_eq!(status, 403, "cookie invitation requires CSRF header");
    let (status, invitation) = owner.request(port, "POST", &invitations, &invite_body);
    assert_eq!(status, 201);
    let first_code = invitation["confirmationCode"].as_str().unwrap();
    let first_id = invitation["id"].as_str().unwrap();
    assert_eq!(first_code.len(), 43);
    assert_eq!(
        owner
            .request(
                port,
                "DELETE",
                &format!("{invitations}/{first_id}"),
                &Value::Null
            )
            .0,
        204
    );
    assert_eq!(
        member
            .request(
                port,
                "POST",
                &format!("/api/auth/invitations/{first_id}/accept"),
                &json!({"confirmationCode":first_code})
            )
            .0,
        404,
        "revoked web invitation cannot be accepted"
    );
    let (status, invitation) = owner.request(port, "POST", &invitations, &invite_body);
    assert_eq!(status, 201);
    let code = invitation["confirmationCode"].as_str().unwrap();
    assert!(
        code != first_code,
        "replacement invitation has independent proof"
    );
    let accept = format!(
        "/api/auth/invitations/{}/accept",
        invitation["id"].as_str().unwrap()
    );
    for (actor, path) in [
        (&owner, invitations.as_str()),
        (&member, "/api/auth/invitations"),
    ] {
        let (status, listed) = actor.request(port, "GET", path, &Value::Null);
        assert_eq!(status, 200);
        assert!(listed["invitations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == invitation["id"]));
        let listed = listed.to_string();
        assert!(
            !listed.contains(code) && !listed.contains("confirmation"),
            "lists contain no usable proof or stored digest"
        );
    }
    let proof = json!({"confirmationCode":code});
    assert_eq!(
        http_raw(port, "POST", &accept, &member.cookies, &proof).0,
        403,
        "cookie acceptance requires CSRF header"
    );
    for (actor, body) in [
        (&member, json!({})),
        (&member, json!({"confirmationCode":first_code})),
        (&member, json!({"confirmationCode":"!".repeat(43)})),
        (&owner, proof.clone()),
    ] {
        let (status, denied) = actor.request(port, "POST", &accept, &body);
        assert_eq!(
            status, 403,
            "only independently verified intended person can join"
        );
        let denied = denied.to_string();
        assert!(
            !denied.contains(code) && !denied.contains(first_code),
            "denials do not reflect proof"
        );
    }
    let before_access = member.connect_token(port);
    assert_eq!(
        http(port, "GET", &items, &before_access, "", &Value::Null).0,
        403
    );
    assert_eq!(
        http(port, "GET", &detail, &before_access, "", &Value::Null).0,
        403
    );
    let (status, unchanged) = owner.request(port, "GET", &members, &Value::Null);
    assert_eq!(status, 200);
    assert!(
        unchanged == before,
        "all denied requests leave memberships unchanged"
    );
    let (status, accepted) = member.request(port, "POST", &accept, &proof);
    assert_eq!(status, 200);
    assert!(accepted == json!({"vaultId":box_id,"role":"member"}));
    assert_eq!(member.request(port, "POST", &accept, &proof).0, 404);
    let after_access = member.connect_token(port);
    let (status, shared_items) = http(port, "GET", &items, &after_access, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        shared_items == stored_items,
        "confirmed web member sees the retained item overview"
    );
    let (status, shared_detail) = http(port, "GET", &detail, &after_access, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        shared_detail == stored_detail,
        "confirmed web member reads the complete stored item including password"
    );
    let (status, joined) = owner.request(port, "GET", &members, &Value::Null);
    assert_eq!(status, 200);
    assert!(
        joined["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["userId"].as_str() == Some(&member.user_id)
                && row["role"] == "member"
                && row["identityConfirmed"] == true),
        "cookie acceptance records the intended confirmed member"
    );
    assert_eq!(
        owner
            .request(
                port,
                "DELETE",
                &format!("{members}/{}", member.user_id),
                &Value::Null
            )
            .0,
        204
    );
    assert_eq!(
        http(port, "GET", &items, &after_access, "", &Value::Null).0,
        401
    );
    assert_eq!(
        http(port, "GET", &detail, &after_access, "", &Value::Null).0,
        401
    );
    let removed_access = member.connect_token(port);
    assert_eq!(
        http(port, "GET", &items, &removed_access, "", &Value::Null).0,
        403,
        "new web token cannot restore removed membership"
    );
    assert_eq!(
        http(port, "GET", &detail, &removed_access, "", &Value::Null).0,
        403
    );
    let (status, retained_items) = http(port, "GET", &items, &owner_access, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        retained_items == stored_items,
        "sharing changes preserve the owner's item overview"
    );
    let (status, retained_detail) = http(port, "GET", &detail, &owner_access, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        retained_detail == stored_detail,
        "sharing changes preserve the owner's complete item including password"
    );
}
