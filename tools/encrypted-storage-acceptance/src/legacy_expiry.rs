//! Late real-time expiry through formal HTTP, with actual PostgreSQL blockers.
//! Only the invocation-owned DB receives synthetic deadline/login-guard setup.
use super::*;
use std::time::Instant;

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn auth_budget(db: &Database) {
    // The real shared guard allows 30 proofs per IP per 15-minute window.
    // This group uses four proofs; leave one more for the parent's final live
    // retirement. Prior rotation proofs may still fill that window. Wait for
    // actual guard-row expiry BEFORE any short session deadline or row holder;
    // never change quota settings, IPs, or login_ip_requests. This pacing is
    // unrelated to lock/expiry evidence and does not extend a race's budget.
    let deadline = Instant::now() + Duration::from_secs(15 * 60 + 10);
    loop {
        let query_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
        if db.sql_before(
            "SELECT NOT EXISTS(SELECT 1 FROM login_ip_requests WHERE expires_at>clock_timestamp() GROUP BY ip HAVING count(*)>25)",
            query_deadline,
        ) == "t" {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "real auth quota did not free five slots within its window"
        );
        thread::sleep(Duration::from_secs(1));
    }
}

fn token_row(db: &Database, p: u16, account: &Account) -> String {
    // Rotation/legacy transitions revoke tokens. Always mint the row through
    // the real GET route; never assume the signup Connect token still exists.
    let issued = call(
        p,
        account,
        "GET",
        "/api/auth/connect-token",
        &Value::Null,
        200,
    );
    let token = text_field(&issued, "accessToken");
    let row = db.sql(&format!(
        "SELECT id::text FROM connect_tokens WHERE user_id={} AND token_hash=encode(sha256(convert_to({},'UTF8')),'hex') AND expires_at>clock_timestamp()",
        literal(&account.id), literal(&token)
    ));
    assert!(
        !row.is_empty(),
        "real Connect issuance has a live target row"
    );
    row
}

fn business_hash_sql() -> String {
    // The shared digest covers all memberships/roles, boxes, tokens, identities,
    // keys, items and staging. Add full users/sessions/compatibility rows/xmin
    // so a rejected retirement cannot hide a cascade or credential/session loss.
    // Auth IP accounting and legitimate loginGuard.clearFailures are ancillary,
    // deliberately excluded. Snapshot AFTER synthetic expiry/guard setup.
    let extra = ["users", "sessions", "connect_items", "connect_item_files", "mutation_operations"]
        .iter()
        .map(|table| format!(
            "SELECT '{table}' AS name,coalesce(string_agg(md5(jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)::text),',' ORDER BY md5(jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)::text)),'') AS digest FROM {table} r"
        ))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    format!(
        "SELECT md5(({})||'|'||(SELECT string_agg(name||':'||digest,'|' ORDER BY name) FROM ({extra}) full_rows))",
        state_hash_sql(true)
    )
}

fn poll_before(db: &Database, sql: &str, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if db.sql_before(sql, deadline) == "t" {
            return true;
        }
        // Poll pacing only: evidence comes exclusively from PostgreSQL.
        thread::sleep(Duration::from_millis(20));
    }
    false
}

fn hold_row(db: &Database, label: &str, lock_sql: &str) -> HeldBox {
    // Reuse the driver's NoWindow psql command and HeldBox's finite Drop/reap.
    // Crucially there is NO connect_vaults lock in this holder: auth and all
    // earlier business locks must succeed before reaching the late target row.
    let child = db
        .psql(true, Some(label))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("owned late-expiry SQL holder");
    let mut held = HeldBox { child };
    writeln!(held.child.stdin.as_mut().unwrap(),
        "SET statement_timeout=12000; SET idle_in_transaction_session_timeout=15000; BEGIN; {lock_sql};"
    ).unwrap();
    held.child.stdin.as_mut().unwrap().flush().unwrap();
    let ready = format!(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction' AND query LIKE '%FOR UPDATE%')"
    );
    assert!(
        wait_db(db, &ready),
        "holder acquired the exact late target row"
    );
    held
}

