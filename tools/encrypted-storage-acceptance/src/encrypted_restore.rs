//! Synthetic encrypted dump/restore acceptance, never an arbitrary DB restorer.
use super::*;
use std::{ffi::OsString, time::Instant};

pub fn prefix(args: &[OsString]) -> Result<(bool, &[OsString]), &'static str> {
    let enabled = args.first().is_some_and(|a| a == "--encrypted-restore");
    if args
        .iter()
        .skip(usize::from(enabled))
        .any(|a| a == "--encrypted-restore")
    {
        return Err("encrypted restore flag must occur once and first");
    }
    if enabled
        && args[1..].iter().any(|a| {
            [
                "--sharing-rotation",
                "--account-identity",
                "--legacy-expiry",
                "--go-session",
            ]
            .iter()
            .any(|f| a == f)
        })
    {
        return Err("encrypted restore cannot be mixed with other fixtures");
    }
    Ok((enabled, if enabled { &args[1..] } else { args }))
}

// All public base tables, every column, duplicate multiplicity and array order.
// PostgreSQL JSONB canonicalizes object keys. xmin is compared only within the
// source DB; restore legitimately changes transaction IDs and physical order.
fn inventory(db: &Database, xmin: bool) -> Value {
    let tables: Vec<String> = checked(serde_json::from_str(&db.sql("SELECT COALESCE(jsonb_agg(tablename ORDER BY tablename),'[]'::jsonb)::text FROM pg_tables WHERE schemaname='public'")), "table inventory");
    assert!(!tables.is_empty());
    let parts = tables.iter().map(|table| {
        let ident = table.replace('"', "\"\"");
        let name = table.replace('\'', "''");
        let row = if xmin { "jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)" } else { "to_jsonb(r)" };
        format!("SELECT '{name}' AS name, count(*) AS count, md5(COALESCE(string_agg(digest,',' ORDER BY digest),'')) AS hash FROM (SELECT md5(({row})::text) AS digest FROM public.\"{ident}\" r) rows")
    }).collect::<Vec<_>>();
    checked(
        serde_json::from_str(&db.sql(&format!(
            "SELECT jsonb_agg(to_jsonb(t) ORDER BY name)::text FROM ({}) t",
            parts.join(" UNION ALL ")
        ))),
        "full semantic inventory",
    )
}

// This includes identities and the complete current membership/grant set,
// committed revocation history, generations and deletion barriers. An archive
// is never the authority for whether its own old credentials may resume.
fn security_state(db: &Database) -> String {
    let tables = [
        "users",
        "sessions",
        "connect_tokens",
        "vault_invitations",
        "encrypted_box_state",
        "encrypted_owner_keys",
        "encrypted_account_identities",
        "vault_memberships",
        "encrypted_key_grants",
        "encrypted_rotations",
        "encrypted_rotation_items",
        "encrypted_rotation_grants",
        "encrypted_item_tombstones",
    ];
    let parts = tables.iter().map(|t| format!("SELECT '{t}' AS name, count(*)::text || ':' || COALESCE(string_agg(md5(to_jsonb(r)::text),',' ORDER BY md5(to_jsonb(r)::text)),'') AS hash FROM {t} r")).collect::<Vec<_>>();
    db.sql(&format!(
        "SELECT md5(string_agg(name||':'||hash,'|' ORDER BY name)) FROM ({}) t",
        parts.join(" UNION ALL ")
    ))
}

fn bind(db: &Database, owner: &str, purpose: &str) {
    assert!(owner.len() == 32 && owner.bytes().all(|c| c.is_ascii_hexdigit()));
    assert!(matches!(purpose, "source" | "restore"));
    db.sql(&format!("CREATE SCHEMA passshare_acceptance_control; CREATE TABLE passshare_acceptance_control.binding(owner_id text NOT NULL, purpose text NOT NULL, database_name text NOT NULL); INSERT INTO passshare_acceptance_control.binding VALUES('{owner}','{purpose}',current_database())"));
}

