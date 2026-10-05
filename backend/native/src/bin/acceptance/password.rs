use super::http;
use super::share_acceptance::{sql, uuid, Gate};
use serde_json::{json, Value};
use std::{thread, time::Duration};

fn account(port: u16, path: &str, email: &str, password: &str) -> (u16, Value) {
    http(
        port,
        "POST",
        path,
        "",
        "",
        &json!({"email":email,"password":password}),
    )
}

struct Trigger(String);
impl Drop for Trigger {
    fn drop(&mut self) {
        sql(&format!(
            "DROP TRIGGER IF EXISTS {} ON users; DROP FUNCTION IF EXISTS {}();",
            self.0, self.0
        ));
    }
}

pub fn run(port: u16, nonce: u128) {
    let email = format!("password-{nonce}@example.test");
    let old = format!("Synthetic-Old-{nonce}!");
    let next = format!("Synthetic-Next-{nonce}!");
    let (status, first) = account(port, "/api/auth/signup", &email, &old);
    assert_eq!(status, 201);
    let (status, second) = account(port, "/api/auth/login", &email, &old);
    assert_eq!(status, 200);
    let first_session = first["refreshToken"].as_str().unwrap();
    let before_token = first["connectAccessToken"].as_str().unwrap();
    let (status, original_boxes) = http(port, "GET", "/v1/vaults", before_token, "", &Value::Null);
    assert_eq!(status, 200);
    let box_id = original_boxes[0]["id"].as_str().unwrap();
    let item_path = format!("/v1/vaults/{box_id}/items");
    let (status, original_item) = http(
        port,
        "POST",
        &item_path,
        before_token,
        "password-fixture-item",
        &json!({"title":"Synthetic retained item","category":"LOGIN","fields":[{"id":"synthetic-field","type":"STRING","label":"username","value":"synthetic-retained-value"}]}),
    );
    assert_eq!(status, 201);
    let second_session = second["refreshToken"].as_str().unwrap();
    let change = json!({"currentPassword":old,"newPassword":next});
    assert_eq!(
        http(port, "POST", "/api/auth/password/change", "", "", &change).0,
        401,
        "password change requires session"
    );
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/password/change",
            first_session,
            "",
            &json!({"currentPassword":"Wrong-Synthetic!","newPassword":next})
        )
        .0,
        401,
        "stolen session without password is insufficient"
    );
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/password/change",
            first_session,
            "",
            &json!({"currentPassword":old,"newPassword":old})
        )
        .0,
        400,
        "unchanged password is not a rotation"
    );
    assert_eq!(
        http(port, "GET", "/api/auth/me", first_session, "", &Value::Null).0,
        200,
        "failed change retains original session"
    );
    let cleanup_trigger = if std::env::var_os("DATABASE_URL").is_some() {
        let name = format!("cleanup_failure_{nonce}");
        sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END $$; CREATE TRIGGER {name} BEFORE DELETE ON login_failures FOR EACH ROW WHEN(OLD.email='{email}') EXECUTE FUNCTION {name}();"));
        Some(name)
    } else {
        None
    };
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/password/change",
            first_session,
            "",
            &change
        )
        .0,
        204,
        "committed change remains success when ancillary cleanup fails"
    );
    if let Some(name) = cleanup_trigger {
        sql(&format!(
            "DROP TRIGGER {name} ON login_failures; DROP FUNCTION {name}();"
        ));
    }
    for actor in [&first, &second] {
        let session = actor["refreshToken"].as_str().unwrap();
        let token = actor["connectAccessToken"].as_str().unwrap();
        assert_eq!(
            http(port, "GET", "/api/auth/me", session, "", &Value::Null).0,
            401,
            "all former sessions revoked"
        );
        assert_eq!(
            http(port, "GET", "/v1/vaults", token, "", &Value::Null).0,
            401,
            "all former Connect tokens revoked"
        );
        assert_eq!(
            http(
                port,
                "POST",
                "/api/auth/token/refresh",
                "",
                "",
                &json!({"refreshToken":session})
            )
            .0,
            401
        );
    }
    assert_eq!(account(port, "/api/auth/login", &email, &old).0, 401);
    let (status, current) = account(port, "/api/auth/login", &email, &next);
    assert_eq!(status, 200, "new password can log in");
    let access = current["connectAccessToken"].as_str().unwrap();
    assert_eq!(
        http(port, "GET", "/v1/vaults", access, "", &Value::Null).1,
        original_boxes,
        "same box identity survives password change"
    );
    let item_id = original_item["id"].as_str().unwrap();
    assert_eq!(
        http(
            port,
            "GET",
            &format!("{item_path}/{item_id}"),
            access,
            "",
            &Value::Null
        )
        .1,
        original_item,
        "full item remains identical"
    );
    assert_eq!(
        http(
            port,
            "GET",
            "/v1/vaults",
            current["connectAccessToken"].as_str().unwrap(),
            "",
            &Value::Null
        )
        .0,
        200,
        "password change preserves boxes"
    );
    if std::env::var_os("DATABASE_URL").is_some() {
        let user = uuid(&first["user"]["id"]);
        let key = 8_000_000 + (nonce % 1_000_000) as u32;
        let name = format!("credential_gate_{nonce}");
        sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock({key}); RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE UPDATE ON users FOR EACH ROW WHEN(NEW.id='{user}') EXECUTE FUNCTION {name}();"));
        let trigger = Trigger(name);
        let mut gate = Gate::hold(key);
        let session = current["refreshToken"].as_str().unwrap().to_owned();
        let (session_for_change, next_for_change) = (session.clone(), next.clone());
        let change = thread::spawn(move || {
            http(port,"POST","/api/auth/password/change",&session_for_change,"",&json!({"currentPassword":next_for_change,"newPassword":format!("Synthetic-Final-{nonce}!")})).0
        });
        let mut first_pid = None;
        for _ in 0..30 {
            if let Ok(pid)=sql(&format!("SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE l.locktype='advisory' AND l.objid={key} AND NOT l.granted AND a.query LIKE '%users%'")).parse::<u32>() { first_pid=Some(pid);break; }
            thread::sleep(Duration::from_millis(20));
        }
        let pid = first_pid.expect("credential change holds user row until explicit release");
        let (email_for_login, next_for_login) = (email.clone(), next.clone());
        let login = thread::spawn(move || {
            account(port, "/api/auth/login", &email_for_login, &next_for_login)
        });
        let session_for_mint = session.clone();
        let mint = thread::spawn(move || {
            http(
                port,
                "GET",
                "/api/auth/connect-token",
                &session_for_mint,
                "",
                &Value::Null,
            )
        });
        let refresh = thread::spawn(move || {
            http(
                port,
                "POST",
                "/api/auth/token/refresh",
                "",
                "",
                &json!({"refreshToken":session}),
            )
        });
        let mut blocked = false;
        for _ in 0..50 {
            let count=sql(&format!("SELECT count(*) FROM pg_stat_activity WHERE {pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%users%'")).parse::<u32>().unwrap();
            if count >= 2 {
                blocked = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            blocked,
            "old login and token mint both truly blocked by credential change"
        );
        gate.release();
        assert_eq!(change.join().unwrap(), 204);
        assert_eq!(
            login.join().unwrap().0,
            401,
            "stale verification cannot issue a new session"
        );
        assert_eq!(
            refresh.join().unwrap().0,
            401,
            "old session cannot refresh after the change"
        );
        assert_eq!(
            mint.join().unwrap().0,
            401,
            "old session cannot mint a late token"
        );
        assert_eq!(
            sql(&format!(
                "SELECT count(*) FROM sessions WHERE user_id='{user}'"
            )),
            "0"
        );
        assert_eq!(
            sql(&format!(
                "SELECT count(*) FROM connect_tokens WHERE user_id='{user}'"
            )),
            "0"
        );
        drop(trigger);
    }
    assert_eq!(
        http(
            port,
            "GET",
            "/api/auth/me",
            second_session,
            "",
            &Value::Null
        )
        .0,
        401
    );
    let isolated_port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join(if cfg!(windows) {
            "passshare-mutations.exe"
        } else {
            "passshare-mutations"
        });
    let isolated = super::Server::start(isolated_port, binary);
    for _ in 0..30 {
        assert_eq!(
            http(
                isolated_port,
                "POST",
                "/api/auth/password/change",
                "",
                "",
                &json!({})
            )
            .0,
            401,
            "requests within the independent quota reach authorization"
        );
    }
    assert_eq!(
        http(
            isolated_port,
            "POST",
            "/api/auth/password/change",
            "",
            "",
            &json!({})
        )
        .0,
        429,
        "the next request is stopped before authorization"
    );
    drop(isolated);
    println!("credential acceptance passed: proof, all sessions/tokens revoked, fresh login; PostgreSQL additionally proves overlapping login/refresh cannot resurrect access");
}
