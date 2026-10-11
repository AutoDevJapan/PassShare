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

// One owned psql connection, with a fresh autocommit SELECT for every sample.
// No transaction/row lock is retained between samples. The stdin transport and
// output cap match fixture_sql; neither SQL nor untrusted stderr is printed.
struct Observer {
    child: SqlChild,
    input: Option<std::sync::mpsc::SyncSender<String>>,
    replies: std::sync::mpsc::Receiver<Result<Value, &'static str>>,
    workers: Vec<thread::JoinHandle<()>>,
}
impl Observer {
    fn start(db: &Database, label: &str) -> Self {
        let mut child = SqlChild(
            db.psql(true, Some(label))
                .args(["-f", "-", "-v", "ECHO=none", "-v", "VERBOSITY=verbose"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("owned expiry observer launch"),
        );
        let (input, requests) = std::sync::mpsc::sync_channel::<String>(1);
        let (send, replies) = std::sync::mpsc::channel();
        let mut stdin = child.0.stdin.take().unwrap();
        let writer_send = send.clone();
        let writer = thread::spawn(move || {
            for sql in requests {
                let cell = format!("SELECT pg_catalog.convert_from(pg_catalog.decode('{}','base64'),'UTF8') \\gexec\n", BASE64.encode(sql));
                if stdin
                    .write_all(cell.as_bytes())
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    let _ = writer_send.send(Err("input write failed"));
                    return;
                }
            }
            // Closing the only stdin owner supplies EOF, also on failure.
        });
        let stdout = child.0.stdout.take().unwrap();
        let reader_send = send.clone();
        let reader = thread::spawn(move || {
            use std::io::BufRead;
            let mut reader = std::io::BufReader::new(stdout.take(8 * 1024 * 1024 + 1));
            let mut total = 0;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(n) => total += n,
                    Err(_) => {
                        let _ = reader_send.send(Err("output read failed"));
                        break;
                    }
                }
                if total > 8 * 1024 * 1024 {
                    let _ = reader_send.send(Err("output exceeded bound"));
                    break;
                }
                let sample =
                    serde_json::from_str(line.trim()).map_err(|_| "invalid observer reply");
                if reader_send.send(sample).is_err() {
                    break;
                }
            }
        });
        let stderr = child.0.stderr.take().unwrap();
        let errors = thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stderr.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes);
            if result.is_err() || bytes.len() > 8 * 1024 * 1024 {
                let _ = send.send(Err("stderr exceeded bound or read failed"));
            } else if !bytes.is_empty() {
                // Never propagate PostgreSQL context, SQL or secret literals.
                let text = String::from_utf8_lossy(&bytes);
                let lock = text.contains("55P03") || text.contains("40P01");
                let timeout = text.contains("57014");
                eprintln!("legacy observer SQL error: lock={lock} statement_timeout={timeout}");
                let _ = send.send(Err("observer SQL failed"));
            }
        });
        Self {
            child,
            input: Some(input),
            replies,
            workers: vec![writer, reader, errors],
        }
    }
    fn query(&self, sql: &str, deadline: Instant) -> Result<Value, &'static str> {
        if Instant::now() >= deadline {
            return Err("observation deadline");
        }
        self.input
            .as_ref()
            .unwrap()
            .try_send(sql.to_owned())
            .map_err(|_| "observer input unavailable")?;
        let reply = self
            .replies
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "observation deadline")?;
        // A queued reply/drain after the boundary must never become evidence.
        if Instant::now() >= deadline {
            return Err("observation deadline");
        }
        reply
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        drop(self.input.take());
        if !reap_before(&mut self.child.0, Instant::now() + Duration::from_secs(2)) {
            let _ = self.child.0.kill();
            if !reap_before(&mut self.child.0, Instant::now() + Duration::from_secs(2)) {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
            }
        }
        let drain = Instant::now() + Duration::from_secs(2);
        while self.workers.iter().any(|w| !w.is_finished()) && Instant::now() < drain {
            thread::sleep(Duration::from_millis(10));
        }
        for worker in self.workers.drain(..) {
            if !worker.is_finished() || worker.join().is_err() {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Default)]
struct Evidence {
    live: Option<(u64, u64)>,
    expired: bool,
}
impl Evidence {
    fn record(&mut self, sample: &Value, received: Instant, deadline: Instant) {
        if received >= deadline
            || sample["native"] != true
            || sample["blocked"] != true
            || sample["observer_blocks_writer"] != false
        {
            return;
        }
        let Some(waiter) = sample["waiter"].as_u64().filter(|p| *p > 0) else {
            return;
        };
        let Some(holder) = sample["holder"].as_u64().filter(|p| *p > 0) else {
            return;
        };
        let pair = (waiter, holder);
        if sample["live"] == true && sample["expired"] == false && self.live.is_none() {
            self.live = Some(pair);
        } else if sample["expired"] == true && sample["live"] == false && self.live == Some(pair) {
            self.expired = true;
        }
    }
}