fn expired_while_waiting(db: &Database, p: u16, b: &Account, op: Concurrent, lock_sql: &str) {
    // Resolve the exact current HTTP token, not an ORDER BY created_at guess.
    // Only synthetic tokens enter this owned query; no credentials are printed.
    let session = db.sql(&format!(
        "SELECT jsonb_build_object('id',id,'expiresAt',expires_at::text) FROM sessions WHERE user_id={} AND token_hash=encode(sha256(convert_to({},'UTF8')),'hex') AND expires_at>clock_timestamp()",
        literal(&b.id), literal(&b.session)
    ));
    let session: Value = checked(serde_json::from_str(&session), "exact live B session row");
    let id = literal(&text_field(&session, "id"));
    let original = literal(&text_field(&session, "expiresAt"));
    request_slot(); // Reserve auth positive control before setting the deadline.
    request_slot(); // Reserve concurrent request; never wait for quota after setup.
    let label = format!("ps1163-expiry-{}", ConnectId::generate().unwrap());
    let mut held = hold_row(db, &label, lock_sql);
    let marker = op.sql_marker;
    if marker == "passshare_legacy_retire" {
        assert_eq!(db.sql_before(&format!(
            "SELECT failures=0 AND locked_until IS NULL AND expires_at>clock_timestamp() FROM login_failures WHERE email={}",
            literal(&b.email)
        ), Instant::now() + Duration::from_secs(5)), "t",
            "ordinary guard SELECT succeeds while the exact failure row is locked");
    }
    let waiting = format!(
        "EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='{label}' AND h.state='idle in transaction' AND w.wait_event_type='Lock' AND w.query LIKE '%{marker}(%')"
    );
    let session_live = format!(
        "EXISTS(SELECT 1 FROM sessions WHERE id={id} AND user_id={} AND expires_at>clock_timestamp())",
        literal(&b.id)
    );
    let session_expired = format!(
        "EXISTS(SELECT 1 FROM sessions WHERE id={id} AND user_id={} AND clock_timestamp()>=expires_at)",
        literal(&b.id)
    );
    // SYNTHETIC owned-DB time setup, not an API changing its deadline. One
    // ten-second observation budget includes setup, initial auth and both polls;
    // eight-second expiry leaves headroom inside the HTTP client's 15 seconds.
    let deadline = Instant::now() + Duration::from_secs(10);
    assert_eq!(db.sql_before(&format!(
        "WITH synthetic AS (UPDATE sessions SET expires_at=clock_timestamp()+interval '8 seconds' WHERE id={id} RETURNING id) SELECT count(*) FROM synthetic"
    ), deadline), "1");
    let (auth_status, me) = http(p, "GET", "/api/auth/me", &b.headers(), &Value::Null);
    assert_eq!(
        auth_status, 200,
        "B token is accepted AFTER synthetic time setup"
    );
    assert_eq!(me["user"]["id"], b.id);
    let hash_sql = business_hash_sql();
    let before = db.sql_before(&hash_sql, deadline);
    let response_deadline = Instant::now() + Duration::from_secs(15);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let response = http(p, op.method, &op.path, &op.headers, &op.body);
        let _ = sender.send(response);
    });
    // First observe this exact function blocked while its actor is STILL live.
    // For remove/transfer this is after earlier membership/role writes; for
    // retirement entering the function also proves HTTP password/guard checks
    // completed despite an ordinary SELECT on the held zero-failure row.
    let live_wait = poll_before(
        db,
        &format!("SELECT ({waiting}) AND ({session_live})"),
        deadline,
    );
    // Only then observe PG's real clock crossing the same session deadline,
    // with that same holder still blocking the formal mutation. No fixed sleep
    // or manual session deletion can satisfy either assertion.
    let expired_wait = live_wait
        && poll_before(
            db,
            &format!("SELECT ({waiting}) AND ({session_expired})"),
            deadline,
        );
    held.commit();
    drop(held);
    let (status, reply) = receiver
        .recv_timeout(response_deadline.saturating_duration_since(Instant::now()))
        .expect("late-expiry HTTP response unavailable within 15 seconds");
    worker.join().expect("late-expiry HTTP worker");
    let after = db.sql_before(&hash_sql, Instant::now() + Duration::from_secs(15));
    // SYNTHETIC restoration of the original deadline for normal API controls
    // and the parent's existing final retirement; never refresh/rewrite tokens.
    assert_eq!(db.sql(&format!(
        "WITH synthetic AS (UPDATE sessions SET expires_at={original}::timestamptz WHERE id={id} RETURNING id) SELECT count(*) FROM synthetic"
    )), "1", "restore the same synthetic-expiry session");
    assert!(
        live_wait,
        "formal SQL must actually wait while initially authorized"
    );
    assert!(
        expired_wait,
        "PG clock must cross expiry while the same SQL still waits"
    );
    assert_eq!(status, 401, "late wait must reject an expired actor");
    assert_eq!(
        reply["error"], "PS024",
        "session expiry, not credential/quota rejection"
    );
    assert_eq!(after, before, "401 preserves every business row/xmin including users, sessions, memberships, roles, keys and tokens");
    assert_eq!(
        call(p, b, "GET", "/api/auth/me", &Value::Null, 200)["user"]["id"],
        b.id
    );
    println!("legacy late expiry passed: {marker}, live HTTP auth, PG blocker while live, PG clock expiry while blocked, HTTP 401 PS024, whole business row/xmin preservation, synthetic deadline restored");
}

fn roles(db: &Database, b: &Account, d: &Account, b_role: &str, d_role: &str) {
    assert_eq!(db.sql(&format!(
        "SELECT count(*)=2 AND bool_and(passshare_membership_active(role,confirmed_at) AND role=CASE WHEN user_id={} THEN {} ELSE {} END) FROM vault_memberships WHERE vault_id={} AND user_id IN ({},{})",
        literal(&b.id), literal(b_role), literal(d_role), literal(&b.box_id), literal(&b.id), literal(&d.id)
    )), "t", "actual confirmed compatibility membership roles");
}