fn bound(db: &Database, owner: &str, purpose: &str) -> bool {
    let expected_name = db
        .local
        .as_ref()
        .map_or("passshare", |l| l.database.as_str());
    let row: Value = checked(
        serde_json::from_str(&db.sql(
            "SELECT jsonb_agg(to_jsonb(b))::text FROM passshare_acceptance_control.binding b",
        )),
        "connection purpose binding",
    );
    row.as_array().is_some_and(|r| r.len() == 1)
        && row[0]["owner_id"] == owner
        && row[0]["purpose"] == purpose
        && row[0]["database_name"] == expected_name
        && db.sql("SELECT current_database()") == expected_name
}

fn target(source: &Database, network: &Network, owner: &str) -> Database {
    assert!(
        bound(source, owner, "source"),
        "source connection ownership/purpose"
    );
    let target = if let Some(local) = &source.local {
        let local = local.restore_target();
        Database {
            name: local.database.clone(),
            port: local.port,
            local: Some(local),
        }
    } else {
        Database::start(network)
    };
    assert!(
        target.name != source.name && target.url() != source.url(),
        "restore must use a separate owned database"
    );
    assert_eq!(
        target.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'"),
        "0"
    );
    bind(&target, owner, "restore");
    target
}

fn archive_command(db: &Database, program: &str) -> Command {
    if let Some(local) = &db.local {
        return local.archive_client(program);
    }
    let mut c = command("docker");
    c.args([
        "exec",
        "-i",
        "--env",
        "PGCONNECT_TIMEOUT=5",
        "--env",
        "PGOPTIONS=-c statement_timeout=50000 -c lock_timeout=5000",
        &db.name,
        program,
        "-U",
        "passshare",
    ]);
    if program == "pg_dump" {
        c.args(["-d", "passshare"]);
    }
    c
}

struct ArchiveChild(Child);
impl Drop for ArchiveChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            if !reap_before(&mut self.0, Instant::now() + Duration::from_secs(2)) {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
            }
        }
    }
}