fn observe(
    db: &Database,
    sql: &str,
    marker: &str,
    deadline: Instant,
) -> (Evidence, Option<Observer>) {
    let started = Instant::now();
    if started >= deadline {
        eprintln!("legacy observation marker={marker} phase=not_started remaining_ms=0");
        return (Evidence::default(), None);
    }
    let observer = Observer::start(db, &format!("ps1163-observer-{marker}"));
    let spawn_ms = started.elapsed().as_millis();
    eprintln!(
        "legacy phase marker={marker} phase=observer_launched remaining_ms={} spawn_ms={spawn_ms}",
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
    );
    let mut evidence = Evidence::default();
    let mut samples = 0;
    let mut last = Value::Null;
    let mut first_ms = None;
    let mut max_roundtrip_ms = 0;
    let mut failure = "none";
    loop {
        let query_start = Instant::now();
        match observer.query(sql, deadline) {
            Ok(sample) => {
                samples += 1;
                first_ms.get_or_insert(started.elapsed().as_millis());
                max_roundtrip_ms = max_roundtrip_ms.max(query_start.elapsed().as_millis());
                evidence.record(&sample, Instant::now(), deadline);
                last = sample;
                if evidence.expired {
                    break;
                }
            }
            Err(reason) => {
                failure = reason;
                break;
            }
        }
        // Pacing only; every accepted sample is a separate real PG statement.
        thread::sleep(
            Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    eprintln!("legacy observation marker={marker} phase={} remaining_ms={} spawn_ms={spawn_ms} first_reply_ms={first_ms:?} max_roundtrip_ms={max_roundtrip_ms} last_sql_ms={:?} samples={samples} native_seen={} blocked={} other_blocked={} observer_blocks_writer={} session_live={} session_expired={} same_pair={} failure={failure}",
        if evidence.expired { "expired_blocked" } else if evidence.live.is_some() { "live_blocked" } else if samples == 0 { "observer_not_ready" } else { "native_pending" },
        deadline.saturating_duration_since(Instant::now()).as_millis(),
        last["sql_ms"].as_f64(), last["native"] == true, last["blocked"] == true,
        last["other_blocked"] == true, last["observer_blocks_writer"] == true,
        last["live"] == true, last["expired"] == true, evidence.expired);
    // All deadline decisions are sealed above. The coordinator releases the
    // business holder BEFORE observer close/kill/reap/drain, including timeout.
    // No response received during that cleanup can promote failed evidence.
    (evidence, Some(observer))
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
    eprintln!(
        "legacy phase marker={marker} phase=setup remaining_ms={}",
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
    );
    let (auth_status, me) = http(p, "GET", "/api/auth/me", &b.headers(), &Value::Null);
    assert_eq!(
        auth_status, 200,
        "B token is accepted AFTER synthetic time setup"
    );
    assert_eq!(me["user"]["id"], b.id);
    eprintln!(
        "legacy phase marker={marker} phase=auth_accepted remaining_ms={}",
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
    );
    let hash_sql = business_hash_sql();
    let hash_started = Instant::now();
    let before = db.sql_before(&hash_sql, deadline);
    eprintln!(
        "legacy phase marker={marker} phase=snapshot remaining_ms={} roundtrip_ms={}",
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis(),
        hash_started.elapsed().as_millis()
    );
    let response_deadline = Instant::now() + Duration::from_secs(15);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let response = http(p, op.method, &op.path, &op.headers, &op.body);
        let _ = sender.send(response);
    });
    let observation = format!(
        "SET statement_timeout=12000; SET idle_in_transaction_session_timeout=15000; DO $$ BEGIN PERFORM pg_stat_clear_snapshot(); END $$; \
         WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS started), \
         blocked AS MATERIALIZED (SELECT w.pid AS waiter,h.pid AS holder FROM pg_stat_activity w \
         JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) \
         WHERE w.datname=current_database() AND h.datname=current_database() \
         AND w.pid<>pg_backend_pid() AND h.application_name='{label}' AND h.state='idle in transaction' \
         AND w.state='active' AND w.wait_event_type='Lock' AND w.query LIKE '%{marker}(%') \
         SELECT jsonb_build_object('native',EXISTS(SELECT 1 FROM pg_stat_activity w WHERE w.datname=current_database() \
         AND w.pid<>pg_backend_pid() AND w.state='active' AND w.query LIKE '%{marker}(%'), \
         'blocked',EXISTS(SELECT 1 FROM blocked),'waiter',(SELECT waiter FROM blocked LIMIT 1), \
         'other_blocked',EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) \
         WHERE w.datname=current_database() AND h.application_name='{label}' AND w.query NOT LIKE '%{marker}(%'), \
         'observer_blocks_writer',EXISTS(SELECT 1 FROM pg_stat_activity w WHERE w.datname=current_database() \
         AND pg_backend_pid()=ANY(pg_blocking_pids(w.pid))), \
         'holder',(SELECT holder FROM blocked LIMIT 1),'live',({session_live}),'expired',({session_expired}), \
         'sql_ms',extract(epoch FROM clock_timestamp()-tick.started)*1000) FROM tick"
    );
    // First observe this exact function blocked while its actor is STILL live.
    // For remove/transfer this is after earlier membership/role writes; for
    // retirement entering the function also proves HTTP password/guard checks
    // completed despite an ordinary SELECT on the held zero-failure row.
    // Only then observe PG's real clock crossing the same session deadline,
    // with that same holder still blocking the formal mutation. No fixed sleep
    // or manual session deletion can satisfy either assertion.
    let (evidence, observer) = observe(db, &observation, marker, deadline);
    let live_wait = evidence.live.is_some();
    let expired_wait = evidence.expired;
    held.commit();
    drop(held);
    drop(observer);
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
    eprintln!("legacy outcomes marker={marker} http_401={} ps024={} rows_xmin_unchanged={} original_deadline_restored=true", status == 401, reply["error"] == "PS024", after == before);
    assert!(
        !CLEANUP_FAILED.load(Ordering::SeqCst),
        "owned expiry observer and holder cleanup must succeed"
    );
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
    // Independent real-PG control: a warmed observer must not retain a row lock
    // or stale transaction snapshot that prevents a writer/next sample.
    db.sql("CREATE TABLE passshare1163_observer_control(value integer); INSERT INTO passshare1163_observer_control VALUES(1)");
    let observer = Observer::start(db, "ps1163-observer-control");
    let read = "SELECT jsonb_build_object('pid',pg_backend_pid(),'value',value) FROM passshare1163_observer_control";
    let first = observer
        .query(read, Instant::now() + Duration::from_secs(5))
        .expect("observer control first real read");
    assert_eq!(first["value"], 1);
    assert_eq!(
        db.sql_before(
            "UPDATE passshare1163_observer_control SET value=2 RETURNING value",
            Instant::now() + Duration::from_secs(5)
        ),
        "2",
        "observer SELECT permits independent committed writer"
    );
    let second = observer
        .query(read, Instant::now() + Duration::from_secs(5))
        .expect("observer control second real read");
    assert!(first["pid"].as_u64().is_some_and(|pid| pid > 0));
    assert_eq!(second["pid"], first["pid"], "one PG observer backend");
    assert_eq!(
        second["value"], 2,
        "fresh snapshot sees independent writer commit"
    );
    drop(observer);
    db.sql("DROP TABLE passshare1163_observer_control");
    println!(
        "legacy observer control passed: one backend, independent writer commit, fresh snapshot"
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(live: bool, waiter: u64, holder: u64) -> Value {
        json!({"native":true,"blocked":true,"live":live,"expired":!live,
               "waiter":waiter,"holder":holder,"observer_blocks_writer":false})
    }

    #[test]
    fn two_distinct_pg_samples_require_the_same_waiter_and_holder() {
        let deadline = Instant::now();
        let early = deadline - Duration::from_nanos(1);
        let mut evidence = Evidence::default();
        evidence.record(&sample(false, 11, 22), early, deadline);
        assert!(evidence.live.is_none() && !evidence.expired);
        evidence.record(&sample(true, 11, 22), early, deadline);
        assert_eq!(evidence.live, Some((11, 22)));
        evidence.record(&sample(false, 12, 22), early, deadline);
        evidence.record(&sample(false, 11, 23), early, deadline);
        assert!(!evidence.expired);
        evidence.record(&sample(false, 11, 22), early, deadline);
        assert!(evidence.expired);
    }

    #[test]
    fn deadline_boundary_rejects_a_queued_live_or_expired_reply() {
        let deadline = Instant::now();
        let early = deadline - Duration::from_nanos(1);
        for received in [deadline, deadline + Duration::from_nanos(1)] {
            let mut evidence = Evidence::default();
            evidence.record(&sample(true, 11, 22), received, deadline);
            assert!(evidence.live.is_none());
            evidence.record(&sample(true, 11, 22), early, deadline);
            evidence.record(&sample(false, 11, 22), received, deadline);
            assert!(!evidence.expired);
            evidence.record(&sample(false, 11, 22), early, deadline);
            assert!(evidence.expired);
        }
    }

    #[test]
    fn auth_or_expiry_without_pg_blocker_is_not_evidence() {
        let deadline = Instant::now();
        let early = deadline - Duration::from_nanos(1);
        for field in [
            "native",
            "blocked",
            "waiter",
            "holder",
            "observer_blocks_writer",
        ] {
            let mut invalid = sample(true, 11, 22);
            invalid[field] = match field {
                "waiter" | "holder" => json!(0),
                "observer_blocks_writer" => json!(true),
                _ => json!(false),
            };
            let mut evidence = Evidence::default();
            evidence.record(&invalid, early, deadline);
            assert!(evidence.live.is_none(), "invalid {field}");
            evidence.record(&sample(true, 11, 22), early, deadline);
            invalid["live"] = json!(false);
            invalid["expired"] = json!(true);
            evidence.record(&invalid, early, deadline);
            assert!(!evidence.expired, "invalid {field}");
        }
    }
}
