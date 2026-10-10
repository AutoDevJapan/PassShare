//! Isolated account-identity formal API fixture. NOT RUN by implementation job.
//! Core is a client fixture dependency only; production native has no Core.
use super::*;
use passshare_core::cloud_crypto::{
    AccountIdentity, AccountIdentityContext, WrappedAccountIdentity,
};

const SELF_PATH: &str = "/api/encrypted/account-identity";

struct Account {
    session: String,
    connect: String,
    box_id: String,
    password: String,
    id: String,
    email: String,
}
impl Account {
    fn signup(p: u16) -> Self {
        let (session, connect, box_id, password) = signup_with_password(p);
        let headers = format!("Authorization: Bearer {session}\r\n");
        let (status, me) = http(p, "GET", "/api/auth/me", &headers, &Value::Null);
        assert_eq!(status, 200, "formal account self lookup");
        Self {
            session,
            connect,
            box_id,
            password,
            id: me["user"]["id"].as_str().unwrap().to_owned(),
            email: me["user"]["email"].as_str().unwrap().to_owned(),
        }
    }
    fn headers(&self) -> String {
        format!("Authorization: Bearer {}\r\n", self.session)
    }
    fn context(&self) -> AccountIdentityContext {
        serde_json::from_value(json!({"accountId":self.id,"identityVersion":1})).unwrap()
    }
}

fn bundle(identity: &AccountIdentity, root: &MasterKey, salt: [u8; 16]) -> Value {
    json!({"format":1,"salt":BASE64.encode(salt),"wrapped":identity.wrap(root).unwrap()})
}
fn request(identity: &Value, bundle: &Value, version: u64, password: Option<&str>) -> Value {
    let mut body = json!({"expectedVersion":version,"identity":identity,"bundle":bundle});
    if let Some(password) = password {
        body["currentPassword"] = json!(password);
    }
    body
}
fn row(db: &Database, account: &Account) -> String {
    // Hash the FULL stored row including time and xmin; no credential data is
    // returned or logged, and failed/replayed requests cannot hide rewrites.
    db.sql(&format!("SELECT COALESCE(md5(jsonb_build_object('row',to_jsonb(i),'xmin',i.xmin::text)::text),'missing') FROM encrypted_account_identities i WHERE account_id='{}'", account.id))
}
fn rejected(db: &Database, p: u16, account: &Account, headers: &str, body: &Value, status: u16) {
    let before = row(db, account);
    assert_eq!(
        http(p, "PUT", SELF_PATH, headers, body).0,
        status,
        "rejection status"
    );
    assert_eq!(
        row(db, account),
        before,
        "rejection preserves full stored row"
    );
}
fn read(p: u16, account: &Account) -> Value {
    let (status, body) = http(p, "GET", SELF_PATH, &account.headers(), &Value::Null);
    assert_eq!(status, 200, "formal identity self read");
    assert_eq!(body.as_object().unwrap().len(), 3);
    body
}
fn roundtrip(readback: &Value, root: &MasterKey, context: &AccountIdentityContext, public: &Value) {
    let wrapped: WrappedAccountIdentity =
        serde_json::from_value(readback["bundle"]["wrapped"].clone()).unwrap();
    let restored =
        AccountIdentity::unwrap(&wrapped, root, context, public["keyId"].as_str().unwrap()).expect(
            "Core must unwrap using original independently retained root/context/fingerprint",
        );
    assert_eq!(
        serde_json::to_value(restored.public_identity()).unwrap(),
        *public
    );
    assert_eq!(readback["identity"], *public);
}