fn remove(b: &Account, d: &Account) -> Concurrent {
    Concurrent {
        headers: b.headers(),
        method: "DELETE",
        path: format!("/api/auth/vaults/{}/members/{}", b.box_id, d.id),
        body: Value::Null,
        status: 401,
        sql_marker: "passshare_legacy_member_change",
    }
}

pub(super) fn run(db: &Database, p: u16, b: &Account, d: &Account) {
    auth_budget(db);
    assert_eq!(
        db.sql("SELECT count(*) FROM users"),
        "2",
        "isolated fixture has exactly two accounts"
    );
    assert_eq!(db.sql(&format!(
        "SELECT NOT EXISTS(SELECT 1 FROM encrypted_box_state WHERE box_id={}) AND (SELECT count(*) FROM vault_memberships WHERE vault_id={})=1 AND EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id={} AND user_id={} AND role='owner')",
        literal(&b.box_id), literal(&b.box_id), literal(&b.box_id), literal(&b.id)
    )), "t", "B owns its personal compatibility box in the isolated fixture");
    accept(p, d, &invite(p, b, d));
    roles(db, b, d, "owner", "member");
    let d_token = token_row(db, p, d);
    expired_while_waiting(
        db,
        p,
        b,
        remove(b, d),
        &format!(
            "SELECT id FROM connect_tokens WHERE id={} AND user_id={} FOR UPDATE",
            literal(&d_token),
            literal(&d.id)
        ),
    );
    let removal = remove(b, d);
    call(p, b, removal.method, &removal.path, &removal.body, 204);
    assert_eq!(db.sql(&format!(
        "SELECT NOT EXISTS(SELECT 1 FROM vault_memberships WHERE vault_id={} AND user_id={}) AND NOT EXISTS(SELECT 1 FROM connect_tokens WHERE user_id={})",
        literal(&b.box_id), literal(&d.id), literal(&d.id)
    )), "t", "live removal really deletes membership and revokes target tokens");
    // Restore confirmed membership using real invite delivery/acceptance proof.
    accept(p, d, &invite(p, b, d));
    roles(db, b, d, "owner", "member");
    let b_token = token_row(db, p, b);
    let transfer_path = format!("/api/auth/vaults/{}/ownership", b.box_id);
    let transfer_body = json!({"targetUserId":d.id,"currentPassword":b.login_password});
    expired_while_waiting(
        db,
        p,
        b,
        Concurrent {
            headers: b.headers(),
            method: "POST",
            path: transfer_path.clone(),
            body: transfer_body.clone(),
            status: 401,
            sql_marker: "passshare_legacy_transfer",
        },
        &format!(
            "SELECT id FROM connect_tokens WHERE id={} AND user_id={} FOR UPDATE",
            literal(&b_token),
            literal(&b.id)
        ),
    );
    // Current real router/SQL return 204 (not 200) for ownership transfer.
    call(p, b, "POST", &transfer_path, &transfer_body, 204);
    roles(db, b, d, "member", "owner");
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM connect_tokens WHERE user_id IN ({},{})",
            literal(&b.id),
            literal(&d.id)
        )),
        "0",
        "live transfer revokes both participants' tokens"
    );
    call(
        p,
        d,
        "POST",
        &transfer_path,
        &json!({"targetUserId":b.id,"currentPassword":d.login_password}),
        204,
    );
    roles(db, b, d, "owner", "member");
    let removal = remove(b, d);
    call(p, b, removal.method, &removal.path, &removal.body, 204);
    assert_eq!(db.sql(&format!(
        "SELECT count(*)=1 AND bool_and(user_id={} AND role='owner') FROM vault_memberships WHERE vault_id={}",
        literal(&b.id), literal(&b.box_id)
    )), "t", "real reverse transfer/removal restore B as sole personal owner");
    // SYNTHETIC zero-failure row: ordinary guard SELECT must allow password
    // verification; only the SQL function's prelock may wait on FOR UPDATE.
    db.sql(&format!(
        "INSERT INTO login_failures(email,failures,locked_until,expires_at) VALUES({},0,NULL,clock_timestamp()+interval '1 hour') ON CONFLICT(email) DO UPDATE SET failures=0,locked_until=NULL,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp()",
        literal(&b.email)
    ));
    assert_eq!(db.sql(&format!(
        "SELECT failures=0 AND locked_until IS NULL AND expires_at>clock_timestamp() FROM login_failures WHERE email={}", literal(&b.email)
    )), "t", "synthetic guard row is live and does not deny authentication");
    expired_while_waiting(
        db,
        p,
        b,
        Concurrent {
            headers: b.headers(),
            method: "DELETE",
            path: "/api/auth/account".to_owned(),
            body: json!({"currentPassword":b.login_password,"confirmationEmail":b.email}),
            status: 401,
            sql_marker: "passshare_legacy_retire",
        },
        &format!(
            "SELECT email FROM login_failures WHERE email={} FOR UPDATE",
            literal(&b.email)
        ),
    );
    assert_eq!(
        db.sql("SELECT count(*) FROM users"),
        "2",
        "expired retirement preserves both fixture accounts"
    );
    // Parent's immediately following real retirement is the live 204 control.
}
