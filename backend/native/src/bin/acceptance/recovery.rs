use super::share_acceptance::{sql, uuid, Gate};
use super::{http, http_raw};
use serde_json::{json, Value};
use std::{thread, time::Duration};

pub fn run(port: u16, nonce: u128) {
    let email = format!("recovery-{nonce}@example.test");
    let old = format!("Synthetic-Recovery-Old-{nonce}!");
    let next = format!("Synthetic-Recovery-New-{nonce}!");
    let (status, account) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":email,"password":old}),
    );
    assert_eq!(status, 201);
    let session = account["refreshToken"].as_str().unwrap();
    let access = account["connectAccessToken"].as_str().unwrap();
    let (status, boxes) = http(port, "GET", "/v1/vaults", access, "", &Value::Null);
    assert_eq!(status, 200);
    let items = format!("/v1/vaults/{}/items", boxes[0]["id"].as_str().unwrap());
    let (status, item) = http(
        port,
        "POST",
        &items,
        access,
        "recovery-fixture-001",
        &json!({"title":"Synthetic recovery retained item","category":"LOGIN","fields":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","type":"CONCEALED","label":"password","value":format!("Synthetic-Retained-{nonce}")}],"customMetadata":{"retain":true},"urls":[{"href":"https://example.test"}]}),
    );
    assert_eq!(status, 201);
    let detail = format!("{items}/{}", item["id"].as_str().unwrap());
    let (status, before) = http(port, "GET", &detail, access, "", &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/recovery-key",
            "",
            "",
            &json!({"currentPassword":old})
        )
        .0,
        401
    );
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/recovery-key",
            session,
            "",
            &json!({"currentPassword":format!("Wrong-Synthetic-{nonce}")})
        )
        .0,
        401
    );
    let (status, first) = http(
        port,
        "POST",
        "/api/auth/recovery-key",
        session,
        "",
        &json!({"currentPassword":old}),
    );
    assert_eq!(status, 201);
    let (status, second) = http(
        port,
        "POST",
        "/api/auth/recovery-key",
        session,
        "",
        &json!({"currentPassword":old}),
    );
    assert_eq!(status, 201);
    let key = second["recoveryKey"].as_str().unwrap();
    assert_eq!(key.len(), 43);
    assert_ne!(first, second);
    let (status, public) = http(port, "GET", "/api/auth/me", session, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        !public.to_string().contains(key),
        "key never appears in account reads"
    );
    if std::env::var_os("DATABASE_URL").is_some() {
        let id = uuid(&account["user"]["id"]);
        let stored = sql(&format!("SELECT recovery_hash FROM users WHERE id='{id}'"));
        assert_eq!(stored.len(), 64, "only lookup digest is stored");
        assert_ne!(stored, key);
    }
    let recovery = json!({"email":email,"recoveryKey":key,"newPassword":next});
    let (_, wrong) = http(
        port,
        "POST",
        "/api/auth/password/recover",
        "",
        "",
        &json!({"email":email,"recoveryKey":first["recoveryKey"],"newPassword":next}),
    );
    let (status, unknown) = http(
        port,
        "POST",
        "/api/auth/password/recover",
        "",
        "",
        &json!({"email":format!("unknown-{nonce}@example.test"),"recoveryKey":key,"newPassword":next}),
    );
    assert_eq!(status, 401);
    assert_eq!(
        wrong, unknown,
        "unknown account and invalidated key share public response"
    );
    assert_eq!(
        http_raw(port, "POST", "/api/auth/password/recover", "", &recovery).0,
        403,
        "browser recovery requires CSRF"
    );
    // Two independently arriving recoveries must consume the key exactly once.
    // PostgreSQL additionally proves overlap using a real blocked user row.
    let mut gate = None;
    let mut trigger_name = None;
    if std::env::var_os("DATABASE_URL").is_some() {
        let id = uuid(&account["user"]["id"]);
        let name = format!("recovery_gate_{nonce}");
        let lock_key = 9_000_000 + (nonce % 1_000_000) as u32;
        sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock({lock_key}); RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE UPDATE ON users FOR EACH ROW WHEN(NEW.id='{id}') EXECUTE FUNCTION {name}();"));
        gate = Some((Gate::hold(lock_key), lock_key));
        trigger_name = Some(name);
    }
    let body = recovery.clone();
    let first_request =
        thread::spawn(move || http(port, "POST", "/api/auth/password/recover", "", "", &body).0);
    let mut first_pid = None;
    if let Some((_, lock_key)) = &gate {
        for _ in 0..100 {
            if let Ok(pid) = sql(&format!("SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid={lock_key} AND NOT granted")).parse::<u32>() { first_pid=Some(pid);break }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            first_pid.is_some(),
            "first recovery holds user row before explicit release"
        );
    }
    let body = recovery.clone();
    let second_request =
        thread::spawn(move || http(port, "POST", "/api/auth/password/recover", "", "", &body).0);
    if let Some(pid) = first_pid {
        let mut blocked = false;
        for _ in 0..100 {
            if sql(&format!("SELECT count(*) FROM pg_stat_activity WHERE {pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%users%'")).parse::<u32>().unwrap() >= 1 { blocked=true;break }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(blocked, "second recovery truly blocked by first recovery");
        gate.as_mut().unwrap().0.release();
    }
    let mut statuses = [
        first_request.join().unwrap(),
        second_request.join().unwrap(),
    ];
    statuses.sort();
    assert_eq!(
        statuses,
        [204, 401],
        "one-time key grants exactly one recovery"
    );
    if let Some(name) = trigger_name {
        sql(&format!(
            "DROP TRIGGER {name} ON users; DROP FUNCTION {name}();"
        ));
    }
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/password/recover",
            "",
            "",
            &recovery
        )
        .0,
        401,
        "consumed key rejects replay"
    );
    assert_eq!(
        http(port, "GET", "/api/auth/me", session, "", &Value::Null).0,
        401
    );
    assert_eq!(
        http(port, "GET", "/v1/vaults", access, "", &Value::Null).0,
        401
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
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/login",
            "",
            "",
            &json!({"email":email,"password":old})
        )
        .0,
        401
    );
    let (status, fresh) = http(
        port,
        "POST",
        "/api/auth/login",
        "",
        "",
        &json!({"email":email,"password":next}),
    );
    assert_eq!(status, 200);
    let (status, after) = http(
        port,
        "GET",
        &detail,
        fresh["connectAccessToken"].as_str().unwrap(),
        "",
        &Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(before, after, "entire saved item retained after recovery");
    if std::env::var_os("DATABASE_URL").is_some() {
        let id = uuid(&account["user"]["id"]);
        assert_eq!(
            sql(&format!(
                "SELECT recovery_hash IS NULL FROM users WHERE id='{id}'"
            )),
            "t"
        );
    }
    println!("recovery acceptance passed: reauthentication, rotation, one-time use, uniform denial, CSRF, all sessions and tokens revoked, complete item retained");
}