fn db_shape_boundary(db: &Database, account: &Account, valid: &Value) {
    let before = row(db, account);
    let mut cases = Vec::new();
    for pointer in [
        "/identity/accountId",
        "/identity/keyId",
        "/identity/publicKey",
        "/bundle/salt",
        "/bundle/wrapped/nonce",
        "/bundle/wrapped/ciphertext",
        "/bundle/wrapped/context/accountId",
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(pointer).unwrap() = Value::Null;
        cases.push(bad);
    }
    for pointer in [
        "/identity",
        "/bundle",
        "/bundle/wrapped",
        "/bundle/wrapped/context",
    ] {
        let mut bad = valid.clone();
        bad.pointer_mut(pointer).unwrap()["plaintext"] = json!("synthetic-database-forbidden");
        cases.push(bad);
    }
    let mut bad = valid.clone();
    bad["bundle"]["salt"] = json!("AAAAAAAAAAAAAAAAAAAAAB==");
    cases.push(bad);
    for pointer in [
        "/identity",
        "/bundle",
        "/bundle/wrapped",
        "/bundle/wrapped/context",
    ] {
        let mut bad = valid.clone();
        let object = bad.pointer_mut(pointer).unwrap().as_object_mut().unwrap();
        let key = object.keys().next().unwrap().clone();
        object.remove(&key);
        cases.push(bad);
    }
    for pointer in [
        "/identity/identityVersion",
        "/bundle/format",
        "/bundle/wrapped/format",
        "/bundle/wrapped/context/identityVersion",
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(pointer).unwrap() = json!("1");
        cases.push(bad);
    }
    let mut bad = valid.clone();
    bad["identity"]["keyId"] = json!("0".repeat(64));
    cases.push(bad);
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    let mut high = [0u8; 32];
    high[31] = 0x80;
    for point in [p, high] {
        let mut bad = valid.clone();
        let public_key = BASE64.encode(point);
        bad["identity"]["publicKey"] = json!(public_key);
        bad["identity"]["keyId"] = json!(db.sql(&format!(
            "SELECT encode(sha256(decode('{public_key}','base64')),'hex')"
        )));
        cases.push(bad);
    }
    for bad in cases {
        // An actual UPDATE of an existing valid row must reach CHECK 23514.
        // The exception block rolls back just this attempted write; a missing
        // row, FK error or unexpected success cannot satisfy this assertion.
        let identity = bad["identity"].to_string().replace('\'', "''");
        let bundle = bad["bundle"].to_string().replace('\'', "''");
        db.sql(&format!("DO $$ BEGIN BEGIN UPDATE encrypted_account_identities SET identity='{identity}'::jsonb,bundle='{bundle}'::jsonb WHERE account_id='{}'; IF NOT FOUND THEN RAISE EXCEPTION 'fixture row missing'; END IF; RAISE EXCEPTION 'invalid JSON unexpectedly persisted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;",account.id));
        assert_eq!(
            row(db, account),
            before,
            "CHECK rejection retains the complete original row"
        );
    }
}
fn peer(p: u16, caller: &Account, box_id: &str, target: &Account) -> (u16, Value) {
    http(
        p,
        "GET",
        &format!(
            "/api/encrypted/boxes/{box_id}/member-identities/{}",
            target.id
        ),
        &caller.headers(),
        &Value::Null,
    )
}
fn invite_and_confirm(p: u16, owner: &Account, target: &Account) {
    let path = format!("/api/auth/vaults/{}/invitations", owner.box_id);
    let (status, invitation) = http(
        p,
        "POST",
        &path,
        &owner.headers(),
        &json!({"email":target.email,"role":"member"}),
    );
    assert_eq!(status, 201, "formal invitation creation");
    let path = format!(
        "/api/auth/invitations/{}/accept",
        invitation["id"].as_str().unwrap()
    );
    // Owner-obtained confirmation proof, delivered inside this synthetic client
    // fixture. This base's accept API performs the confirmation atomically.
    assert_eq!(
        http(
            p,
            "POST",
            &path,
            &target.headers(),
            &json!({"confirmationCode":invitation["confirmationCode"]})
        )
        .0,
        200,
        "formal proof-confirmed acceptance"
    );
}