// Binary archives stay in bounded memory, never in logs or report files.
// Pipes are drained concurrently; launch, input, process and drain share a deadline.
fn archive(mut cmd: Command, input: Option<Vec<u8>>) -> Vec<u8> {
    const LIMIT: usize = 64 * 1024 * 1024;
    let operation = if std::path::Path::new(cmd.get_program())
        .file_stem()
        .is_some_and(|n| n == "pg_dump")
        || cmd.get_args().any(|a| a == "pg_dump")
    {
        "dump"
    } else if std::path::Path::new(cmd.get_program())
        .file_stem()
        .is_some_and(|n| n == "pg_restore")
        || cmd.get_args().any(|a| a == "pg_restore")
    {
        "decode"
    } else {
        "apply"
    };
    cmd.env("LANG", "C").env("LC_ALL", "C");
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut child = ArchiveChild(
        cmd.stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("archive client launch"),
    );
    let (send, receive) = std::sync::mpsc::channel();
    let mut workers = Vec::new();
    let mut events = 2;
    if let Some(bytes) = input {
        assert!(bytes.len() <= LIMIT, "archive input bound");
        let mut stdin = child.0.stdin.take().unwrap();
        let send = send.clone();
        events += 1;
        workers.push(thread::spawn(move || {
            let result = stdin.write_all(&bytes);
            drop(stdin);
            let _ = send.send((false, result.map(|_| 0), Vec::new()));
        }));
    }
    for (is_stdout, pipe) in [
        (
            true,
            Box::new(child.0.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (
            false,
            Box::new(child.0.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ),
    ] {
        let send = send.clone();
        workers.push(thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(LIMIT as u64 + 1).read_to_end(&mut bytes);
            let _ = send.send((is_stdout, result, bytes));
        }));
    }
    drop(send);
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("archive wait") {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "archive process deadline exceeded"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let mut stdout = Vec::new();
    let mut io_ok = true;
    let mut category = "other";
    let mut error_words = String::new();
    let mut stderr_bytes = 0;
    for _ in 0..events {
        let (is_stdout, result, bytes) = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("archive drain deadline exceeded");
        io_ok &= result.is_ok() && bytes.len() <= LIMIT;
        if is_stdout {
            stdout = bytes;
        } else if !bytes.is_empty() {
            stderr_bytes = bytes.len();
            // Never log PostgreSQL stderr: it can contain restored row values.
            let diagnostic = String::from_utf8_lossy(&bytes);
            let first_error = diagnostic
                .lines()
                .find(|line| line.contains("error:") || line.contains("ERROR:"))
                .unwrap_or("");
            let vocabulary = [
                "error",
                "option",
                "options",
                "required",
                "database",
                "filename",
                "input",
                "archive",
                "header",
                "invalid",
                "no",
                "output",
                "file",
                "version",
                "could",
                "format",
                "not",
                "supported",
                "unrecognized",
                "does",
                "exist",
                "cannot",
                "clean",
                "transaction",
                "command",
                "encoding",
                "restore",
                "psql",
                "read",
                "permission",
                "denied",
                "syntax",
                "near",
                "single",
                "on_error_stop",
                "configuration",
                "parameter",
                "restricted",
                "set_config",
            ];
            let tokens = first_error
                .split(|c: char| !c.is_ascii_alphabetic() && c != '_')
                .map(str::to_ascii_lowercase)
                .collect::<Vec<_>>();
            error_words = vocabulary
                .iter()
                .filter(|word| tokens.iter().any(|t| t == **word))
                .copied()
                .collect::<Vec<_>>()
                .join(",");
            if diagnostic.contains("schema \"public\" already exists") {
                category = "public_schema_exists";
            } else if diagnostic.contains("schema \"public\" does not exist") {
                category = "public_schema_missing";
            } else if diagnostic.contains("canceling statement due to statement timeout") {
                category = "statement_timeout";
            } else if diagnostic.contains("does not exist") {
                category = if diagnostic.contains("ERROR:  role") {
                    "missing_role"
                } else if diagnostic.contains("ERROR:  relation") {
                    "missing_relation"
                } else if diagnostic.contains("ERROR:  function") {
                    "missing_function"
                } else if diagnostic.contains("ERROR:  type") {
                    "missing_type"
                } else if diagnostic.contains("database") {
                    "missing_database"
                } else {
                    "missing_dependency"
                };
            } else if diagnostic.contains("invalid archive") {
                category = "invalid_archive";
            }
        }
    }
    for worker in workers {
        assert!(worker.join().is_ok(), "archive worker failed");
    }
    assert!(
        status.success(),
        "archive client operation={operation} failed status={:?} stderr_bytes={stderr_bytes} category={category} static_error_categories={error_words} (details suppressed)", status.code()
    );
    assert!(io_ok, "archive I/O failed or exceeded bound");
    stdout
}

struct Backup {
    bytes: Vec<u8>,
    semantic: Value,
    captured: Instant,
}
fn dump(source: &Database, owner: &str) -> Backup {
    println!("encrypted restore phase=dump_source");
    assert!(bound(source, owner, "source"));
    let retained = inventory(source, true);
    let semantic = inventory(source, false);
    let captured = Instant::now();
    let mut cmd = archive_command(source, "pg_dump");
    cmd.args([
        "--format=custom",
        "--schema=public",
        "--no-owner",
        "--no-acl",
    ]);
    let bytes = archive(cmd, None);
    assert!(
        bytes.starts_with(b"PGDMP"),
        "real PostgreSQL custom archive"
    );
    assert!(
        inventory(source, true) == retained,
        "dump preserves every source row/xmin"
    );
    Backup {
        bytes,
        semantic,
        captured,
    }
}

fn restore(db: &Database, owner: &str, backup: &Backup) {
    println!("encrypted restore phase=restore_isolated_target");
    assert!(
        bound(db, owner, "restore"),
        "restore connection ownership/purpose"
    );
    assert_eq!(
        db.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'"),
        "0",
        "restore only into a fresh owned DB"
    );
    let mut cmd = archive_command(db, "pg_restore");
    // Preserve initdb's public schema if pg_dump treats it as pre-existing;
    // clean only archive-listed objects in this verified fresh empty target.
    cmd.args([
        "--file=-",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
    ]);
    let script = archive(cmd, Some(backup.bytes.clone()));
    let script = restore_search_path(script);
    let mut execute = if db.local.is_some() {
        let mut c = db.psql(true, Some("passshare1163-encrypted-restore"));
        c.env(
            "PGOPTIONS",
            "-c statement_timeout=50000 -c lock_timeout=5000",
        );
        c
    } else {
        let mut c = command("docker");
        c.args([
            "exec",
            "-i",
            "--env",
            "PGOPTIONS=-c statement_timeout=50000 -c lock_timeout=5000",
            &db.name,
            "psql",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "passshare",
            "-d",
            "passshare",
        ]);
        c
    };
    execute.args(["--single-transaction", "--file=-"]);
    archive(execute, Some(script));
    assert!(
        inventory(db, false) == backup.semantic,
        "all public tables match semantically"
    );
}

fn restore_search_path(mut script: Vec<u8>) -> Vec<u8> {
    // Native CHECK helpers call other public helpers without qualification.
    // pg_restore's empty session path breaks COPY of nonempty encrypted tables.
    // Change only its generated initialization line BEFORE any restored object
    // or COPY payload, not stored function bodies or caller-controlled values.
    const FROM: &[u8] = b"SELECT pg_catalog.set_config('search_path', '', false);";
    const TO: &[u8] = b"SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', false);";
    let mut offset = 0;
    let mut found = None;
    for line in script.split_inclusive(|b| *b == b'\n') {
        let trimmed = line.strip_suffix(b"\n").unwrap_or(line);
        let trimmed = trimmed.strip_suffix(b"\r").unwrap_or(trimmed);
        if trimmed == FROM {
            found = Some(offset);
            break;
        }
        assert!(
            trimmed.is_empty()
                || trimmed.starts_with(b"--")
                || trimmed.starts_with(b"SET ")
                || trimmed.starts_with(b"\\restrict "),
            "unexpected restore initialization before search path"
        );
        offset += line.len();
    }
    let offset = found.expect("pg_restore initialization search path required");
    script.splice(offset..offset + FROM.len(), TO.iter().copied());
    script
}

fn may_resume(source: &Database, restored: &Database, owner: &str) -> bool {
    bound(source, owner, "source")
        && bound(restored, owner, "restore")
        && source.url() != restored.url()
        && source.sql("SELECT owner_id FROM passshare_fixture_owner") == owner
        && restored.sql("SELECT owner_id FROM passshare_fixture_owner") == owner
        && security_state(source) == security_state(restored)
}

pub fn run(db: &Database, network: &Network, mode: &Mode) {
    let owner = db.local.as_ref().map_or_else(
        || db.sql("SELECT replace(gen_random_uuid()::text,'-','')"),
        |l| l.ownership_id.clone(),
    );
    if db.local.is_none() {
        db.sql(&format!("CREATE TABLE passshare_fixture_owner(owner_id text PRIMARY KEY); INSERT INTO passshare_fixture_owner VALUES('{owner}')"));
    }
    assert!(db.sql("SELECT owner_id FROM passshare_fixture_owner") == owner);
    bind(db, &owner, "source");
    let host = Host::start(db, network, mode);
    let p = host.port;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let a = Account::signup(p);
    let b = Account::signup(p);
    let c = Account::signup(p);
    for account in [&a, &b, &c] {
        account.register(p, &rt);
    }
    let key = checked(PasswordBoxKey::generate(), "fixture box key");
    call(
        p,
        &a,
        "POST",
        &format!("{}/setup", root(&a)),
        &json!({"bundle":owner_bundle(&key,&a.master,a.salt,&owner_context(&a.box_id,&a.id,1))}),
        200,
    );
    for recipient in [&b, &c] {
        accept(p, recipient, &invite(p, &a, recipient));
        call(
            p,
            &a,
            "PUT",
            &format!("{}/grants/{}", root(&a), recipient.id),
            &json!({"expectedStateRevision":snapshot(p,&a)["stateRevision"],"keyEpoch":1,"expectedVersion":0,"envelope":grant(&key,&a,recipient,1)}),
            200,
        );
    }
    let old_b_key = own_grant(&rt, &b.sdk(p), &a, &b, 1);
    let mut items = BTreeMap::new();
    for ordinal in 0..101 {
        let id = ConnectId::generate().unwrap().to_string();
        let value = dto(&a, &id, ordinal, "synthetic-restore-only");
        let sealed = checked(
            key.encrypt_item(&value, &context(&a, &id, 1, 1)),
            "fixture DTO encryption",
        );
        call(
            p,
            &a,
            "PUT",
            &format!("{}/items/{id}", root(&a)),
            &json!({"expectedVersion":0,"envelope":sealed}),
            200,
        );
        items.insert(id, value);
    }
    let tomb_id = ConnectId::generate().unwrap().to_string();
    let tomb_dto = dto(&a, &tomb_id, 103, "synthetic-deleted");
    let tomb = checked(
        key.encrypt_item(&tomb_dto, &context(&a, &tomb_id, 1, 1)),
        "fixture deleted encryption",
    );
    call(
        p,
        &a,
        "PUT",
        &format!("{}/items/{tomb_id}", root(&a)),
        &json!({"expectedVersion":0,"envelope":tomb}),
        200,
    );
    call(
        p,
        &a,
        "DELETE",
        &format!("{}/items/{tomb_id}", root(&a)),
        &json!({"expectedVersion":1,"keyEpoch":1}),
        204,
    );
    let old = dump(db, &owner);
    let new_key = checked(PasswordBoxKey::generate(), "fixture new key");
    let bundle = owner_bundle(
        &new_key,
        &a.master,
        a.salt,
        &owner_context(&a.box_id, &a.id, 2),
    );
    let rotation = Rotation::prepare(db, p, &a, &b, &key, &new_key, &bundle, &items);
    rotation.start(p, &a);
    rotation.stage_items(p, &a, false);
    rotation.stage_grant(p, &a, &c, &grant(&new_key, &a, &c, 2));
    call(
        p,
        &a,
        "POST",
        &format!("{}/commit", rotation.path),
        &json!({"currentPassword":a.login_password}),
        200,
    );
    drop(host); // No source API writes during either restore or verification.
    let source_before = inventory(db, true);
    let latest = dump(db, &owner);
    let stale = target(db, network, &owner);
    restore(&stale, &owner, &old);
    assert_eq!(
        stale.sql(&format!(
            "SELECT count(*) FROM vault_memberships WHERE vault_id='{}' AND user_id='{}'",
            a.box_id, b.id
        )),
        "1",
        "old archive really contains removed member"
    );
    assert!(
        !may_resume(db, &stale, &owner),
        "old backup cannot resume an API with resurrected credentials"
    );
    drop(stale); // No Host has been started for this refused restore.
    let started = Instant::now();
    let restored = target(db, network, &owner);
    restore(&restored, &owner, &latest);
    assert!(
        may_resume(db, &restored, &owner),
        "current revocation/generation authority must match before API startup"
    );
    // Exercise incorrect purpose and owner guards on the isolated target only.
    restored.sql("UPDATE passshare_acceptance_control.binding SET purpose='source'");
    assert!(!may_resume(db, &restored, &owner));
    restored
        .sql("UPDATE passshare_acceptance_control.binding SET purpose='restore',owner_id='wrong'");
    assert!(!may_resume(db, &restored, &owner));
    restored.sql(&format!(
        "UPDATE passshare_acceptance_control.binding SET owner_id='{owner}'"
    ));
    assert!(may_resume(db, &restored, &owner));
    restored.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=3 WHERE box_id='{}'",
        a.box_id
    ));
    assert!(
        !may_resume(db, &restored, &owner),
        "different current generation blocks API startup"
    );
    restored.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{}'",
        a.box_id
    ));
    assert!(may_resume(db, &restored, &owner));
    assert!(
        inventory(&restored, false) == latest.semantic,
        "guard probes preserve restored semantic contents"
    );
    let resumed = Host::start(&restored, network, mode);
    let rp = resumed.port;
    let sdk_a = a.sdk(rp);
    let sdk_c = c.sdk(rp);
    // Reopen private identity keys from RESTORED encrypted account bundles,
    // deriving their master keys again rather than reusing in-memory identities.
    let mut reopened = Vec::new();
    for account in [&a, &c] {
        let identity = checked(
            rt.block_on(
                account
                    .sdk(rp)
                    .get_account_identity(account.identity.context(), &account.pin.key_id),
            ),
            "restored identity GET",
        );
        let salt: [u8; 16] = checked(
            BASE64.decode(&identity.bundle.salt),
            "restored identity salt",
        )
        .try_into()
        .expect("salt size");
        let master = checked(
            owner_master(&account.encryption_password, &salt),
            "restored identity KDF",
        );
        let identity = checked(
            AccountIdentity::unwrap(
                &identity.bundle.wrapped,
                &master,
                account.identity.context(),
                &account.pin.key_id,
            ),
            "restored Core identity unwrap",
        );
        assert!(identity.public_identity() == account.pin);
        reopened.push(identity);
    }
    let fetched_owner = checked(
        rt.block_on(sdk_a.get_owner_key(&a.box_id, &owner_context(&a.box_id, &a.id, 2))),
        "restored owner GET",
    );
    let a_key = checked(
        unwrap_bundle(
            &json!(fetched_owner.bundle),
            &a.encryption_password,
            &owner_context(&a.box_id, &a.id, 2),
        ),
        "restored Core owner unwrap",
    );
    let expectation = passshare_connect::SharedKeyExpectation {
        context: shared_context(&a, &c, 2),
        sender: a.pin.clone(),
        recipient: c.pin.clone(),
    };
    let self_grant = checked(
        rt.block_on(SharingRotationClient::new(&sdk_c).get_self_grant(&a.box_id, &expectation)),
        "restored shared grant GET",
    );
    let c_key = checked(
        PasswordBoxKey::unwrap_for_recipient(
            &self_grant.envelope,
            &reopened[1],
            &a.pin,
            &expectation.context,
        ),
        "restored Core shared unwrap",
    );
    for (id, candidate) in &rotation.candidates {
        let sealed = checked(
            rt.block_on(sdk_c.get_item(&a.box_id, id)),
            "restored item GET",
        );
        let ctx = context(&a, id, candidate.previous + 1, 2);
        assert!(
            checked(a_key.decrypt_item(&sealed, &ctx), "restored owner DTO") == candidate.expected
        );
        assert!(
            checked(
                c_key.decrypt_item(&sealed, &ctx),
                "restored remaining member DTO"
            ) == candidate.expected
        );
        assert!(
            old_b_key.decrypt_item(&sealed, &ctx).is_err(),
            "old member key rejects new generation"
        );
    }
    let id = rotation.candidates.keys().next().unwrap();
    for path in [
        format!("{}/items/{id}", root(&a)),
        format!("{}/grants/me", root(&a)),
    ] {
        call(rp, &b, "GET", &path, &Value::Null, 403);
    }
    let candidate = &rotation.candidates[id];
    let mut denied_dto = candidate.expected.clone();
    denied_dto["version"] = json!(candidate.previous + 2);
    let denied_envelope = checked(
        a_key.encrypt_item(&denied_dto, &context(&a, id, candidate.previous + 2, 2)),
        "well-formed removed member write probe",
    );
    rejected(
        &restored,
        rp,
        &b,
        "PUT",
        &format!("{}/items/{id}", root(&a)),
        &json!({"expectedVersion":candidate.previous+1,"envelope":denied_envelope}),
        403,
    );
    call(
        rp,
        &a,
        "GET",
        &format!("{}/items/{tomb_id}", root(&a)),
        &Value::Null,
        404,
    );
    let replay = checked(
        a_key.encrypt_item(&tomb_dto, &context(&a, &tomb_id, 1, 2)),
        "restored tombstone replay encrypt",
    );
    rejected(
        &restored,
        rp,
        &a,
        "PUT",
        &format!("{}/items/{tomb_id}", root(&a)),
        &json!({"expectedVersion":0,"envelope":replay}),
        409,
    );
    assert!(
        inventory(db, true) == source_before,
        "restore and API verification preserve every source table row/xmin"
    );
    let rto_ms = started.elapsed().as_millis();
    let backup_age_ms = latest.captured.elapsed().as_millis();
    println!("encrypted restore fixture: live_items=101 grants=1 identities=3 tombstones=1; all public tables semantic equality; owner/member Core full DTO decrypt; old token/key denied; stale backup/purpose/owner refused; source full rows/xmin unchanged; fixture_only_rto_ms={rto_ms} fixture_backup_age_ms={backup_age_ms} fixture_rpo_lost_committed_rows=0 (not production measurements)");
    drop(resumed);
    drop(restored);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_initialization_changes_only_header_never_copy_or_function_payload() {
        let header = "SELECT pg_catalog.set_config('search_path', '', false);";
        let payload = format!("CREATE FUNCTION public.synthetic() RETURNS text LANGUAGE sql AS $$ SELECT '{header}'; $$;\nCOPY public.synthetic FROM stdin;\n{header}\n\\.\n");
        let script = format!("-- PostgreSQL database dump\n\\restrict synthetic\nSET client_encoding = 'UTF8';\n{header}\n{payload}");
        let restored = String::from_utf8(restore_search_path(script.into_bytes())).unwrap();
        assert!(restored.ends_with(&payload));
        assert!(restored.contains("SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', false);\nCREATE FUNCTION"));
    }
    #[test]
    fn unexpected_header_cannot_move_search_path_rewrite_into_stored_payload() {
        for script in ["CREATE TABLE public.synthetic(id text);\nSELECT pg_catalog.set_config('search_path', '', false);\n", "-- no initialization\nCOPY public.synthetic FROM stdin;\nSELECT pg_catalog.set_config('search_path', '', false);\n\\.\n"] {
            assert!(std::panic::catch_unwind(|| restore_search_path(script.as_bytes().to_vec())).is_err());
        }
    }
    #[test]
    fn explicit_restore_preserves_formal_image_and_node_modes() {
        for tail in [vec!["native"], vec!["--image", "owned-image"]] {
            let args = std::iter::once("--encrypted-restore")
                .chain(tail)
                .map(OsString::from)
                .collect::<Vec<_>>();
            let (enabled, rest) = prefix(&args).unwrap();
            assert!(enabled && Mode::parse(rest).is_ok());
        }
        for args in [
            vec!["native", "--encrypted-restore"],
            vec!["--encrypted-restore", "--sharing-rotation", "native"],
            vec!["--encrypted-restore", "--go-session", "unused", "native"],
            vec!["--encrypted-restore", "--encrypted-restore", "native"],
        ] {
            assert!(prefix(&args.into_iter().map(OsString::from).collect::<Vec<_>>()).is_err());
        }
        assert!(Mode::parse(prefix(&["--encrypted-restore".into()]).unwrap().1).is_err());
    }
}
