//! Real HTTP acceptance for the approved recovery key, account recovery and
//! shared ownership / retirement pages. Every request goes through the running
//! API and the real native service; the pages are read as a browser would.
use super::{http, http_payload, http_raw};
use serde_json::{json, Value};

struct Reply {
    status: u16,
    headers: String,
    html: String,
}

fn percent(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn cookie(headers: &str, name: &str) -> String {
    let prefix = format!("set-cookie: {name}=");
    headers
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with(&prefix))
        .unwrap_or_else(|| panic!("{name} cookie issued"))
        .split_once(':')
        .unwrap()
        .1
        .trim()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

fn cleared(headers: &str, name: &str) -> bool {
    headers.lines().any(|line| {
        line.to_ascii_lowercase()
            .starts_with(&format!("set-cookie: {name}="))
            && line.contains("Max-Age=0")
    })
}

fn between(html: &str, start: &str) -> String {
    let from = html
        .find(start)
        .unwrap_or_else(|| panic!("page has {start}"))
        + start.len();
    html[from..from + html[from..].find('"').unwrap()].to_owned()
}

fn proof(html: &str) -> String {
    between(html, "name=\"csrfToken\" value=\"")
}

fn jar(session: &str, csrf: &str) -> String {
    if session.is_empty() {
        format!("Cookie: {csrf}\r\n")
    } else {
        format!("Cookie: {session}; {csrf}\r\n")
    }
}

fn get(port: u16, path: &str, session: &str) -> Reply {
    let cookies = if session.is_empty() {
        String::new()
    } else {
        format!("Cookie: {session}\r\n")
    };
    let (status, headers, bytes) = http_raw(port, "GET", path, &cookies, &Value::Null);
    Reply {
        status,
        headers,
        html: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

/// Open a page like a browser: keep its cookie jar and the hidden proof.
fn open(port: u16, path: &str, session: &str) -> (Reply, String, String) {
    let page = get(port, path, session);
    assert_eq!(page.status, 200, "{path}");
    let csrf = cookie(&page.headers, "passshare_csrf");
    let token = proof(&page.html);
    assert_eq!(
        csrf.split_once('=').unwrap().1,
        token,
        "hidden proof matches the cookie"
    );
    let cookies = jar(session, &csrf);
    (page, cookies, token)
}

fn post(port: u16, path: &str, cookies: &str, fields: &[(&str, &str)]) -> Reply {
    let payload = fields
        .iter()
        .map(|(name, value)| format!("{}={}", percent(name), percent(value)))
        .collect::<Vec<_>>()
        .join("&");
    let (status, headers, bytes) = http_payload(
        port,
        "POST",
        path,
        cookies,
        "application/x-www-form-urlencoded",
        &payload,
    );
    Reply {
        status,
        headers,
        html: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

fn web_session(port: u16, path: &str, email: &str, password: &str) -> String {
    let (status, headers, bytes) = http_raw(port, "GET", "/api/auth/csrf", "", &Value::Null);
    assert_eq!(status, 200);
    let csrf: Value = serde_json::from_slice(&bytes).unwrap();
    let extra = format!(
        "Cookie: {}\r\nX-CSRF-Token: {}\r\n",
        cookie(&headers, "passshare_csrf"),
        csrf["csrfToken"].as_str().unwrap()
    );
    let (status, headers, _) = http_raw(
        port,
        "POST",
        path,
        &extra,
        &json!({"email":email,"password":password}),
    );
    assert!(status == 200 || status == 201, "{path} {status}");
    cookie(&headers, "passshare_session")
}

fn page_secrets_absent(reply: &Reply, secrets: &[&str]) {
    assert!(!reply.html.contains("<script"), "no script");
    assert!(!reply.html.contains("@@PASSSHARE"), "no unfilled slot");
    for secret in secrets {
        assert!(!reply.html.contains(secret), "secret never echoed");
    }
    assert!(reply.headers.contains("Cache-Control: no-store"));
    assert!(reply.headers.contains("form-action 'self'"));
}

fn mobile_login(port: u16, email: &str, password: &str) -> u16 {
    http(
        port,
        "POST",
        "/api/auth/login",
        "",
        "",
        &json!({"email":email,"password":password}),
    )
    .0
}

pub fn run(port: u16, nonce: u128) {
    let keys = "/api/auth/account/recovery-key";
    let recover = "/api/auth/account/recover";
    let retire = "/api/auth/account/retire";
    let email = format!("lifecycle-{nonce}@example.test");
    let old = format!("Synthetic-Life-Old-{nonce}!");
    let next = format!("Synthetic-Life-New-{nonce}!");
    let session = web_session(port, "/api/auth/signup", &email, &old);

    // Recovery key page: sign-in is required, then the key is shown once.
    let unauth = get(port, &format!("{keys}?locale=ja"), "");
    assert_eq!(unauth.status, 401);
    assert!(unauth.html.contains("href=\"/app/login\"") && !unauth.html.contains("<form"));
    assert!(!unauth.headers.to_ascii_lowercase().contains("set-cookie:"));
    let (page, cookies, token) = open(
        port,
        &format!("{keys}?locale=ja&webOrigin=https://evil.example"),
        &session,
    );
    assert!(page.html.contains("復旧キーを保管する") && page.html.contains("復旧キーを発行"));
    assert!(
        page.html.contains("autocomplete=\"current-password\"")
            && page.html.contains("<form method=\"post\">")
    );
    assert!(!page.html.contains("evil.example") && !page.html.contains("action="));
    assert!(page.html.contains("暗号鍵の復旧とは別です"));
    page_secrets_absent(&page, &[&old]);
    for (locale, title) in [
        ("en", "Keep your recovery key"),
        ("ru", "Сохраните ключ восстановления"),
    ] {
        assert!(get(port, &format!("{keys}?locale={locale}"), &session)
            .html
            .contains(title));
    }
    let forged = post(
        port,
        keys,
        &cookies,
        &[
            ("currentPassword", &old),
            ("csrfToken", "wrong"),
            ("locale", "ja"),
        ],
    );
    assert_eq!(forged.status, 403);
    assert!(forged.html.contains("画面の期限が切れました"));
    page_secrets_absent(&forged, &[&old]);
    let wrong = post(
        port,
        keys,
        &cookies,
        &[
            ("currentPassword", "Wrong-Synthetic-1"),
            ("csrfToken", &token),
            ("locale", "ja"),
        ],
    );
    assert_eq!(wrong.status, 401);
    assert!(wrong.html.contains("現在のパスワードを確認してください"));
    page_secrets_absent(&wrong, &[&old, "Wrong-Synthetic-1"]);
    let issued = post(
        port,
        keys,
        &cookies,
        &[
            ("currentPassword", &old),
            ("csrfToken", &token),
            ("locale", "ja"),
        ],
    );
    assert_eq!(issued.status, 200);
    let first = between(
        &issued.html,
        "readonly spellcheck=\"false\" autocomplete=\"off\" value=\"",
    );
    assert_eq!(first.len(), 43);
    assert_eq!(
        issued.html.matches(&first).count(),
        1,
        "the key appears once"
    );
    assert!(!issued.html.contains("<form") && issued.html.contains("表示は一度だけです"));
    page_secrets_absent(&issued, &[&old]);
    let (again, cookies, token) = open(port, &format!("{keys}?locale=ja"), &session);
    assert!(
        !again.html.contains(&first),
        "a page reload never shows the key"
    );
    let reissued = post(
        port,
        keys,
        &cookies,
        &[
            ("currentPassword", &old),
            ("csrfToken", &token),
            ("locale", "ja"),
        ],
    );
    let second = between(
        &reissued.html,
        "readonly spellcheck=\"false\" autocomplete=\"off\" value=\"",
    );
    assert_ne!(first, second);
    let hub = get(port, "/api/auth/password/settings?locale=ja", &session);
    assert!(
        hub.html
            .contains("href=\"../account/recovery-key?locale=ja\"")
            && hub.html.contains("href=\"../account/retire?locale=ja\""),
        "account page links to the new pages without leaving a proxy prefix"
    );

    // Recovery page: no session, the same answer for an unknown account or a
    // replaced key, one use per key, and every old credential stops working.
    let (page, cookies, token) = open(port, &format!("{recover}?locale=ja"), "");
    for name in ["email", "recoveryKey", "newPassword", "confirmPassword"] {
        assert!(page.html.contains(&format!("name=\"{name}\"")), "{name}");
    }
    assert_eq!(page.html.matches("value=").count(), 2, "fields start empty");
    assert!(
        page.html.contains("復旧してログインへ")
            && page.html.contains("すべての端末からログアウト")
    );
    page_secrets_absent(&page, &[&first, &second]);
    let attempt = |who: &str, key: &str, confirm: &str, proof: &str| {
        post(
            port,
            recover,
            &cookies,
            &[
                ("email", who),
                ("recoveryKey", key),
                ("newPassword", &next),
                ("confirmPassword", confirm),
                ("csrfToken", proof),
                ("locale", "ja"),
            ],
        )
    };
    let forged = attempt(&email, &second, &next, "wrong");
    assert_eq!(forged.status, 403);
    page_secrets_absent(&forged, &[&second, &next]);
    let mismatch = attempt(&email, &second, "different", &token);
    assert_eq!(mismatch.status, 400);
    assert!(mismatch.html.contains("新しいパスワードが一致しません"));
    page_secrets_absent(&mismatch, &[&second, &next, "different"]);
    let replaced = attempt(&email, &first, &next, &token);
    let unknown = attempt(
        &format!("unknown-{nonce}@example.test"),
        &second,
        &next,
        &token,
    );
    for denied in [&replaced, &unknown] {
        assert_eq!(denied.status, 401);
        assert!(denied
            .html
            .contains("メールアドレスまたは復旧キーが正しくありません"));
        page_secrets_absent(denied, &[&first, &second, &next]);
    }
    let done = attempt(&email, &second, &next, &token);
    assert_eq!(done.status, 200);
    assert!(
        done.html.contains("パスワードを復旧しました") && done.html.contains("href=\"/app/login\"")
    );
    assert!(!done.html.contains("<form"));
    page_secrets_absent(&done, &[&second, &next]);
    assert!(
        cleared(&done.headers, "passshare_session") && cleared(&done.headers, "passshare_csrf")
    );
    assert_eq!(
        http_raw(
            port,
            "GET",
            "/api/auth/me",
            &format!("Cookie: {session}\r\n"),
            &Value::Null
        )
        .0,
        401
    );
    assert_eq!(
        attempt(&email, &second, &next, &token).status,
        401,
        "a used key is gone"
    );
    assert_eq!(mobile_login(port, &email, &old), 401);
    assert_eq!(mobile_login(port, &email, &next), 200);

    // Retirement page: every box that would be left without an owner repeats
    // the same control; deletion works only after ownership moved.
    let actor_password = format!("Synthetic-Life-Actor-{nonce}!");
    let actor_email = format!("lifecycle-actor-{nonce}@example.test");
    let (status, actor) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":actor_email,"password":actor_password}),
    );
    assert_eq!(status, 201);
    let peer_email = format!("lifecycle-peer-{nonce}@example.test");
    let (status, peer) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":peer_email,"password":format!("Synthetic-Life-Peer-{nonce}!")}),
    );
    assert_eq!(status, 201);
    let bearer = actor["refreshToken"].as_str().unwrap();
    let peer_bearer = peer["refreshToken"].as_str().unwrap();
    let (_, boxes) = http(
        port,
        "GET",
        "/v1/vaults",
        actor["connectAccessToken"].as_str().unwrap(),
        "",
        &Value::Null,
    );
    let first_box = boxes[0]["id"].as_str().unwrap().to_owned();
    let (status, created) = http(
        port,
        "POST",
        "/api/auth/vaults",
        bearer,
        "lifecycle-box-0001",
        &json!({"name":"Synthetic second box"}),
    );
    assert_eq!(status, 201);
    let second_box = created["vaultId"].as_str().unwrap().to_owned();
    let items = format!("/v1/vaults/{first_box}/items");
    let (status, item) = http(
        port,
        "POST",
        &items,
        actor["connectAccessToken"].as_str().unwrap(),
        "lifecycle-item-0001",
        &json!({"title":"Synthetic shared retained item","category":"LOGIN","fields":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","type":"CONCEALED","label":"password","value":format!("Synthetic-Life-Field-{nonce}")}],"customMetadata":{"retain":true}}),
    );
    assert_eq!(status, 201);
    for shared in [&first_box, &second_box] {
        let (status, invite) = http(
            port,
            "POST",
            &format!("/api/auth/vaults/{shared}/invitations"),
            bearer,
            "",
            &json!({"email":peer_email}),
        );
        assert_eq!(status, 201);
        let accept = format!(
            "/api/auth/invitations/{}/accept",
            invite["id"].as_str().unwrap()
        );
        assert_eq!(
            http(
                port,
                "POST",
                &accept,
                peer_bearer,
                "",
                &json!({"confirmationCode":invite["confirmationCode"]})
            )
            .0,
            200
        );
    }
    let peer_id = peer["user"]["id"].as_str().unwrap().to_owned();
    let session = web_session(port, "/api/auth/login", &actor_email, &actor_password);
    let (page, cookies, token) = open(port, &format!("{retire}?locale=ja"), &session);
    assert!(
        page.html.contains("共有を引き継いで退会する")
            && page
                .html
                .contains("共有の最後の所有者は、先に所有者を移譲します")
    );
    assert_eq!(
        page.html.matches("name=\"transfer\"").count(),
        2,
        "the control repeats for each box"
    );
    for shared in [&first_box, &second_box] {
        assert!(page.html.contains(&format!("name=\"target.{shared}\"")));
    }
    assert!(page.html.contains(&peer_email) && page.html.contains("name=\"delete\""));
    assert!(
        page.html
            .contains("本人だけのパスワードボックスは削除します")
            && page.html.contains("ほかの人が使う共有データは残します")
    );
    page_secrets_absent(&page, &[&actor_password]);
    let deletion = |password: &str, confirm: &str| {
        post(
            port,
            retire,
            &cookies,
            &[
                ("currentPassword", password),
                ("confirmationEmail", confirm),
                ("delete", "1"),
                ("csrfToken", &token),
                ("locale", "ja"),
            ],
        )
    };
    let blocked = deletion(&actor_password, &actor_email);
    assert_eq!(blocked.status, 409);
    assert!(
        blocked.html.contains("先に所有者を移譲")
            && blocked.html.matches("name=\"transfer\"").count() == 2
    );
    let handover = |shared: &str, target: Option<&str>| {
        let key = format!("target.{shared}");
        let mut fields = vec![
            ("currentPassword", actor_password.as_str()),
            ("transfer", shared),
            ("csrfToken", token.as_str()),
            ("locale", "ja"),
        ];
        if let Some(target) = target {
            fields.push((key.as_str(), target));
        }
        post(port, retire, &cookies, &fields)
    };
    let missing = handover(&first_box, None);
    assert_eq!(missing.status, 409);
    assert!(missing.html.contains("引き継ぐ相手を"));
    let moved = handover(&first_box, Some(&peer_id));
    assert_eq!(moved.status, 200);
    assert!(moved.html.contains("所有者を移譲しました"));
    page_secrets_absent(&moved, &[&actor_password]);
    let (page, _, _) = open(port, &format!("{retire}?locale=ja"), &session);
    assert_eq!(page.html.matches("name=\"transfer\"").count(), 1);
    assert_eq!(handover(&second_box, Some(&peer_id)).status, 200);
    let (page, _, _) = open(port, &format!("{retire}?locale=ja"), &session);
    assert!(!page.html.contains("name=\"transfer\"") && page.html.contains("name=\"delete\""));
    let wrong_email = deletion(&actor_password, "other@example.test");
    assert_eq!(wrong_email.status, 400);
    assert!(wrong_email.html.contains("確認用メールアドレスが"));
    let wrong_password = deletion("Wrong-Synthetic-2", &actor_email);
    assert_eq!(wrong_password.status, 401);
    assert!(wrong_password
        .html
        .contains("現在のパスワードを確認してください"));
    page_secrets_absent(&wrong_password, &["Wrong-Synthetic-2"]);
    let gone = deletion(&actor_password, &actor_email);
    assert_eq!(gone.status, 200);
    assert!(gone.html.contains("アカウントを削除しました") && !gone.html.contains("<form"));
    assert!(
        cleared(&gone.headers, "passshare_session") && cleared(&gone.headers, "passshare_csrf")
    );
    assert_eq!(
        http_raw(
            port,
            "GET",
            "/api/auth/me",
            &format!("Cookie: {session}\r\n"),
            &Value::Null
        )
        .0,
        401
    );
    assert_eq!(mobile_login(port, &actor_email, &actor_password), 401);
    let (_, token) = http(
        port,
        "GET",
        "/api/auth/connect-token",
        peer_bearer,
        "",
        &Value::Null,
    );
    let access = token["accessToken"].as_str().unwrap();
    let (_, kept) = http(port, "GET", "/v1/vaults", access, "", &Value::Null);
    for shared in [&first_box, &second_box] {
        assert!(
            kept.as_array()
                .unwrap()
                .iter()
                .any(|b| b["id"] == shared.as_str()),
            "shared box kept"
        );
    }
    let (status, detail) = http(
        port,
        "GET",
        &format!("{items}/{}", item["id"].as_str().unwrap()),
        access,
        "",
        &Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(detail["title"], "Synthetic shared retained item");
    let (status, again) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":actor_email,"password":actor_password}),
    );
    assert_eq!(status, 201);
    let (_, fresh) = http(
        port,
        "GET",
        "/v1/vaults",
        again["connectAccessToken"].as_str().unwrap(),
        "",
        &Value::Null,
    );
    assert!(
        fresh
            .as_array()
            .unwrap()
            .iter()
            .all(|b| b["id"] != first_box.as_str() && b["id"] != second_box.as_str()),
        "same email regains nothing"
    );

    // Signed-out requests cost the process budget only, then get cheap JSON.
    let mut limited = false;
    for _ in 0..60 {
        let reply = get(port, &format!("{recover}?locale=ja"), "");
        if reply.status == 429 {
            assert!(!reply.headers.to_ascii_lowercase().contains("set-cookie:"));
            let body: Value = serde_json::from_str(&reply.html).unwrap();
            assert_eq!(body["error"], "PS029");
            limited = true;
            break;
        }
        assert_eq!(reply.status, 200);
    }
    assert!(limited, "the signed-out recovery page has its own budget");
    println!("lifecycle pages passed: one-time key display, unified denial, CSRF, single-use recovery, repeated ownership control, retirement with retained sharing");
}