pub(super) fn run(db: &Database, network: &Network, mode: &Mode) {
    let mut host = Host::start(db, network, mode);
    let p = host.port;
    // Exactly three registrations on a fresh database/network. Never enter the
    // default legacy fixture or consume its five-registration signup budget.
    let a = Account::signup(p);
    let b = Account::signup(p);
    let c = Account::signup(p);
    let (status, missing) = http(p, "GET", SELF_PATH, &a.headers(), &Value::Null);
    assert_eq!(status, 404);
    assert_eq!(
        missing["error"], "PS012",
        "unmounted route must not masquerade as missing identity"
    );

    let context = a.context();
    let identity = AccountIdentity::generate(context.clone()).unwrap();
    let public = serde_json::to_value(identity.public_identity()).unwrap();
    // Deliberately independent of the account login credential.
    let encryption_password = BASE64.encode(generate_salt().unwrap());
    assert_ne!(encryption_password, a.password);
    let salt = generate_salt().unwrap();
    let master = owner_master(&encryption_password, &salt).unwrap();
    let sealed = bundle(&identity, &master, salt);
    let initial = request(&public, &sealed, 0, None);
    let native = |body: &Value| {
        passshare_mutations::dispatch(&json!({"command":"account-identity-plan",
        "operation":"put","actor":a.id,"session":"11111111-1111-4111-8111-111111111111","request":body}))
    };
    assert_eq!(
        native(&initial)["status"],
        200,
        "Core DTO positive native control"
    );

    // Bootstrap authentication and cookie CSRF, with a valid lower-level body.
    rejected(db, p, &a, "", &initial, 401);
    rejected(
        db,
        p,
        &a,
        &format!("Authorization: Bearer {}\r\n", a.connect),
        &initial,
        401,
    );
    for client in [
        "",
        "x-passshare-client: mobile\r\n",
        "x-passshare-client: extension\r\n",
    ] {
        rejected(
            db,
            p,
            &a,
            &format!("Cookie: passshare_session={}\r\n{client}", a.session),
            &initial,
            403,
        );
    }
    let csrf = http(p, "GET", "/api/auth/csrf", "", &Value::Null).1["csrfToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let cookies = format!(
        "Cookie: passshare_session={}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n",
        a.session
    );
    assert_eq!(
        http(p, "PUT", SELF_PATH, &cookies, &initial).0,
        200,
        "cookie CSRF positive control"
    );
    let first = read(p, &a);
    assert_eq!(
        first,
        json!({"bundleVersion":1,"identity":public,"bundle":sealed})
    );
    roundtrip(&first, &master, &context, &public);
    db_shape_boundary(db, &a, &initial);
    let before = row(db, &a);
    assert_eq!(http(p, "PUT", SELF_PATH, &a.headers(), &initial).0, 200);
    assert_eq!(
        row(db, &a),
        before,
        "exact bootstrap replay must not touch xmin/time/full row"
    );
    let alternate_initial = request(&public, &bundle(&identity, &master, salt), 0, None);
    rejected(db, p, &a, &a.headers(), &alternate_initial, 409);

    // Every shape negative begins from a genuine Core envelope that passed the
    // positive control; unrelated malformed DTOs cannot create false passes.
    for path in [
        "",
        "/identity",
        "/bundle",
        "/bundle/wrapped",
        "/bundle/wrapped/context",
    ] {
        for field in [
            "secret",
            "rawKey",
            "password",
            "plaintext",
            "kdf",
            "memory",
            "unexpected",
            "currentPassword",
        ] {
            if path.is_empty() && field == "currentPassword" {
                continue;
            }
            let mut bad = initial.clone();
            let parent = if path.is_empty() {
                &mut bad
            } else {
                bad.pointer_mut(path).unwrap()
            };
            parent[field] = json!("synthetic-forbidden-sentinel");
            assert_eq!(native(&bad)["status"], 400, "strict native nested shape");
            rejected(db, p, &a, &a.headers(), &bad, 400);
        }
    }
    let mut auth_on_initial = initial.clone();
    auth_on_initial["currentPassword"] = json!(a.password);
    rejected(db, p, &a, &a.headers(), &auth_on_initial, 400);
    // Node's JSON parse/stringify normalizes integral floats (0.0 to 0).
    // Check lexical float rejection at the native boundary only; use actual
    // nonintegral numbers for HTTP negatives rather than a false wire claim.
    for (path, value) in [
        ("/expectedVersion", json!(0.0)),
        ("/bundle/format", json!(1.0)),
    ] {
        let mut bad = initial.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert_eq!(native(&bad)["status"], 400, "native integer representation");
    }
    for (path, value) in [
        ("/expectedVersion", json!(-1)),
        ("/expectedVersion", json!(0.5)),
        ("/expectedVersion", json!(9_007_199_254_740_991u64)),
        ("/identity/accountId", json!(b.id)),
        ("/identity/accountId", json!(a.id.to_uppercase())),
        (
            "/identity/keyId",
            json!(public["keyId"].as_str().unwrap().to_uppercase()),
        ),
        ("/identity/keyId", json!("0".repeat(64))),
        ("/identity/identityVersion", json!(0)),
        ("/identity/publicKey", json!(BASE64.encode([1u8; 31]))),
        (
            "/identity/publicKey",
            json!(public["publicKey"].as_str().unwrap().trim_end_matches('=')),
        ),
        ("/bundle/format", json!(2)),
        ("/bundle/format", json!(1.5)),
        ("/bundle/salt", json!(BASE64.encode([1u8; 15]))),
        ("/bundle/salt", json!("AAAAAAAAAAAAAAAAAAAAAB==")),
        ("/bundle/wrapped/format", json!(2)),
        ("/bundle/wrapped/nonce", json!(BASE64.encode([1u8; 23]))),
        (
            "/bundle/wrapped/ciphertext",
            json!(BASE64.encode([1u8; 47])),
        ),
        ("/bundle/wrapped/context/accountId", json!(b.id)),
        ("/bundle/wrapped/context/identityVersion", json!(2)),
    ] {
        let mut bad = initial.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert_eq!(native(&bad)["status"], 400, "shape validation");
        rejected(db, p, &a, &a.headers(), &bad, 400);
    }
    // Otherwise valid hash/encoding: isolate RFC 7748 coordinate rejection.
    for point in [[0xffu8; 32], {
        let mut p = [0xffu8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        p
    }] {
        let encoded = BASE64.encode(point);
        let fingerprint = db.sql(&format!(
            "SELECT encode(sha256(decode('{encoded}','base64')),'hex')"
        ));
        let mut bad = initial.clone();
        bad["identity"]["publicKey"] = json!(encoded);
        bad["identity"]["keyId"] = json!(fingerprint);
        rejected(db, p, &a, &a.headers(), &bad, 400);
    }
    assert_eq!(
        http(
            p,
            "GET",
            &format!("{SELF_PATH}?accountId={}", b.id),
            &a.headers(),
            &Value::Null
        )
        .0,
        400
    );
    assert_eq!(
        http(
            p,
            "GET",
            SELF_PATH,
            &a.headers(),
            &json!({"accountId":b.id})
        )
        .0,
        400
    );

    // Rotation uses a real second Core keypair with a valid fingerprint, so
    // immutable-public rejection cannot be caused by a bad hash or wrapper.
    let replacement = AccountIdentity::generate(context.clone()).unwrap();
    let replacement_public = serde_json::to_value(replacement.public_identity()).unwrap();
    let rotation = request(
        &replacement_public,
        &bundle(&replacement, &master, salt),
        1,
        Some(&a.password),
    );
    rejected(db, p, &a, &a.headers(), &rotation, 409);
    let rotated_context: AccountIdentityContext =
        serde_json::from_value(json!({"accountId":a.id,"identityVersion":2})).unwrap();
    let rotated_identity = AccountIdentity::generate(rotated_context).unwrap();
    let rotated_public = serde_json::to_value(rotated_identity.public_identity()).unwrap();
    let version_rotation = request(
        &rotated_public,
        &bundle(&rotated_identity, &master, salt),
        1,
        Some(&a.password),
    );
    rejected(db, p, &a, &a.headers(), &version_rotation, 409);

    let next_password = BASE64.encode(generate_salt().unwrap());
    assert_ne!(next_password, encryption_password);
    assert_ne!(next_password, a.password);
    let next_salt = generate_salt().unwrap();
    let next_master = owner_master(&next_password, &next_salt).unwrap();
    let rewrapped = bundle(&identity, &next_master, next_salt);
    rejected(
        db,
        p,
        &a,
        &a.headers(),
        &request(&public, &rewrapped, 1, None),
        401,
    );
    rejected(
        db,
        p,
        &a,
        &a.headers(),
        &request(&public, &rewrapped, 1, Some("synthetic-wrong-login-Aa!")),
        401,
    );
    let update = request(&public, &rewrapped, 1, Some(&a.password));
    assert_eq!(http(p, "PUT", SELF_PATH, &a.headers(), &update).0, 200);
    let second = read(p, &a);
    assert_eq!(second["bundleVersion"], 2);
    assert_eq!(second["bundle"], rewrapped);
    roundtrip(&second, &next_master, &context, &public);
    let old_wrapped: WrappedAccountIdentity =
        serde_json::from_value(first["bundle"]["wrapped"].clone()).unwrap();
    assert!(
        AccountIdentity::unwrap(
            &old_wrapped,
            &master,
            &context,
            public["keyId"].as_str().unwrap()
        )
        .is_ok(),
        "old private seed and fingerprint remain valid"
    );
    rejected(db, p, &a, &a.headers(), &update, 409);
    rejected(db, p, &a, &a.headers(), &initial, 409);

    // Exactly two simultaneous CAS writers, with distinct real wrapped bundles.
    let candidates = [
        bundle(&identity, &next_master, next_salt),
        bundle(&identity, &next_master, next_salt),
    ];
    assert_ne!(candidates[0], candidates[1]);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let workers: Vec<_> = candidates
        .iter()
        .map(|sealed| {
            let gate = barrier.clone();
            let headers = a.headers();
            let body = request(&public, sealed, 2, Some(&a.password));
            thread::spawn(move || {
                gate.wait();
                http(p, "PUT", SELF_PATH, &headers, &body)
            })
        })
        .collect();
    barrier.wait();
    let replies: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(replies.iter().filter(|r| r.0 == 200).count(), 1);
    assert_eq!(replies.iter().filter(|r| r.0 == 409).count(), 1);
    let third = read(p, &a);
    assert_eq!(third["bundleVersion"], 3);
    assert_eq!(third, replies.iter().find(|r| r.0 == 200).unwrap().1);
    roundtrip(&third, &next_master, &context, &public);

    // Explicit synthetic AFTER UPDATE failure proves transaction rollback,
    // rather than claiming an API operation injected this database fault.
    db.sql("CREATE FUNCTION passshare_identity_fixture_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic identity rollback fault'; END $$; CREATE TRIGGER passshare_identity_fixture_fault AFTER UPDATE ON encrypted_account_identities FOR EACH ROW EXECUTE FUNCTION passshare_identity_fixture_fault();");
    let before_fault = row(db, &a);
    let (fault_status, fault_reply) = http(
        p,
        "PUT",
        SELF_PATH,
        &a.headers(),
        &request(
            &public,
            &bundle(&identity, &next_master, next_salt),
            3,
            Some(&a.password),
        ),
    );
    assert_eq!(fault_status, 503);
    assert_eq!(
        fault_reply,
        json!({"error":"PS019","message":"PS019: Encrypted storage unavailable"}),
        "raw underlying SQL errors must not escape"
    );
    assert_eq!(
        row(db, &a),
        before_fault,
        "AFTER UPDATE exception rolls back the full row"
    );
    db.sql("DROP TRIGGER passshare_identity_fixture_fault ON encrypted_account_identities; DROP FUNCTION passshare_identity_fixture_fault();");

    // Three clients each publish their own private bundle. A's self read never
    // accepts B as a selector; peer reads return the public descriptor only.
    let b_identity = AccountIdentity::generate(b.context()).unwrap();
    let b_public = serde_json::to_value(b_identity.public_identity()).unwrap();
    let b_bundle = bundle(&b_identity, &master, salt);
    assert_eq!(
        http(
            p,
            "PUT",
            SELF_PATH,
            &b.headers(),
            &request(&b_public, &b_bundle, 0, None)
        )
        .0,
        200
    );
    let c_identity = AccountIdentity::generate(c.context()).unwrap();
    let c_public = serde_json::to_value(c_identity.public_identity()).unwrap();
    let c_bundle = bundle(&c_identity, &master, salt);
    assert_eq!(
        http(
            p,
            "PUT",
            SELF_PATH,
            &c.headers(),
            &request(&c_public, &c_bundle, 0, None)
        )
        .0,
        200
    );
    let box_root = format!("/api/encrypted/boxes/{}", a.box_id);
    assert_eq!(
        peer(p, &a, &a.box_id, &a).0,
        409,
        "legacy boxes must not yield identity descriptors"
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{box_root}/enable"),
            &a.headers(),
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    assert_eq!(
        peer(p, &a, &a.box_id, &b).0,
        403,
        "target membership required"
    );
    assert_eq!(
        peer(p, &b, &a.box_id, &a).0,
        403,
        "caller membership required"
    );
    assert_eq!(peer(p, &c, &a.box_id, &a).0, 403, "stranger denied");
    // Synthetic M3 compatibility claimant has a real account/email and an
    // unconfirmed membership. Never use SQL to claim positive confirmation.
    db.sql(&format!(
        "INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{}','{}','member')",
        b.id, a.box_id
    ));
    assert_eq!(
        peer(p, &a, &a.box_id, &b).0,
        403,
        "unconfirmed target denied"
    );
    assert_eq!(
        peer(p, &b, &a.box_id, &a).0,
        403,
        "unconfirmed caller denied"
    );
    invite_and_confirm(p, &a, &b);
    let peer_reply = peer(p, &a, &a.box_id, &b);
    assert_eq!(
        peer_reply,
        (200, json!({"identity":b_public})),
        "public-only peer projection"
    );
    assert_eq!(
        peer(p, &b, &a.box_id, &a),
        (200, json!({"identity":public}))
    );
    let peer_path = format!("{box_root}/member-identities/{}", b.id);
    assert_eq!(
        http(
            p,
            "GET",
            &peer_path,
            &format!("Authorization: Bearer {}\r\n", a.connect),
            &Value::Null
        )
        .0,
        401
    );
    assert_eq!(
        http(
            p,
            "GET",
            &format!("{box_root}/member-identities/{}", b.id.to_uppercase()),
            &a.headers(),
            &Value::Null
        )
        .0,
        400
    );
    assert_eq!(
        http(
            p,
            "GET",
            &format!("/api/encrypted/boxes/short/member-identities/{}", b.id),
            &a.headers(),
            &Value::Null
        )
        .0,
        400
    );
    assert_eq!(
        http(p, "GET", &peer_path, &a.headers(), &json!({"bundle":true})).0,
        400
    );
    let private_b = read(p, &b);
    assert_eq!(
        private_b["bundle"], b_bundle,
        "private bundle still accessible only to its owner"
    );
    waiting_peer_revocation(db, p, &a, &b);

    // Formal transfer leaves A as a confirmed member; only formal removal
    // then denies access. A formerly being owner does not grant lasting access.
    assert_eq!(
        http(
            p,
            "POST",
            &format!("/api/auth/vaults/{}/ownership", a.box_id),
            &a.headers(),
            &json!({"currentPassword":a.password,"targetUserId":b.id})
        )
        .0,
        204
    );
    assert_eq!(peer(p, &a, &a.box_id, &b).0, 200);
    assert_eq!(
        http(
            p,
            "DELETE",
            &format!("/api/auth/vaults/{}/members/{}", a.box_id, a.id),
            &b.headers(),
            &Value::Null
        )
        .0,
        204
    );
    assert_eq!(
        peer(p, &a, &a.box_id, &b).0,
        403,
        "removed former owner denied"
    );
    assert_eq!(peer(p, &b, &a.box_id, &a).0, 403, "removed target denied");
    assert_eq!(
        read(p, &a)["identity"],
        public,
        "box removal must not delete account identity"
    );

    // Formal retirement of B cascades ONLY B's identity. The now-private box
    // can be deleted by retirement; A's independent identity row survives.
    let a_before = row(db, &a);
    let c_before = row(db, &c);
    assert_eq!(
        http(
            p,
            "DELETE",
            "/api/auth/account",
            &b.headers(),
            &json!({"currentPassword":b.password,"confirmationEmail":b.email})
        )
        .0,
        204
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_account_identities WHERE account_id='{}'",
            b.id
        )),
        "0"
    );
    assert_eq!(row(db, &a), a_before);
    assert_eq!(row(db, &c), c_before);
    assert_eq!(
        http(p, "GET", SELF_PATH, &b.headers(), &Value::Null).0,
        401,
        "retired account old session denied"
    );
    assert_eq!(read(p, &a)["identity"], public);

    // Storage observation uses only known synthetic sentinels, never searches
    // for random secret keys or misrepresents opaque ciphertext as authenticated.
    for sentinel in [
        encryption_password.as_str(),
        next_password.as_str(),
        "synthetic-forbidden-sentinel",
    ] {
        assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_account_identities WHERE identity::text LIKE '%{sentinel}%' OR bundle::text LIKE '%{sentinel}%'")),"0");
    }
    assert_eq!(db.sql("SELECT count(*) FROM information_schema.columns WHERE table_name='encrypted_account_identities' AND column_name IN ('password','private_key','seed','plaintext','kdf')"),"0");

    // Persistence and the feature guard use the actual formal host entrypoint.
    let saved = read(p, &a);
    drop(host);
    host = Host::start(db, network, mode);
    assert_eq!(read(host.port, &a), saved);
    let disabled = Host::with_storage(db, network, mode, false);
    // Disabled routes use Express's ordinary HTML 404, not a JSON API reply.
    assert_eq!(
        http_bytes(disabled.port, "GET", SELF_PATH, &a.headers(), &Value::Null).0,
        404,
        "flag-off self route absent"
    );
    assert_eq!(
        http_bytes(disabled.port, "PUT", SELF_PATH, &a.headers(), &initial).0,
        404,
        "flag-off put absent"
    );
    assert_eq!(
        http_bytes(disabled.port, "GET", &peer_path, &a.headers(), &Value::Null).0,
        404,
        "flag-off peer route absent"
    );
    assert_eq!(row(db, &a), a_before);
    drop(disabled);
    waiting_self_revocation(
        db,
        host.port,
        &a,
        &public,
        &identity,
        &next_master,
        next_salt,
    );
    drop(host);
    println!("account identity formal acceptance: Core roundtrip, strict public shape, immutable public identity, bootstrap replay, reauthentication, CAS, synthetic rollback/revocation, confirmed public-only peers, removal, retirement cascade and restart passed");
}

