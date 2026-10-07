use super::{http, http_bytes};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

pub(super) fn sql(statement: &str) -> String {
    // This fixture operates only on the CI service database. It never discovers
    // a production connection or executes SQL against arbitrary DATABASE_URLs.
    let database = std::env::var("DATABASE_URL").unwrap();
    assert_eq!(
        database,
        "postgresql://passshare:passshare@127.0.0.1:5432/passshare"
    );
    let result = Command::new("psql")
        .args([
            "-X",
            "-qAt",
            "--set",
            "ON_ERROR_STOP=1",
            "--dbname",
            &database,
            "--command",
            statement,
        ])
        .stdin(Stdio::null())
        .output()
        .expect("synthetic PostgreSQL client");
    assert!(result.status.success(), "synthetic SQL fixture failed");
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

pub(super) fn uuid(value: &Value) -> &str {
    let id = value.as_str().unwrap();
    assert!(id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
    id
}

pub(super) struct Gate {
    child: Child,
}
impl Gate {
    pub(super) fn hold(key: u32) -> Self {
        let database = std::env::var("DATABASE_URL").unwrap();
        let child = Command::new("psql")
            .args([
                "-X",
                "-qAt",
                "--set",
                "ON_ERROR_STOP=1",
                "--dbname",
                &database,
            ])
            .env(
                "PGOPTIONS",
                "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=20000",
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("synthetic lock gate");
        let mut gate = Self { child };
        writeln!(
            gate.child.stdin.as_mut().unwrap(),
            "BEGIN; SELECT pg_advisory_xact_lock({key}); SELECT 'locked';"
        )
        .unwrap();
        gate.child.stdin.as_mut().unwrap().flush().unwrap();
        let mut output = BufReader::new(gate.child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "lock gate ended without owning lock"
            );
            if line.trim() == "locked" {
                break;
            }
        }
        gate
    }
    pub(super) fn release(&mut self) {
        writeln!(self.child.stdin.as_mut().unwrap(), "COMMIT;").unwrap();
        drop(self.child.stdin.take());
        assert!(self.child.wait().unwrap().success(), "release lock gate");
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Pause(String);
impl Drop for Pause {
    fn drop(&mut self) {
        sql(&format!(
            "DROP TRIGGER IF EXISTS {} ON vault_invitations; DROP FUNCTION IF EXISTS {}();",
            self.0, self.0
        ));
    }
}

fn response_races(
    port: u16,
    nonce: u128,
    owner: &str,
    member: &str,
    email: &str,
    invitations: &str,
    scope: (&str, &str),
) {
    let (box_id, user_id) = scope;
    for (index, first) in ["revoked", "accepted"].into_iter().enumerate() {
        let (status, invite) = http(
            port,
            "POST",
            invitations,
            owner,
            "",
            &json!({"email":email}),
        );
        assert_eq!(status, 201);
        let id = uuid(&invite["id"]);
        let name = format!("acceptance_pause_{nonce}_{index}");
        let key = 6_000_000 + (nonce % 1_000_000) as u32 + index as u32;
        sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock({key}); RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE UPDATE ON vault_invitations FOR EACH ROW WHEN (NEW.id = '{id}' AND NEW.status = '{first}') EXECUTE FUNCTION {name}();"));
        let pause = Pause(name);
        let mut gate = Gate::hold(key);
        let revoke_path = format!("{invitations}/{id}");
        let accept_path = format!("/api/auth/invitations/{id}/accept");
        let proof = json!({"confirmationCode":invite["confirmationCode"]});
        let (first_method, first_path, first_token, first_body) = if first == "revoked" {
            ("DELETE", revoke_path.clone(), owner.to_owned(), Value::Null)
        } else {
            (
                "POST",
                accept_path.clone(),
                member.to_owned(),
                proof.clone(),
            )
        };
        let worker = thread::spawn(move || {
            http(
                port,
                first_method,
                &first_path,
                &first_token,
                "",
                &first_body,
            )
            .0
        });
        let mut first_pid = None;
        for _ in 0..30 {
            let pid = sql(&format!("SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE l.locktype='advisory' AND l.objid={key} AND NOT l.granted AND a.query LIKE '%vault_invitations%'"));
            if let Ok(pid) = pid.parse::<u32>() {
                first_pid = Some(pid);
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let first_pid = first_pid.expect("first response owns row lock and waits on gate");
        let (method, second_path, second_token, second_body) = if first == "revoked" {
            ("POST", accept_path, member.to_owned(), proof)
        } else {
            ("DELETE", revoke_path, owner.to_owned(), Value::Null)
        };
        let second = thread::spawn(move || {
            http(port, method, &second_path, &second_token, "", &second_body).0
        });
        let mut blocked = false;
        for _ in 0..30 {
            if sql(&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE {first_pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%vault_invitations%')")) == "t" {
                blocked = true; break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            blocked,
            "second request is blocked by the first response transaction"
        );
        gate.release();
        let second_status = second.join().unwrap();
        let first_status = worker.join().unwrap();
        assert_eq!(first_status, if first == "revoked" { 204 } else { 200 });
        assert_eq!(second_status, 404, "only first response commits");
        assert_eq!(
            sql(&format!(
                "SELECT status FROM vault_invitations WHERE id='{id}'"
            )),
            first
        );
        assert_eq!(sql(&format!("SELECT count(*) FROM vault_memberships WHERE user_id='{user_id}' AND vault_id='{box_id}'")), if first == "revoked" { "0" } else { "1" });
        drop(pause);
    }
}

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
    let content_path = format!("{file_path}/content");
    let (status, content) = http_bytes(port, "GET", &content_path, access, "", &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(content, vec![0, 1, 254, 255], "actual attachment bytes");
    let detail_path = format!("{items}/{item}");
    let (status, stored_detail) = http(port, "GET", &detail_path, access, "", &Value::Null);
    assert_eq!(status, 200);
    assert!(
        stored_detail["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field["value"] == "synthetic-number"),
        "shared detail includes the persisted concealed field"
    );
    let user_id = uuid(&member["user"]["id"]);
    if std::env::var_os("DATABASE_URL").is_some() {
        sql(&format!("UPDATE vault_memberships SET confirmed_at=NULL WHERE user_id='{user_id}' AND vault_id='{box_id}'"));
        sql(passshare_mutations::share::MEMBERSHIP_SCHEMA);
        assert_eq!(
            http(port, "GET", items, access, "", &Value::Null).0,
            403,
            "legacy membership is not proof of identity"
        );
        let (status, limited) = http(
            port,
            "GET",
            "/api/auth/connect-token",
            session,
            "",
            &Value::Null,
        );
        assert_eq!(status, 200);
        let limited_access = limited["accessToken"].as_str().unwrap();
        let token_hash = format!("{:x}", Sha256::digest(limited_access.as_bytes()));
        assert_eq!(sql(&format!("SELECT NOT(vault_ids ? '{box_id}') FROM connect_tokens WHERE token_hash='{token_hash}'")),"t","issued scope excludes the unconfirmed box");
        assert_eq!(
            http(port, "GET", items, limited_access, "", &Value::Null).0,
            403,
            "new token excludes unconfirmed shared box"
        );
        assert_eq!(
            http(
                port,
                "GET",
                &format!("/api/auth/vaults/{box_id}/members"),
                session,
                "",
                &Value::Null
            )
            .0,
            403
        );
        let (status, owner_token) = http(
            port,
            "GET",
            "/api/auth/connect-token",
            owner,
            "",
            &Value::Null,
        );
        assert_eq!(status, 200);
        let owner_access = owner_token["accessToken"].as_str().unwrap();
        let (status, before_denied) = http(port, "GET", items, owner_access, "", &Value::Null);
        assert_eq!(status, 200);
        assert_eq!(
            http(
                port,
                "POST",
                items,
                access,
                "unconfirmed-operation-0001",
                &json!({"title":"Must not be saved","category":"LOGIN"})
            )
            .0,
            403
        );
        let (status, kept) = http(
            port,
            "GET",
            items,
            owner_token["accessToken"].as_str().unwrap(),
            "",
            &Value::Null,
        );
        assert_eq!(status, 200);
        assert_eq!(
            kept, before_denied,
            "denied save leaves the item overviews unchanged"
        );
        let (status, kept_detail) = http(port, "GET", &detail_path, owner_access, "", &Value::Null);
        assert_eq!(status, 200);
        assert!(
            kept_detail == stored_detail,
            "denied save preserves the complete stored item"
        );
        assert_eq!(
            http(port, "GET", &content_path, access, "", &Value::Null).0,
            403
        );
        let (status, expired) = http(
            port,
            "POST",
            &invitations,
            owner,
            "",
            &json!({"email":email}),
        );
        assert_eq!(
            status, 201,
            "owner can reverify an existing unconfirmed member without deleting data"
        );
        let expired_id = uuid(&expired["id"]);
        sql(&format!("UPDATE vault_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE id='{expired_id}'"));
        let (status, again) = http(
            port,
            "POST",
            &invitations,
            owner,
            "",
            &json!({"email":email}),
        );
        assert_eq!(
            status, 201,
            "expired pending invite cannot block reconfirmation"
        );
        assert_eq!(
            http(
                port,
                "POST",
                &format!("/api/auth/invitations/{expired_id}/accept"),
                session,
                "",
                &json!({"confirmationCode":expired["confirmationCode"]})
            )
            .0,
            404
        );
        let confirm = format!(
            "/api/auth/invitations/{}/accept",
            again["id"].as_str().unwrap()
        );
        assert_eq!(http(port, "POST", &confirm, session, "", &json!({})).0, 403);
        assert_eq!(
            http(
                port,
                "POST",
                &confirm,
                session,
                "",
                &json!({"confirmationCode":again["confirmationCode"]})
            )
            .0,
            200
        );
        assert_eq!(
            http(port, "GET", items, access, "", &Value::Null).0,
            200,
            "confirmed member resumes the same box"
        );
        let (status, recovered_detail) = http(port, "GET", &detail_path, access, "", &Value::Null);
        assert_eq!(status, 200);
        assert!(
            recovered_detail == stored_detail,
            "identity reconfirmation preserves all item fields and metadata"
        );
        assert_eq!(
            http_bytes(port, "GET", &content_path, access, "", &Value::Null).1,
            vec![0, 1, 254, 255],
            "existing attachment data is retained"
        );
        sql(&format!(
            "DELETE FROM vault_memberships WHERE user_id='{user_id}' AND vault_id='{box_id}'"
        ));
        assert_eq!(
            http(port, "GET", items, access, "", &Value::Null).0,
            403,
            "valid snapshot token loses current membership"
        );
        assert_eq!(
            http(port, "GET", &content_path, access, "", &Value::Null).0,
            403
        );
        sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{user_id}','{box_id}','member')"));
    }
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
    assert_eq!(
        http(port, "GET", &content_path, access, "", &Value::Null).0,
        401
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
    assert_eq!(
        http(port, "GET", &content_path, fresh, "", &Value::Null).0,
        403
    );
    if std::env::var_os("DATABASE_URL").is_some() {
        let late = format!("synthetic-late-{nonce}");
        let hash = format!("{:x}", Sha256::digest(late.as_bytes()));
        // Model a token insert which used a pre-removal snapshot but completed
        // after DELETE connect_tokens. It is valid; the live guard must deny it.
        sql(&format!("INSERT INTO connect_tokens(id,user_id,token_hash,vault_ids,expires_at) VALUES('{user_id}','{user_id}','{hash}','[\"{box_id}\"]'::jsonb, NOW()+INTERVAL '1 hour')"));
        assert_eq!(
            http(port, "GET", items, &late, "", &Value::Null).0,
            403,
            "late snapshot token cannot grant removed access"
        );
        assert_eq!(
            http(port, "GET", &content_path, &late, "", &Value::Null).0,
            403
        );
    }
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
    if std::env::var_os("DATABASE_URL").is_some() {
        response_races(
            port,
            nonce,
            owner,
            session,
            &email,
            &invitations,
            (box_id, user_id),
        );
    }
}
