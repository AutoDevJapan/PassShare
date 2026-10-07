//! Exercise the real HTML form, its body CSRF boundary and credential rotation.
use super::{http_payload, http_raw};
use serde_json::{json, Value};

fn cookie(headers: &str, name: &str) -> String {
    let prefix = format!("set-cookie: {name}=");
    headers
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with(&prefix))
        .expect("synthetic cookie issued")
        .split_once(':')
        .unwrap()
        .1
        .trim()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

fn page(port: u16, session: &str) -> (String, String) {
    let (status, headers, bytes) = http_raw(
        port,
        "GET",
        "/api/auth/password/settings?locale=ja&webOrigin=https://evil.example",
        session,
        &Value::Null,
    );
    assert_eq!(status, 200);
    let html = String::from_utf8(bytes).unwrap();
    assert!(html.contains("アカウントのパスワード変更"));
    assert!(html.contains("autocomplete=\"current-password\""));
    assert!(
        !html.contains("evil.example"),
        "untrusted return origin rejected"
    );
    assert!(
        html.contains("href=\"/app/vaults\""),
        "same-origin return link"
    );
    assert!(headers.contains("form-action 'self'"));
    assert!(headers.contains("Cache-Control: no-store"));
    let csrf = cookie(&headers, "passshare_csrf");
    let token = csrf.split_once('=').unwrap().1.to_owned();
    (format!("{session}Cookie: {csrf}\r\n"), token)
}