fn waiting_peer_revocation(db: &Database, p: u16, a: &Account, b: &Account) {
    // A separate formal session lets the main fixture keep using A after this
    // explicitly synthetic revocation; no fourth registration is necessary.
    let (status, login) = http(
        p,
        "POST",
        "/api/auth/login",
        "x-passshare-client: mobile\r\n",
        &json!({"email":a.email,"password":a.password}),
    );
    assert_eq!(status, 200, "formal second session for peer wait fixture");
    let session = login["refreshToken"].as_str().unwrap();
    let session_id = db.sql(&format!(
        "SELECT id::text FROM sessions WHERE user_id='{}' ORDER BY created_at DESC LIMIT 1",
        a.id
    ));
    let path = format!(
        "/api/encrypted/boxes/{}/member-identities/{}",
        a.box_id, b.id
    );
    let headers = format!("Authorization: Bearer {session}\r\n");
    assert_eq!(
        http(p, "GET", &path, &headers, &Value::Null).0,
        200,
        "positive control on this session and peer"
    );
    let a_before = row(db, a);
    let b_before = row(db, b);
    let label = format!(
        "passshare-identity-peer-holder-{}",
        ConnectId::generate().unwrap()
    );
    let mut held = HeldBox::start(db, &a.box_id, &label);
    assert!(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"observe acquired peer parent lock");
    let worker_headers = headers.clone();
    let worker_path = path.clone();
    let worker = thread::spawn(move || http(p, "GET", &worker_path, &worker_headers, &Value::Null));
    let observed=wait_db(db,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT passshare_member_identity(%')");
    if !observed {
        held.commit();
        let _ = worker.join();
        panic!("must observe the actual peer API waiting on its box before revocation");
    }
    db.sql(&format!("DELETE FROM sessions WHERE id='{session_id}'"));
    held.commit();
    assert_eq!(
        worker.join().unwrap().0,
        401,
        "peer read rechecks liveness after box wait"
    );
    assert_eq!(row(db, a), a_before);
    assert_eq!(row(db, b), b_before);
    assert_eq!(http(p, "GET", &path, &headers, &Value::Null).0, 401);
    assert_eq!(
        peer(p, a, &a.box_id, b).0,
        200,
        "original session remains live"
    );
}

fn waiting_self_revocation(
    db: &Database,
    p: u16,
    a: &Account,
    public: &Value,
    identity: &AccountIdentity,
    master: &MasterKey,
    salt: [u8; 16],
) {
    for fault in ["credential-snapshot", "session-revocation"] {
        let label = format!(
            "passshare-identity-holder-{}",
            ConnectId::generate().unwrap()
        );
        let mut child = command("docker")
            .args([
                "exec",
                "-i",
                "--env",
                &format!("PGAPPNAME={label}"),
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
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        writeln!(child.stdin.as_mut().unwrap(),"SET statement_timeout=12000; SET idle_in_transaction_session_timeout=15000; BEGIN; SELECT id FROM users WHERE id='{}' FOR UPDATE;",a.id).unwrap();
        child.stdin.as_mut().unwrap().flush().unwrap();
        let mut held = HeldBox { child }; // Reuse bounded holder lifecycle/cleanup.
        assert!(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"observe acquired user lock");
        let before = row(db, a);
        let headers = a.headers();
        let body = request(
            public,
            &bundle(identity, master, salt),
            3,
            Some(&a.password),
        );
        let worker = thread::spawn(move || http(p, "PUT", SELF_PATH, &headers, &body));
        let observed=wait_db(db,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT passshare_account_identity_operation(%')");
        if !observed {
            held.commit();
            let _ = worker.join();
            panic!("must observe the actual API SQL waiting on user lock before revocation");
        }
        // The credential fault keeps the original session alive, so a missing
        // hash-snapshot comparison cannot pass merely through session revocation.
        let old_hash = db.sql(&format!(
            "SELECT password_hash FROM users WHERE id='{}'",
            a.id
        ));
        let session_count = db.sql(&format!(
            "SELECT count(*) FROM sessions WHERE user_id='{}'",
            a.id
        ));
        assert_ne!(session_count, "0");
        if fault == "credential-snapshot" {
            let replacement = db.sql(&format!(
                "SELECT password_hash FROM users WHERE id<>'{}' ORDER BY id LIMIT 1",
                a.id
            ));
            assert!(
                !replacement.is_empty() && replacement != old_hash,
                "distinct valid synthetic credential"
            );
            writeln!(
                held.child.stdin.as_mut().unwrap(),
                "UPDATE users SET password_hash='{}' WHERE id='{}';",
                replacement.replace('\'', "''"),
                a.id
            )
            .unwrap();
            held.child.stdin.as_mut().unwrap().flush().unwrap();
        } else {
            // Direct SQL revocation is synthetic, not a formal logout API claim.
            db.sql(&format!("DELETE FROM sessions WHERE user_id='{}'", a.id));
        }
        held.commit();
        let (status, reply) = worker.join().unwrap();
        assert_eq!(status, 401);
        assert_eq!(
            reply["error"],
            if fault == "credential-snapshot" {
                "PS026"
            } else {
                "PS024"
            }
        );
        assert_eq!(
            row(db, a),
            before,
            "post-wait revocation preserves entire identity row"
        );
        if fault == "credential-snapshot" {
            assert_eq!(
                db.sql(&format!(
                    "SELECT count(*) FROM sessions WHERE user_id='{}'",
                    a.id
                )),
                session_count,
                "snapshot failure must not depend on session deletion"
            );
            assert_eq!(
                http(p, "GET", SELF_PATH, &a.headers(), &Value::Null).0,
                200,
                "same original session remains live"
            );
            db.sql(&format!(
                "UPDATE users SET password_hash='{}' WHERE id='{}'",
                old_hash.replace('\'', "''"),
                a.id
            ));
        } else {
            assert_eq!(http(p, "GET", SELF_PATH, &a.headers(), &Value::Null).0, 401);
        }
    }
}
