use super::share_acceptance::{sql, uuid, Gate};
use super::{http, http_raw};
use serde_json::{json, Value};
use std::{thread, time::Duration};

fn token(port: u16, session: &str) -> String {
    let (status, response) = http(
        port,
        "GET",
        "/api/auth/connect-token",
        session,
        "",
        &Value::Null,
    );
    assert_eq!(status, 200);
    response["accessToken"].as_str().unwrap().to_owned()
}
pub fn run(port: u16, nonce: u128) {
    let email = format!("retire-{nonce}@example.test");
    let password = format!("Synthetic-Retire-{nonce}!");
    let (status, actor) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":email,"password":password}),
    );
    assert_eq!(status, 201);
    let peer_email = format!("retire-peer-{nonce}@example.test");
    let (status, peer) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":peer_email,"password":format!("Synthetic-Peer-{nonce}!")}),
    );
    assert_eq!(status, 201);
    let actor_session = actor["refreshToken"].as_str().unwrap();
    let access = actor["connectAccessToken"].as_str().unwrap();
    let peer_session = peer["refreshToken"].as_str().unwrap();
    let (status, boxes) = http(port, "GET", "/v1/vaults", access, "", &Value::Null);
    assert_eq!(status, 200);
    let shared = boxes[0]["id"].as_str().unwrap();
    let items = format!("/v1/vaults/{shared}/items");
    let (status, item) = http(
        port,
        "POST",
        &items,
        access,
        "retire-shared-item-1",
        &json!({"title":"Synthetic shared retained item","category":"LOGIN","fields":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","type":"CONCEALED","label":"password","value":format!("Synthetic-Retire-Field-{nonce}")}],"customMetadata":{"retain":true}}),
    );
    assert_eq!(status, 201);
    let detail = format!("{items}/{}", item["id"].as_str().unwrap());
    let (status, before) = http(port, "GET", &detail, access, "", &Value::Null);
    assert_eq!(status, 200);
    let (status, private_box) = http(
        port,
        "POST",
        "/api/auth/vaults",
        actor_session,
        "retire-private-box-1",
        &json!({"name":"Synthetic private box"}),
    );
    assert_eq!(status, 201);
    let private_id = private_box["vaultId"].as_str().unwrap();
    let access = token(port, actor_session);
    let (status, private_item) = http(
        port,
        "POST",
        &format!("/v1/vaults/{private_id}/items"),
        &access,
        "retire-private-item-1",
        &json!({"title":"Synthetic private deleted item","category":"LOGIN","fields":[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","type":"STRING","value":"synthetic-private"}]}),
    );
    assert_eq!(status, 201);
    let invitations = format!("/api/auth/vaults/{shared}/invitations");
    let (status, invite) = http(
        port,
        "POST",
        &invitations,
        actor_session,
        "",
        &json!({"email":peer_email}),
    );
    assert_eq!(status, 201);
    let (status, _) = http(
        port,
        "POST",
        &format!(
            "/api/auth/invitations/{}/accept",
            invite["id"].as_str().unwrap()
        ),
        peer_session,
        "",
        &json!({"confirmationCode":invite["confirmationCode"]}),
    );
    assert_eq!(status, 200);
    let deletion = json!({"currentPassword":password,"confirmationEmail":email});
    assert_eq!(
        http(port, "DELETE", "/api/auth/account", "", "", &deletion).0,
        401
    );
    assert_eq!(
        http_raw(port, "DELETE", "/api/auth/account", "", &deletion).0,
        401
    );
    assert_eq!(
        http(
            port,
            "DELETE",
            "/api/auth/account",
            actor_session,
            "",
            &json!({"currentPassword":format!("Wrong-Synthetic-{nonce}"),"confirmationEmail":email})
        )
        .0,
        401
    );
    assert_eq!(
        http(
            port,
            "DELETE",
            "/api/auth/account",
            actor_session,
            "",
            &json!({"currentPassword":password,"confirmationEmail":"other@example.test"})
        )
        .0,
        400
    );
    assert_eq!(
        http(
            port,
            "DELETE",
            "/api/auth/account",
            actor_session,
            "",
            &deletion
        )
        .0,
        409,
        "last owner must transfer shared box first"
    );
    assert_eq!(
        http(port, "GET", &detail, &access, "", &Value::Null).1,
        before,
        "blocked deletion leaves entire shared item intact"
    );
    let ownership = format!("/api/auth/vaults/{shared}/ownership");
    assert_eq!(
        http(
            port,
            "POST",
            &ownership,
            actor_session,
            "",
            &json!({"currentPassword":password,"targetUserId":actor["user"]["id"]})
        )
        .0,
        400
    );
    let id = uuid(&actor["user"]["id"]);
    let nonexistent = format!(
        "{}{}",
        if id.starts_with('a') { 'b' } else { 'a' },
        &id[1..]
    );
    assert_eq!(
        http(
            port,
            "POST",
            &ownership,
            actor_session,
            "",
            &json!({"currentPassword":password,"targetUserId":nonexistent})
        )
        .0,
        409
    );
    assert_eq!(
        http(
            port,
            "POST",
            &ownership,
            actor_session,
            "",
            &json!({"currentPassword":password,"targetUserId":peer["user"]["id"]})
        )
        .0,
        204
    );
    let peer_access = token(port, peer_session);
    assert_eq!(
        http(port, "GET", &detail, &peer_access, "", &Value::Null).1,
        before
    );
    if std::env::var_os("DATABASE_URL").is_some() {
        let id = uuid(&actor["user"]["id"]);
        let name = format!("retire_failure_{nonce}");
        sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic retirement commit failure'; END $$; CREATE TRIGGER {name} BEFORE DELETE ON users FOR EACH ROW WHEN(OLD.id='{id}') EXECUTE FUNCTION {name}();"));
        assert_eq!(
            http(
                port,
                "DELETE",
                "/api/auth/account",
                actor_session,
                "",
                &deletion
            )
            .0,
            500,
            "commit failure rolls back all private deletion"
        );
        sql(&format!(
            "DROP TRIGGER {name} ON users; DROP FUNCTION {name}();"
        ));
        assert_eq!(
            http(port, "GET", "/api/auth/me", actor_session, "", &Value::Null).0,
            200
        );
        assert_eq!(
            sql(&format!(
                "SELECT count(*) FROM connect_items WHERE vault_id='{private_id}'"
            )),
            "1"
        );
    }
    let mut gate = None;
    let mut trigger_name = None;
    if std::env::var_os("DATABASE_URL").is_some() {
        let id = uuid(&actor["user"]["id"]);
        let name = format!("retire_gate_{nonce}");
        let key = 10_000_000 + (nonce % 1_000_000) as u32;
        sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock({key}); RETURN OLD; END $$; CREATE TRIGGER {name} BEFORE DELETE ON users FOR EACH ROW WHEN(OLD.id='{id}') EXECUTE FUNCTION {name}();"));
        gate = Some((Gate::hold(key), key));
        trigger_name = Some(name);
    }
    let body = deletion.clone();
    let session = actor_session.to_owned();
    let retire =
        thread::spawn(move || http(port, "DELETE", "/api/auth/account", &session, "", &body).0);
    if let Some((_, key)) = &gate {
        let mut pid = None;
        for _ in 0..100 {
            if let Ok(value)=sql(&format!("SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid={key} AND NOT granted")).parse::<u32>(){pid=Some(value);break}
            thread::sleep(Duration::from_millis(20));
        }
        let pid = pid.expect("retirement holds user lock until explicit release");
        let old_email = email.clone();
        let old_password = password.clone();
        let login = thread::spawn(move || {
            http(
                port,
                "POST",
                "/api/auth/login",
                "",
                "",
                &json!({"email":old_email,"password":old_password}),
            )
            .0
        });
        let session = actor_session.to_owned();
        let mint = thread::spawn(move || {
            http(
                port,
                "GET",
                "/api/auth/connect-token",
                &session,
                "",
                &Value::Null,
            )
            .0
        });
        let mut blocked = false;
        for _ in 0..100 {
            if sql(&format!("SELECT count(*) FROM pg_stat_activity WHERE {pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%users%'")).parse::<u32>().unwrap()>=2{blocked=true;break}
            thread::sleep(Duration::from_millis(20));
        }
        assert!(blocked, "old login and mint actually overlap retirement");
        gate.as_mut().unwrap().0.release();
        assert_eq!(login.join().unwrap(), 401);
        assert_eq!(mint.join().unwrap(), 401);
    }
    assert_eq!(retire.join().unwrap(), 204);
    if let Some(name) = trigger_name {
        sql(&format!(
            "DROP TRIGGER {name} ON users; DROP FUNCTION {name}();"
        ));
    }
    assert_eq!(
        http(port, "GET", "/api/auth/me", actor_session, "", &Value::Null).0,
        401
    );
    assert_eq!(
        http(port, "GET", "/v1/vaults", &access, "", &Value::Null).0,
        401
    );
    assert_eq!(
        http(
            port,
            "POST",
            "/api/auth/token/refresh",
            "",
            "",
            &json!({"refreshToken":actor_session})
        )
        .0,
        401
    );
    assert_eq!(
        http(port, "GET", &detail, &peer_access, "", &Value::Null).1,
        before,
        "shared owner's full saved item remains intact"
    );
    let (status, members) = http(
        port,
        "GET",
        &format!("/api/auth/vaults/{shared}/members"),
        peer_session,
        "",
        &Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(members["members"].as_array().unwrap().len(), 1);
    assert_eq!(members["members"][0]["userId"], peer["user"]["id"]);
    assert_eq!(members["members"][0]["role"], "owner");
    if std::env::var_os("DATABASE_URL").is_some() {
        let id = uuid(&actor["user"]["id"]);
        for table in ["users", "sessions", "connect_tokens", "vault_memberships"] {
            let column = if table == "users" { "id" } else { "user_id" };
            assert_eq!(
                sql(&format!(
                    "SELECT count(*) FROM {table} WHERE {column}='{id}'"
                )),
                "0"
            );
        }
        assert_eq!(
            sql(&format!(
                "SELECT count(*) FROM connect_vaults WHERE id='{private_id}'"
            )),
            "0"
        );
        assert_eq!(
            sql(&format!(
                "SELECT count(*) FROM connect_items WHERE id='{}'",
                private_item["id"].as_str().unwrap()
            )),
            "0"
        );
        assert_eq!(
            sql(&format!(
                "SELECT count(*) FROM mutation_operations WHERE actor='{id}'"
            )),
            "0"
        );
    }
    let (status, replacement) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":email,"password":format!("Synthetic-Replacement-{nonce}!")}),
    );
    assert_eq!(status, 201);
    assert_ne!(replacement["user"]["id"], actor["user"]["id"]);
    assert_eq!(
        http(
            port,
            "GET",
            &detail,
            replacement["connectAccessToken"].as_str().unwrap(),
            "",
            &Value::Null
        )
        .0,
        403,
        "same email registration cannot reclaim former shared membership"
    );
    println!("retirement acceptance passed: reauthentication, sole-owner refusal, confirmed ownership transfer, private deletion, shared item retained, old credentials revoked, no membership reclamation");
}