pub fn run(port: u16, nonce: u128) {
    let email = format!("form-password-{nonce}@example.test");
    let old = format!("Synthetic-Form-Old-{nonce}");
    let new = format!("Synthetic-Form-New-{nonce}");
    let (status, initial, bytes) = http_raw(port, "GET", "/api/auth/csrf", "", &Value::Null);
    assert_eq!(status, 200);
    let csrf: Value = serde_json::from_slice(&bytes).unwrap();
    let csrf_cookie = cookie(&initial, "passshare_csrf");
    let headers = format!(
        "Cookie: {csrf_cookie}\r\nX-CSRF-Token: {}\r\n",
        csrf["csrfToken"].as_str().unwrap()
    );
    let (status, signed, _) = http_raw(
        port,
        "POST",
        "/api/auth/signup",
        &headers,
        &json!({"email":email,"password":old}),
    );
    assert_eq!(status, 201);
    let session_cookie = cookie(&signed, "passshare_session");
    let session = format!("Cookie: {session_cookie}\r\n");
    let (status, _, token) = http_raw(
        port,
        "GET",
        "/api/auth/connect-token",
        &session,
        &Value::Null,
    );
    assert_eq!(status, 200);
    let token: Value = serde_json::from_slice(&token).unwrap();
    let bearer = format!(
        "Authorization: Bearer {}\r\n",
        token["accessToken"].as_str().unwrap()
    );
    // Use one Cookie header: duplicate Cookie headers may be normalized differently.
    let (page_headers, proof) = page(port, &session);
    let form_headers = page_headers.replace("\r\nCookie: ", "; ");
    let payload =
        format!("currentPassword={old}&newPassword={new}&confirmPassword=wrong&csrfToken={proof}");
    let (status, _, bytes) = http_payload(
        port,
        "POST",
        "/api/auth/Password/Settings/",
        &form_headers,
        "application/x-www-form-urlencoded",
        &payload,
    );
    assert_eq!(status, 400);
    let html = String::from_utf8(bytes).unwrap();
    assert!(html.contains("新しいパスワードが一致しません"));
    assert!(!html.contains(&old) && !html.contains(&new));
    assert_eq!(
        http_raw(port, "GET", "/api/auth/me", &session, &Value::Null).0,
        200
    );
    let (page_headers, proof) = page(port, &session);
    let form_headers = page_headers.replace("\r\nCookie: ", "; ");
    let payload =
        format!("currentPassword={old}&newPassword={new}&confirmPassword={new}&csrfToken=wrong");
    assert_eq!(
        http_payload(
            port,
            "POST",
            "/api/auth/password/settings",
            &form_headers,
            "application/x-www-form-urlencoded",
            &payload
        )
        .0,
        403
    );
    // Body tokens must not become valid on the JSON endpoint.
    assert_eq!(
        http_raw(
            port,
            "POST",
            "/api/auth/password/change",
            &session,
            &json!({"currentPassword":old,"newPassword":new,"csrfToken":proof})
        )
        .0,
        403
    );
    let (page_headers, proof) = page(port, &session);
    let form_headers = page_headers.replace("\r\nCookie: ", "; ");
    let payload = format!(
        "currentPassword=wrong-current&newPassword={new}&confirmPassword={new}&csrfToken={proof}"
    );
    let (status, _, bytes) = http_payload(
        port,
        "POST",
        "/api/auth/password/settings",
        &form_headers,
        "application/x-www-form-urlencoded",
        &payload,
    );
    assert_eq!(status, 401);
    assert!(String::from_utf8(bytes)
        .unwrap()
        .contains("現在のパスワードを確認"));
    let (page_headers, proof) = page(port, &session);
    let form_headers = page_headers.replace("\r\nCookie: ", "; ");
    let payload =
        format!("currentPassword={old}&newPassword={new}&confirmPassword={new}&csrfToken={proof}");
    let (status, headers, bytes) = http_payload(
        port,
        "POST",
        "/api/auth/password/settings",
        &form_headers,
        "application/x-www-form-urlencoded",
        &payload,
    );
    assert_eq!(status, 200);
    let html = String::from_utf8(bytes).unwrap();
    assert!(html.contains("パスワードを変更しました"));
    assert!(
        html.contains("href=\"/app/login\""),
        "same-origin reauthentication"
    );
    assert!(!html.contains("<form") && !html.contains(&new));
    for name in ["passshare_session", "passshare_csrf"] {
        assert!(headers.lines().any(|line| line
            .to_ascii_lowercase()
            .starts_with(&format!("set-cookie: {name}="))
            && line.contains("Max-Age=0")));
    }
    assert_eq!(
        http_raw(port, "GET", "/api/auth/me", &session, &Value::Null).0,
        401
    );
    assert_eq!(
        http_raw(port, "GET", "/v1/vaults", &bearer, &Value::Null).0,
        401
    );
    let (status, _, bytes) = http_raw(
        port,
        "GET",
        "/api/auth/password/settings",
        &session,
        &Value::Null,
    );
    assert_eq!(status, 401);
    assert!(String::from_utf8(bytes).unwrap().contains("ログインの期限"));
    assert_eq!(
        http_raw(
            port,
            "POST",
            "/api/auth/login",
            "x-passshare-client: mobile\r\n",
            &json!({"email":email,"password":old})
        )
        .0,
        401
    );
    assert_eq!(
        http_raw(
            port,
            "POST",
            "/api/auth/login",
            "x-passshare-client: mobile\r\n",
            &json!({"email":email,"password":new})
        )
        .0,
        200
    );
    println!("HTML password settings: confirmation/CSRF/wrong current/rotation/old tokens/new login passed");
    for (method, headers) in [
        ("GET", "Cookie: passshare_session=%E0%A4%A\r\n"),
        ("POST", ""),
    ] {
        let (status, headers, bytes) = http_raw(
            port,
            method,
            "/api/auth/password/settings",
            headers,
            &Value::Null,
        );
        assert_eq!(status, 401);
        assert!(!headers.to_ascii_lowercase().contains("set-cookie:"));
        let html = String::from_utf8(bytes).unwrap();
        assert!(!html.contains("<form"));
        assert!(html.contains("/app/login"));
        assert!(html.contains("href=\"/app/login\""));
    }
    // Expired responses use a shared cached Rust page and issue no fresh proof.
    // Beyond the page budget the response is cheap JSON, with no native render.
    let mut limited = false;
    for _ in 0..40 {
        let (status, headers, bytes) =
            http_raw(port, "GET", "/api/auth/password/settings", "", &Value::Null);
        assert!(!headers.to_ascii_lowercase().contains("set-cookie:"));
        if status == 429 {
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["error"], "PS029");
            limited = true;
        } else {
            assert_eq!(status, 401);
        }
    }
    assert!(
        limited,
        "unauthenticated page requests have an independent budget"
    );
}
