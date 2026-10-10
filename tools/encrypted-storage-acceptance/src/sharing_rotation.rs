//! Formal Core -> Node/distribution image -> owned PostgreSQL -> Core acceptance.
//! Implementation jobs do not execute this fixture. SQL faults/session changes
//! below are explicitly synthetic events in THIS invocation's disposable DB.
use super::*;
use passshare_connect::{AccountIdentityBundle, EncryptedSessionClient, EncryptedSessionError};
use passshare_core::cloud_crypto::{
    AccountIdentity, EncryptedItem, PublicAccountIdentity, SharedKeyContext,
};
use std::collections::BTreeMap;

#[path = "legacy_expiry.rs"]
mod legacy_expiry;

#[path = "sharing_sdk.rs"]
mod sharing_sdk;

fn request_slot() {
    // Honor the REAL formal router quota; never increase its limit or rewrite
    // rate-limit DB rows. This pacing is unrelated to lock-race evidence.
    static REQUESTS: std::sync::Mutex<std::collections::VecDeque<std::time::Instant>> =
        std::sync::Mutex::new(std::collections::VecDeque::new());
    loop {
        let now = std::time::Instant::now();
        let mut requests = REQUESTS.lock().unwrap();
        while requests
            .front()
            .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(61))
        {
            requests.pop_front();
        }
        if requests.len() < 450 {
            requests.push_back(now);
            return;
        }
        drop(requests);
        thread::sleep(Duration::from_millis(250));
    }
}

fn checked<T, E>(result: Result<T, E>, step: &str) -> T {
    result.unwrap_or_else(|_| panic!("sharing acceptance: {step} failed (details suppressed)"))
}

struct Account {
    id: String,
    email: String,
    session: String,
    connect: String,
    login_password: String,
    box_id: String,
    identity: AccountIdentity,
    pin: PublicAccountIdentity,
    encryption_password: String,
    master: MasterKey,
    salt: [u8; 16],
}
impl Account {
    fn signup(p: u16) -> Self {
        let (session, connect, box_id, login_password) = signup_with_password(p);
        let (status, me) = http(
            p,
            "GET",
            "/api/auth/me",
            &format!("Authorization: Bearer {session}\r\n"),
            &Value::Null,
        );
        assert_eq!(status, 200);
        let id = text_field(&me["user"], "id");
        let email = text_field(&me["user"], "email");
        // Generate the independent descriptor BEFORE any identity server read.
        let context = checked(
            serde_json::from_value(json!({"accountId":id,"identityVersion":1})),
            "identity context",
        );
        let identity = checked(AccountIdentity::generate(context), "OS identity generation");
        let pin = identity.public_identity();
        let encryption_password = BASE64.encode(checked(generate_salt(), "OS encryption password"));
        assert!(encryption_password != login_password);
        let salt = checked(generate_salt(), "OS KDF salt");
        let master = checked(owner_master(&encryption_password, &salt), "client KDF");
        Self {
            id,
            email,
            session,
            connect,
            login_password,
            box_id,
            identity,
            pin,
            encryption_password,
            master,
            salt,
        }
    }
    fn headers(&self) -> String {
        format!("Authorization: Bearer {}\r\n", self.session)
    }
    fn sdk(&self, p: u16) -> EncryptedSessionClient {
        checked(
            EncryptedSessionClient::new(&format!("http://127.0.0.1:{p}"), &self.session),
            "SDK session",
        )
    }
    fn register(&self, p: u16, rt: &tokio::runtime::Runtime) {
        let sdk = self.sdk(p);
        let sealed = checked(
            AccountIdentityBundle::new(
                BASE64.encode(self.salt),
                checked(self.identity.wrap(&self.master), "Core identity wrap"),
            ),
            "identity bundle",
        );
        let stored = checked(
            rt.block_on(sdk.put_account_identity(0, &self.pin, &sealed, None)),
            "SDK identity PUT",
        );
        assert!(
            stored.bundle == sealed && stored.identity == self.pin && stored.bundle_version == 1
        );
        let fetched = checked(
            rt.block_on(sdk.get_account_identity(self.identity.context(), &self.pin.key_id)),
            "SDK identity GET",
        );
        let restored = checked(
            AccountIdentity::unwrap(
                &fetched.bundle.wrapped,
                &self.master,
                self.identity.context(),
                &self.pin.key_id,
            ),
            "Core independently pinned identity unwrap",
        );
        assert!(restored.public_identity() == self.pin && fetched == stored);
        let other = checked(
            AccountIdentity::generate(self.identity.context().clone()),
            "alternate valid identity",
        );
        assert!(matches!(
            rt.block_on(
                sdk.get_account_identity(self.identity.context(), &other.public_identity().key_id)
            ),
            Err(EncryptedSessionError::ContextMismatch)
        ));
        let changed = checked(
            AccountIdentityBundle::new(
                BASE64.encode(self.salt),
                checked(other.wrap(&self.master), "alternate wrap"),
            ),
            "alternate bundle",
        );
        assert_eq!(
            rt.block_on(sdk.put_account_identity(0, &other.public_identity(), &changed, None))
                .err()
                .unwrap()
                .status(),
            Some(409),
            "public identity immutable on alternate bootstrap"
        );
    }
}

fn number(v: &Value, field: &str) -> u64 {
    v[field]
        .as_u64()
        .unwrap_or_else(|| panic!("sharing contract missing integer field {field}"))
}
fn text_field(v: &Value, field: &str) -> String {
    v[field]
        .as_str()
        .unwrap_or_else(|| panic!("sharing contract missing string field {field}"))
        .to_owned()
}
fn root(a: &Account) -> String {
    format!("/api/encrypted/boxes/{}", a.box_id)
}
fn call(p: u16, a: &Account, method: &str, path: &str, body: &Value, status: u16) -> Value {
    request_slot();
    let (actual, reply) = http(p, method, path, &a.headers(), body);
    // Keep identifiers and all caller-controlled/credential-derived strings
    // out of failure logs; only the two numeric HTTP statuses may be printed.
    assert_eq!(actual, status, "formal sharing API status");
    reply
}
fn sql_json(v: &Value) -> String {
    v.to_string().replace('\'', "''")
}
fn state_hash_sql(include_staging: bool) -> String {
    // Hash EVERY full row AND xmin of every box, not just counts or selected
    // columns. Only synthetic users/sessions are excluded from box state.
    let mut tables = vec![
        "connect_vaults",
        "vault_memberships",
        "vault_invitations",
        "connect_tokens",
        "encrypted_box_state",
        "encrypted_owner_keys",
        "encrypted_key_grants",
        "encrypted_items",
        "encrypted_item_tombstones",
        "encrypted_account_identities",
    ];
    if include_staging {
        tables.extend([
            "encrypted_rotations",
            "encrypted_rotation_items",
            "encrypted_rotation_grants",
        ]);
    }
    let parts: Vec<_> = tables.iter().map(|t| format!("SELECT '{t}' AS name, COALESCE(string_agg(md5(jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)::text),',' ORDER BY md5(jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)::text)),'') AS digest FROM {t} r")).collect();
    format!(
        "SELECT md5(string_agg(name||':'||digest,'|' ORDER BY name)) FROM ({}) fixture_rows",
        parts.join(" UNION ALL ")
    )
}
pub(super) fn state_hash(db: &Database, include_staging: bool) -> String {
    db.sql(&state_hash_sql(include_staging))
}
fn rejected(
    db: &Database,
    p: u16,
    a: &Account,
    method: &str,
    path: &str,
    body: &Value,
    status: u16,
) -> Value {
    let before = state_hash(db, true);
    let reply = call(p, a, method, path, body, status);
    assert_eq!(
        state_hash(db, true),
        before,
        "rejected request preserves whole live/staged DB including xmin"
    );
    reply
}
fn exact_replay(
    db: &Database,
    p: u16,
    a: &Account,
    method: &str,
    path: &str,
    body: &Value,
) -> Value {
    let before = state_hash(db, true);
    let reply = call(p, a, method, path, body, 200);
    assert_eq!(
        state_hash(db, true),
        before,
        "exact replay never rewrites rows/xmin/revision"
    );
    reply
}
fn invite(p: u16, a: &Account, recipient: &Account) -> Value {
    call(
        p,
        a,
        "POST",
        &format!("/api/auth/vaults/{}/invitations", a.box_id),
        &json!({"email":recipient.email,"role":"member"}),
        201,
    )
}
fn accept(p: u16, recipient: &Account, invitation: &Value) {
    call(
        p,
        recipient,
        "POST",
        &format!(
            "/api/auth/invitations/{}/accept",
            text_field(invitation, "id")
        ),
        &json!({"confirmationCode":invitation["confirmationCode"]}),
        200,
    );
}
fn shared_context(a: &Account, recipient: &Account, epoch: u64) -> SharedKeyContext {
    // Exclusively caller-held descriptors, never a descriptor from an HTTP reply.
    checked(
        serde_json::from_value(json!({"passwordBoxId":a.box_id,"senderAccountId":a.id,
        "recipientAccountId":recipient.id,"keyEpoch":epoch,"senderIdentityVersion":a.pin.identity_version,
        "recipientIdentityVersion":recipient.pin.identity_version,"senderKeyId":a.pin.key_id,"recipientKeyId":recipient.pin.key_id})),
        "pinned sharing context",
    )
}
fn grant(key: &PasswordBoxKey, a: &Account, recipient: &Account, epoch: u64) -> Value {
    json!(checked(
        key.wrap_for_recipient(
            &a.identity,
            &recipient.pin,
            &shared_context(a, recipient, epoch)
        ),
        "Core HPKE Auth wrap"
    ))
}
fn own_grant(
    rt: &tokio::runtime::Runtime,
    sdk: &EncryptedSessionClient,
    a: &Account,
    recipient: &Account,
    epoch: u64,
) -> PasswordBoxKey {
    sharing_sdk::self_grant(rt, sdk, a, recipient, epoch)
}
fn snapshot(p: u16, a: &Account) -> Value {
    let result = call(
        p,
        a,
        "GET",
        &format!("{}/sharing-snapshot", root(a)),
        &Value::Null,
        200,
    );
    assert_eq!(
        result["ownerAccountId"], a.id,
        "snapshot owner is independently held account"
    );
    result
}
fn context(a: &Account, id: &str, version: u64, epoch: u64) -> ItemContext {
    checked(
        serde_json::from_value(
            json!({"passwordBoxId":a.box_id,"itemId":id,"itemVersion":version,"keyEpoch":epoch}),
        ),
        "independent item context",
    )
}
fn dto(a: &Account, id: &str, ordinal: usize, sentinel: &str) -> Value {
    // Full JSON DTO, including future/unknown fields, order-sensitive arrays,
    // URLs, attachment metadata and nested custom fields; never reconstruct it.
    json!({"id":id,"vault":{"id":a.box_id,"name":"synthetic"},"title":format!("{sentinel}-{ordinal}"),"category":"LOGIN","version":1,
        "fields":[{"id":"second","type":"STRING","value":"second"},{"id":"first","type":"CONCEALED","value":sentinel}],
        "urls":[{"href":"https://second.example.test","primary":false},{"href":"https://first.example.test","primary":true}],
        "attachments":[{"id":"attachment-z","size":19,"name":"z.txt","extra":{"digest":"synthetic"}},{"id":"attachment-a","size":7,"name":"a.txt"}],
        "customFields":[{"name":"nested","value":{"list":[3,1,2],"boolean":false}}],
        "extra":{"sentinel":sentinel,"unknownFuture":{"order":["z","a"],"null":null},"padding":if ordinal<3 {"x".repeat(900*1024)} else {"ordinary".to_owned()}}})
}

struct Candidate {
    previous: u64,
    expected: Value,
    envelope: EncryptedItem,
}
struct Rotation {
    path: String,
    header: Value,
    snapshot: Value,
    candidates: BTreeMap<String, Candidate>,
    sdk_expectation: passshare_connect::RotationExpectation,
}
fn operation_id(db: &Database) -> String {
    // PostgreSQL OS-backed UUID generator; no new UUID dependency.
    db.sql("SELECT gen_random_uuid()::text")
}
impl Rotation {
    #[allow(clippy::too_many_arguments)] // All client-held trust inputs remain explicit.
    fn prepare(
        db: &Database,
        p: u16,
        a: &Account,
        b: &Account,
        old: &PasswordBoxKey,
        new: &PasswordBoxKey,
        bundle: &Value,
        items: &BTreeMap<String, Value>,
    ) -> Self {
        let snapshot = snapshot(p, a);
        let revision = number(&snapshot, "stateRevision");
        assert_eq!(number(&snapshot, "keyEpoch"), 1);
        assert_eq!(number(&snapshot, "liveItemCount") as usize, items.len());
        let mut after = None::<String>;
        let mut candidates = BTreeMap::new();
        let mut page_count = 0;
        loop {
            let path = format!(
                "{}/sharing-snapshot/items?revision={revision}{}",
                root(a),
                after
                    .as_ref()
                    .map(|id| format!("&after={id}"))
                    .unwrap_or_default()
            );
            let page = call(p, a, "GET", &path, &Value::Null, 200);
            assert_eq!(number(&page, "stateRevision"), revision);
            let entries = page["items"].as_array().expect("snapshot items array");
            assert!(entries.len() <= 100);
            page_count += 1;
            let mut previous_id = after.clone();
            for entry in entries {
                assert_eq!(
                    entry.as_object().unwrap().len(),
                    3,
                    "metadata has no ciphertext/secret"
                );
                let id = text_field(entry, "itemId");
                assert!(
                    previous_id.as_ref().is_none_or(|previous| &id > previous),
                    "snapshot IDs strictly ordered across and within pages"
                );
                previous_id = Some(id.clone());
                let previous = number(entry, "itemVersion");
                let epoch = number(entry, "keyEpoch");
                assert_eq!(epoch, 1);
                let value = call(
                    p,
                    a,
                    "GET",
                    &format!(
                        "{}/sharing-snapshot/items/{id}?revision={revision}",
                        root(a)
                    ),
                    &Value::Null,
                    200,
                );
                let envelope: EncryptedItem =
                    checked(serde_json::from_value(value), "pinned snapshot envelope");
                let mut expected = checked(
                    old.decrypt_item(&envelope, &context(a, &id, previous, epoch)),
                    "Core old-key full JSON decrypt",
                );
                assert!(
                    items.get(&id) == Some(&expected),
                    "whole DTO retained before rotation"
                );
                expected["version"] = json!(previous + 1);
                let envelope = checked(
                    new.encrypt_item(&expected, &context(a, &id, previous + 1, 2)),
                    "Core new-context JSON encryption",
                );
                assert!(
                    candidates
                        .insert(
                            id,
                            Candidate {
                                previous,
                                expected,
                                envelope
                            }
                        )
                        .is_none(),
                    "no repeated item ID"
                );
            }
            if page["nextCursor"].is_null() {
                break;
            }
            let next = text_field(&page, "nextCursor");
            assert!(after.as_ref().is_none_or(|previous| &next > previous));
            assert_eq!(
                previous_id.as_deref(),
                Some(next.as_str()),
                "cursor equals last page ID"
            );
            after = Some(next);
            assert!(page_count < 10, "bounded snapshot pagination");
        }
        assert!(
            page_count >= 2 && candidates.len() == items.len(),
            "more than one snapshot page with exact ID set"
        );
        let path = format!("{}/sharing-snapshot/members?revision={revision}", root(a));
        let members = call(p, a, "GET", &path, &Value::Null, 200);
        assert_eq!(number(&members, "stateRevision"), revision);
        assert!(members["nextCursor"].is_null());
        let entries = members["members"]
            .as_array()
            .expect("member metadata array");
        assert_eq!(entries.len() as u64, number(&snapshot, "memberCount"));
        assert!(
            entries
                .iter()
                .all(|m| m.as_object().is_some_and(|o| o.len() == 4)
                    && m["accountId"].is_string()
                    && m["role"].is_string()
                    && m["membershipConfirmed"].is_boolean()
                    && m["keyGranted"].is_boolean()),
            "public role/confirmation/granted metadata only"
        );
        let restored = checked(
            unwrap_bundle(
                bundle,
                &a.encryption_password,
                &owner_context(&a.box_id, &a.id, 2),
            ),
            "new owner bundle independently unwraps",
        );
        for (id, candidate) in &candidates {
            assert!(
                checked(
                    restored.decrypt_item(
                        &candidate.envelope,
                        &context(a, id, candidate.previous + 1, 2)
                    ),
                    "verify candidate via owner bundle"
                ) == candidate.expected,
                "whole candidate DTO verified"
            );
        }
        let header = json!({"expectedStateRevision":revision,"expectedKeyEpoch":1,"expectedOwnerBundleVersion":snapshot["ownerBundleVersion"],"removeAccountId":b.id,"bundle":bundle});
        let operation_id = operation_id(db);
        // Persist the original caller-held expectation BEFORE any start reply.
        let sdk_expectation = passshare_connect::RotationExpectation {
            operation_id: operation_id.clone(),
            password_box_id: checked(a.box_id.parse(), "SDK rotation box ID"),
            owner_account_id: a.id.clone(),
            expected_state_revision: number(&header, "expectedStateRevision"),
            expected_key_epoch: number(&header, "expectedKeyEpoch"),
            expected_owner_bundle_version: number(&header, "expectedOwnerBundleVersion"),
            remove_account_id: b.id.clone(),
            item_count: Some(items.len() as u64),
            grant_count: Some(number(&snapshot, "grantCount") - 1),
        };
        Self {
            path: format!("{}/rotations/{}", root(a), operation_id),
            header,
            snapshot,
            candidates,
            sdk_expectation,
        }
    }
    fn start(&self, p: u16, a: &Account) {
        let result = call(p, a, "PUT", &self.path, &self.header, 200);
        assert_eq!(result["status"], "pending");
    }
    fn stage_items(&self, p: u16, a: &Account, omit_last: bool) {
        for (index, (id, candidate)) in self.candidates.iter().enumerate() {
            if omit_last && index + 1 == self.candidates.len() {
                break;
            }
            call(
                p,
                a,
                "PUT",
                &format!("{}/items/{id}", self.path),
                &json!({"expectedVersion":candidate.previous,"envelope":candidate.envelope}),
                200,
            );
        }
    }
    fn stage_grant(&self, p: u16, a: &Account, c: &Account, envelope: &Value) {
        call(
            p,
            a,
            "PUT",
            &format!("{}/grants/{}", self.path, c.id),
            &json!({"envelope":envelope}),
            200,
        );
    }
    fn abort(&self, p: u16, a: &Account) {
        call(p, a, "DELETE", &self.path, &Value::Null, 204);
    }
}

fn keyless(db: &Database, p: u16, a: &Account, who: &Account, id: &str, envelope: &EncryptedItem) {
    let sdk = who.sdk(p);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let before = state_hash(db, true);
    assert_eq!(
        rt.block_on(sdk.get_item(&a.box_id, id))
            .err()
            .unwrap()
            .status(),
        Some(403)
    );
    assert_eq!(
        rt.block_on(sdk.put_item(&a.box_id, id, 0, envelope))
            .err()
            .unwrap()
            .status(),
        Some(403)
    );
    assert_eq!(
        state_hash(db, true),
        before,
        "keyless SDK READ/WRITE denies without mutation"
    );
}
fn auth_matrix(db: &Database, p: u16, a: &Account, path: &str, body: &Value) {
    for (headers, status) in [
        (String::new(), 401),
        (format!("Authorization: Bearer {}\r\n", a.connect), 401),
        (format!("Cookie: passshare_session={}\r\n", a.session), 403),
    ] {
        let before = state_hash(db, true);
        assert_eq!(http(p, "PUT", path, &headers, body).0, status);
        assert_eq!(
            state_hash(db, true),
            before,
            "auth/CSRF failure retains state"
        );
    }
    let mut bad = body.clone();
    bad["unknown"] = json!(true);
    rejected(db, p, a, "PUT", path, &bad, 400);
}

fn check_table(
    db: &Database,
    table: &str,
    column: &str,
    selector: &str,
    valid: &Value,
    point: bool,
) {
    // Synthetic, direct SQL UPDATE attempts against an already valid owned row.
    // CHECK 23514 is the ONLY accepted exception; other errors fail the fixture.
    let mut cases = Vec::new();
    fn visit(value: &Value, path: &str, cases: &mut Vec<(String, Value)>) {
        if let Some(object) = value.as_object() {
            for (key, v) in object {
                let pointer = format!("{path}/{key}");
                cases.push((pointer.clone(), Value::Null));
                visit(v, &pointer, cases);
            }
        }
    }
    let mut edits = Vec::new();
    visit(valid, "", &mut edits);
    for (pointer, v) in edits {
        let mut bad = valid.clone();
        *bad.pointer_mut(&pointer).unwrap() = v;
        cases.push(bad);
        let mut missing = valid.clone();
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        missing
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        cases.push(missing);
    }
    for pointer in ["", "/context", "/wrapped", "/wrapped/context"] {
        if valid.pointer(pointer).is_some_and(Value::is_object) {
            let mut bad = valid.clone();
            bad.pointer_mut(pointer).unwrap()["unexpected"] = json!(true);
            cases.push(bad);
        }
    }
    for pointer in [
        "/enc",
        "/nonce",
        "/ciphertext",
        "/salt",
        "/wrapped/nonce",
        "/wrapped/ciphertext",
    ] {
        if let Some(text) = valid.pointer(pointer).and_then(Value::as_str) {
            let mut bad = valid.clone();
            *bad.pointer_mut(pointer).unwrap() = json!(format!(" {text}"));
            cases.push(bad);
        }
    }
    if point {
        let mut high = [0u8; 32];
        high[31] = 0x80;
        let mut p = [0xffu8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        for value in [high, p] {
            let mut bad = valid.clone();
            bad["enc"] = json!(BASE64.encode(value));
            cases.push(bad);
        }
    }
    let before = state_hash(db, true);
    for bad in cases {
        // Isolate the public CHECK from the separate BEFORE identity guard in
        // this synthetic transaction only. Otherwise malformed contexts reach
        // that guard's P0015 before the table's CHECK can be observed as 23514.
        let guard = if table == "encrypted_key_grants" {
            "ALTER TABLE encrypted_key_grants DISABLE TRIGGER passshare_grant_identity_guard;"
        } else {
            ""
        };
        let restore = if table == "encrypted_key_grants" {
            "ALTER TABLE encrypted_key_grants ENABLE TRIGGER passshare_grant_identity_guard;"
        } else {
            ""
        };
        db.sql(&format!("BEGIN; {guard} DO $$ BEGIN BEGIN UPDATE {table} SET {column}='{}'::jsonb WHERE {selector}; IF NOT FOUND THEN RAISE EXCEPTION 'synthetic valid row missing'; END IF; RAISE EXCEPTION 'synthetic invalid JSON accepted'; EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END; END $$; {restore} COMMIT;",sql_json(&bad)));
        assert_eq!(
            state_hash(db, true),
            before,
            "CHECK 23514 preserves every row/xmin"
        );
    }
}

fn legacy_fences(db: &Database, p: u16, a: &Account, b: &Account) {
    rejected(
        db,
        p,
        a,
        "DELETE",
        &format!("/api/auth/vaults/{}/members/{}", a.box_id, b.id),
        &Value::Null,
        409,
    );
    rejected(
        db,
        p,
        a,
        "POST",
        &format!("/api/auth/vaults/{}/ownership", a.box_id),
        &json!({"targetUserId":b.id,"currentPassword":a.login_password}),
        409,
    );
    rejected(
        db,
        p,
        b,
        "DELETE",
        "/api/auth/account",
        &json!({"confirmationEmail":b.email,"currentPassword":b.login_password}),
        409,
    );
}

struct Concurrent {
    headers: String,
    method: &'static str,
    path: String,
    body: Value,
    status: u16,
    sql_marker: &'static str,
}
fn observed_race(db: &Database, p: u16, a: &Account, rotation: &Rotation, op: Concurrent) {
    request_slot();
    request_slot();
    let marker = op.sql_marker;
    let intended_status = op.status;
    let table = match marker {
        "passshare_legacy_invite_accept" => "vault_memberships",
        "passshare_owner_key_operation" => "encrypted_owner_keys",
        _ => "encrypted_items",
    };
    // Synthetic observer only: a DEFERRED trigger captures the whole row/xmin
    // digest at the end of the intended formal mutation's transaction, while
    // it still owns the parent lock. Thus even a faulty commit that partially
    // writes then returns 409 cannot be mistaken for the intended mutation.
    db.sql(&format!("CREATE TABLE passshare1163_synthetic_race_capture(digest text,intended_pid integer); INSERT INTO passshare1163_synthetic_race_capture VALUES(NULL,NULL); CREATE FUNCTION passshare1163_synthetic_race_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF pg_backend_pid()=(SELECT intended_pid FROM passshare1163_synthetic_race_capture) THEN UPDATE passshare1163_synthetic_race_capture SET digest=({}); END IF; RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER passshare1163_synthetic_race_capture AFTER INSERT OR UPDATE OR DELETE ON {table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION passshare1163_synthetic_race_capture();",state_hash_sql(true)));
    let label = format!(
        "passshare1163-sharing-holder-{}",
        ConnectId::generate().unwrap()
    );
    let mut held = HeldBox::start(db, &a.box_id, &label);
    assert!(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"holder acquired parent lock");
    let first = thread::spawn(move || http(p, op.method, &op.path, &op.headers, &op.body));
    let waiting=format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='{label}' AND w.query LIKE '%{marker}%')");
    if !wait_db(db, &waiting) {
        held.commit();
        let _ = first.join();
        panic!("concurrent formal operation did not actually wait");
    }
    let headers = a.headers();
    let path = format!("{}/commit", rotation.path);
    let body = json!({"currentPassword":a.login_password});
    let commit = thread::spawn(move || http(p, "POST", &path, &headers, &body));
    // Observe the actual FIFO soft blocker as well as the holder. No fixed
    // sleep can establish that the intended concurrent operation runs first.
    let ordered=format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity c JOIN pg_stat_activity w ON w.pid=ANY(pg_blocking_pids(c.pid)) WHERE c.query LIKE '%passshare_sharing_operation(%' AND w.query LIKE '%{marker}%' AND cardinality(pg_blocking_pids(w.pid))>0)");
    if !wait_db(db, &ordered) {
        held.commit();
        let _ = first.join();
        let _ = commit.join();
        panic!("commit not observed queued behind independent formal mutation");
    }
    db.sql(&format!("UPDATE passshare1163_synthetic_race_capture SET intended_pid=(SELECT w.pid FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='{label}' AND w.query LIKE '%{marker}%' LIMIT 1)"));
    assert_eq!(
        db.sql("SELECT intended_pid IS NOT NULL FROM passshare1163_synthetic_race_capture"),
        "t",
        "observer bound to the actual waiting transaction backend"
    );
    held.commit();
    assert_eq!(
        first.join().unwrap().0,
        intended_status,
        "intended concurrent operation succeeded"
    );
    let (status, reply) = commit.join().unwrap();
    assert_eq!(status, 409);
    assert!(
        reply["message"]
            .as_str()
            .is_some_and(|m| m.contains("snapshot") || m.contains("Snapshot")),
        "stale snapshot is the rejection, not missing stages"
    );
    assert_eq!(
        call(p, a, "GET", &rotation.path, &Value::Null, 200)["status"],
        "pending"
    );
    let expected = db.sql("SELECT digest FROM passshare1163_synthetic_race_capture");
    assert!(
        !expected.is_empty(),
        "observer ran at intended operation commit"
    );
    assert_eq!(
        state_hash(db, true),
        expected,
        "stale commit preserves exact state following only intended concurrent operation"
    );
    db.sql(&format!("DROP TRIGGER passshare1163_synthetic_race_capture ON {table}; DROP FUNCTION passshare1163_synthetic_race_capture(); DROP TABLE passshare1163_synthetic_race_capture;"));
}

fn waiting_reauthentication(db: &Database, p: u16, a: &Account, rotation: &Rotation, b: &Account) {
    for credential_change in [false, true] {
        let (status, login) = http(
            p,
            "POST",
            "/api/auth/login",
            "x-passshare-client: mobile\r\n",
            &json!({"email":a.email,"password":a.login_password}),
        );
        assert_eq!(status, 200);
        let token = text_field(&login, "refreshToken");
        let session_id = db.sql(&format!(
            "SELECT id::text FROM sessions WHERE user_id='{}' ORDER BY created_at DESC LIMIT 1",
            a.id
        ));
        assert_eq!(
            http(
                p,
                "GET",
                &rotation.path,
                &format!("Authorization: Bearer {token}\r\n"),
                &Value::Null
            )
            .0,
            200
        );
        let before = state_hash(db, true);
        let label = format!(
            "passshare1163-sharing-auth-holder-{}",
            ConnectId::generate().unwrap()
        );
        let mut held = HeldBox::start(db, &a.box_id, &label);
        assert!(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")));
        let headers = format!("Authorization: Bearer {token}\r\n");
        let path = format!("{}/commit", rotation.path);
        let body = json!({"currentPassword":a.login_password});
        let worker = thread::spawn(move || http(p, "POST", &path, &headers, &body));
        let observed=wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='{label}' AND w.query LIKE '%passshare_sharing_operation(%')"));
        if !observed {
            held.commit();
            let _ = worker.join();
            panic!("commit must actually wait before synthetic session/credential fault");
        }
        // Credential hashes remain INSIDE SQL: neither fetching nor logging them.
        if credential_change {
            // A named, invocation-owned table holds the original only long enough
            // for this synthetic fault. It is dropped immediately after restore.
            db.sql(&format!("CREATE TABLE passshare1163_synthetic_credential_restore AS SELECT id,password_hash FROM users WHERE id='{}'; UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE id='{}') WHERE id='{}';",a.id,b.id,a.id));
            assert_eq!(
                db.sql(&format!(
                    "SELECT count(*) FROM sessions WHERE id='{session_id}'"
                )),
                "1",
                "same session retained during credential fault"
            );
        } else {
            db.sql(&format!("DELETE FROM sessions WHERE id='{session_id}'"));
        }
        held.commit();
        let (status, reply) = worker.join().unwrap();
        assert_eq!(status, 401);
        assert_eq!(
            reply["error"],
            if credential_change { "PS026" } else { "PS024" }
        );
        assert_eq!(
            state_hash(db, true),
            before,
            "wait-time rejection preserves whole box and pending stage"
        );
        if credential_change {
            assert_eq!(
                http(
                    p,
                    "GET",
                    &rotation.path,
                    &format!("Authorization: Bearer {token}\r\n"),
                    &Value::Null
                )
                .0,
                200,
                "same session remains live"
            );
            db.sql("UPDATE users u SET password_hash=r.password_hash FROM passshare1163_synthetic_credential_restore r WHERE u.id=r.id; DROP TABLE passshare1163_synthetic_credential_restore;");
        }
    }
}

pub(super) fn run_legacy_expiry(db: &Database, network: &Network, mode: &Mode) {
    let host = Host::start(db, network, mode);
    let (b, d) = (Account::signup(host.port), Account::signup(host.port));
    assert_eq!(db.sql("SELECT count(*) FROM users"), "2");
    legacy_expiry::run(db, host.port, &b, &d);
    call(
        host.port,
        &b,
        "DELETE",
        "/api/auth/account",
        &json!({"currentPassword":b.login_password,"confirmationEmail":b.email}),
        204,
    );
    assert_eq!(
        db.sql(&format!("SELECT count(*) FROM users WHERE id='{}'", b.id)),
        "0"
    );
    println!("legacy expiry isolated acceptance passed: real token/failure-row waits, expired 401 with complete rollback, live removal/transfer controls, ownership restoration and final retirement");
}

pub(super) fn run(db: &Database, network: &Network, mode: &Mode) {
    let mut host = Host::start(db, network, mode);
    let mut p = host.port;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    // Exactly four real registrations; no shadow account or signup-quota bypass.
    let a = Account::signup(p);
    let b = Account::signup(p);
    let c = Account::signup(p);
    let d = Account::signup(p);
    let accounts = [&a, &b, &c, &d];
    assert_eq!(db.sql("SELECT count(*) FROM users"), "4");
    let key = checked(PasswordBoxKey::generate(), "old box key");
    let setup_bundle = owner_bundle(&key, &a.master, a.salt, &owner_context(&a.box_id, &a.id, 1));
    let setup_path = format!("{}/setup", root(&a));
    for (headers, status) in [
        (String::new(), 401),
        (format!("Authorization: Bearer {}\r\n", a.connect), 401),
        (format!("Cookie: passshare_session={}\r\n", a.session), 403),
    ] {
        let before = state_hash(db, true);
        assert_eq!(
            http(
                p,
                "POST",
                &setup_path,
                &headers,
                &json!({"bundle":setup_bundle})
            )
            .0,
            status
        );
        assert_eq!(state_hash(db, true), before);
    }
    rejected(
        db,
        p,
        &a,
        "POST",
        &setup_path,
        &json!({"bundle":setup_bundle,"unknown":true}),
        400,
    );
    call(
        p,
        &a,
        "POST",
        &setup_path,
        &json!({"bundle":setup_bundle}),
        200,
    );
    exact_replay(
        db,
        p,
        &a,
        "POST",
        &setup_path,
        &json!({"bundle":setup_bundle}),
    );
    rejected(
        db,
        p,
        &a,
        "POST",
        &setup_path,
        &json!({"bundle":owner_bundle(&key,&a.master,a.salt,&owner_context(&a.box_id,&a.id,1))}),
        409,
    );
    accept(p, &b, &invite(p, &a, &b));
    accept(p, &c, &invite(p, &a, &c));
    let d_invitation = invite(p, &a, &d); // Formal acceptance becomes a concrete race.
    let sdk_b = b.sdk(p);
    assert_eq!(
        rt.block_on(sdk_b.get_account_identity(b.identity.context(), &b.pin.key_id))
            .err()
            .unwrap()
            .status(),
        Some(404)
    );
    let sentinel = format!("synthetic-dto-{}", ConnectId::generate().unwrap());
    let probe_id = ConnectId::generate().unwrap().to_string();
    let probe = checked(
        key.encrypt_item(
            &dto(&a, &probe_id, 3, &sentinel),
            &context(&a, &probe_id, 1, 1),
        ),
        "keyless probe",
    );
    keyless(db, p, &a, &b, &probe_id, &probe);
    for account in accounts {
        account.register(p, &rt);
    }
    let sdk_a = a.sdk(p);
    let sdk_c = c.sdk(p);
    for recipient in [&b, &c] {
        assert!(
            checked(
                rt.block_on(sdk_a.get_member_identity(&a.box_id, &recipient.pin)),
                "SDK pinned real HTTP peer"
            ) == recipient.pin
        );
        assert!(
            checked(
                rt.block_on(recipient.sdk(p).get_member_identity(&a.box_id, &a.pin)),
                "SDK independently pinned sender"
            ) == a.pin
        );
        let replacement = checked(
            AccountIdentity::generate(recipient.identity.context().clone()),
            "wrong but valid self-consistent descriptor",
        );
        assert!(
            matches!(
                rt.block_on(sdk_a.get_member_identity(&a.box_id, &replacement.public_identity())),
                Err(EncryptedSessionError::ContextMismatch)
            ),
            "real HTTP peer rejects independently wrong valid pin"
        );
    }
    let grant_b = grant(&key, &a, &b, 1);
    let grant_c = grant(&key, &a, &c, 1);
    for (recipient, sealed) in [(&b, &grant_b), (&c, &grant_c)] {
        let body = json!({"expectedStateRevision":snapshot(p,&a)["stateRevision"],"keyEpoch":1,"expectedVersion":0,"envelope":sealed});
        let path = format!("{}/grants/{}", root(&a), recipient.id);
        auth_matrix(db, p, &a, &path, &body);
        call(p, &a, "PUT", &path, &body, 200);
        sharing_sdk::initial_replay(db, &rt, &sdk_a, &a, recipient, &body);
        let mut changed = body.clone();
        changed["envelope"] = grant(&key, &a, recipient, 1);
        rejected(db, p, &a, "PUT", &path, &changed, 409);
        assert_eq!(
            http_bytes(
                p,
                "GET",
                &format!("{}/grants/{}", root(&a), a.id),
                &recipient.headers(),
                &Value::Null
            )
            .0,
            404,
            "only own grant lookup exists"
        );
    }
    // Arbitrary outsider UUID without fifth signup: all public fields remain
    // shaped correctly; no corresponding account/membership is created.
    let fake = operation_id(db);
    let mut outsider = grant_b.clone();
    outsider["context"]["recipientAccountId"] = json!(fake);
    let fake_body = json!({"expectedStateRevision":snapshot(p,&a)["stateRevision"],"keyEpoch":1,"expectedVersion":0,"envelope":outsider});
    let before = state_hash(db, true);
    let status = http(
        p,
        "PUT",
        &format!("{}/grants/{fake}", root(&a)),
        &a.headers(),
        &fake_body,
    )
    .0;
    assert!(
        [403, 404].contains(&status),
        "nonmember grant rejected as authorization/not-found"
    );
    assert_eq!(state_hash(db, true), before);
    let b_key = own_grant(&rt, &sdk_b, &a, &b, 1);
    let c_key = own_grant(&rt, &sdk_c, &a, &c, 1);
    rejected(
        db,
        p,
        &a,
        "DELETE",
        &format!("{}/grants/{}", root(&a), b.id),
        &Value::Null,
        409,
    );
    let mut items = BTreeMap::new();
    let mut encrypted_bytes = 0;
    for ordinal in 0..101 {
        let id = ConnectId::generate().unwrap().to_string();
        let value = dto(&a, &id, ordinal, &sentinel);
        assert!(
            value.to_string().len() < 1024 * 1024,
            "single plaintext below Core 1MiB"
        );
        let sealed = checked(
            key.encrypt_item(&value, &context(&a, &id, 1, 1)),
            "complete DTO encrypt",
        );
        let bytes = json!({"expectedVersion":0,"envelope":sealed})
            .to_string()
            .len();
        assert!(
            bytes < 2 * 1024 * 1024,
            "single native/HTTP body below 2MiB"
        );
        encrypted_bytes += bytes;
        let stored = checked(
            rt.block_on(sdk_b.put_item(&a.box_id, &id, 0, &sealed)),
            "B real Rust SDK write",
        );
        let own_read = checked(
            rt.block_on(sdk_b.get_item(&a.box_id, &id)),
            "B real Rust SDK own read",
        );
        assert!(own_read == stored);
        let fetched = checked(
            rt.block_on(sdk_c.get_item(&a.box_id, &id)),
            "C real Rust SDK read",
        );
        assert!(
            stored == fetched
                && checked(
                    c_key.decrypt_item(&fetched, &context(&a, &id, 1, 1)),
                    "C whole DTO decrypt"
                ) == value
        );
        assert!(
            checked(
                b_key.decrypt_item(&stored, &context(&a, &id, 1, 1)),
                "B whole DTO decrypt"
            ) == value
        );
        items.insert(id, value);
    }
    assert!(encrypted_bytes > 2 * 1024 * 1024 && items.len() > 100);
    let tomb_id = ConnectId::generate().unwrap().to_string();
    let tomb_dto = dto(&a, &tomb_id, 102, &sentinel);
    let tomb_envelope = checked(
        key.encrypt_item(&tomb_dto, &context(&a, &tomb_id, 1, 1)),
        "tombstone item encrypt",
    );
    checked(
        rt.block_on(sdk_a.put_item(&a.box_id, &tomb_id, 0, &tomb_envelope)),
        "create tombstone fixture",
    );
    checked(
        rt.block_on(sdk_a.delete_item(&a.box_id, &tomb_id, 1, 1)),
        "formal tombstone deletion",
    );
    let tomb_before=db.sql(&format!("SELECT md5(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)::text) FROM encrypted_item_tombstones t WHERE box_id='{}' AND item_id='{tomb_id}'",a.box_id));
    legacy_fences(db, p, &a, &b);
    // ONE new key at epoch 2, reused across independent failed operation IDs.
    let new_key = checked(PasswordBoxKey::generate(), "one new epoch-2 key");
    let new_bundle = owner_bundle(
        &new_key,
        &a.master,
        a.salt,
        &owner_context(&a.box_id, &a.id, 2),
    );
    let new_c_grant = grant(&new_key, &a, &c, 2);

    // First independent race: real proof-confirmed D acceptance invalidates R.
    let rotation = Rotation::prepare(db, p, &a, &b, &key, &new_key, &new_bundle, &items);
    rotation.start(p, &a);
    rotation.stage_items(p, &a, false);
    rotation.stage_grant(p, &a, &c, &new_c_grant);
    observed_race(
        db,
        p,
        &a,
        &rotation,
        Concurrent {
            headers: d.headers(),
            method: "POST",
            path: format!(
                "/api/auth/invitations/{}/accept",
                text_field(&d_invitation, "id")
            ),
            body: json!({"confirmationCode":d_invitation["confirmationCode"]}),
            status: 200,
            sql_marker: "passshare_legacy_invite_accept",
        },
    );
    rotation.abort(p, &a);
    assert!(
        checked(
            rt.block_on(sdk_a.get_member_identity(&a.box_id, &d.pin)),
            "confirmed D pinned identity"
        ) == d.pin
    );
    keyless(db, p, &a, &d, &probe_id, &probe);
    call(
        p,
        &d,
        "GET",
        &format!("{}/grants/me", root(&a)),
        &Value::Null,
        404,
    );

    // Four further independent formal mutations exercise each invalidator.
    let edit_id = items.keys().next().unwrap().clone();
    let extra_id = ConnectId::generate().unwrap().to_string();
    for kind in ["edit", "create", "delete", "owner-rewrap"] {
        let rotation = Rotation::prepare(db, p, &a, &b, &key, &new_key, &new_bundle, &items);
        rotation.start(p, &a);
        rotation.stage_items(p, &a, false);
        rotation.stage_grant(p, &a, &c, &new_c_grant);
        let mut changed = None;
        let op = match kind {
            "edit" => {
                let mut value = items[&edit_id].clone();
                let previous = number(&value, "version");
                value["version"] = json!(previous + 1);
                value["extra"]["concurrentEdit"] = json!(true);
                let envelope = checked(
                    key.encrypt_item(&value, &context(&a, &edit_id, previous + 1, 1)),
                    "concurrent edit encrypt",
                );
                changed = Some(value);
                Concurrent {
                    headers: c.headers(),
                    method: "PUT",
                    path: format!("{}/items/{edit_id}", root(&a)),
                    body: json!({"expectedVersion":previous,"envelope":envelope}),
                    status: 200,
                    sql_marker: "passshare_encrypted_operation",
                }
            }
            "create" => {
                let value = dto(&a, &extra_id, 105, &sentinel);
                let envelope = checked(
                    key.encrypt_item(&value, &context(&a, &extra_id, 1, 1)),
                    "concurrent create encrypt",
                );
                changed = Some(value);
                Concurrent {
                    headers: c.headers(),
                    method: "PUT",
                    path: format!("{}/items/{extra_id}", root(&a)),
                    body: json!({"expectedVersion":0,"envelope":envelope}),
                    status: 200,
                    sql_marker: "passshare_encrypted_operation",
                }
            }
            "delete" => Concurrent {
                headers: c.headers(),
                method: "DELETE",
                path: format!("{}/items/{extra_id}", root(&a)),
                body: json!({"expectedVersion":1,"keyEpoch":1}),
                status: 204,
                sql_marker: "passshare_encrypted_operation",
            },
            _ => {
                let fetched = checked(
                    rt.block_on(
                        sdk_a.get_owner_key(&a.box_id, &owner_context(&a.box_id, &a.id, 1)),
                    ),
                    "current owner bundle for race",
                );
                Concurrent {
                    headers: a.headers(),
                    method: "PUT",
                    path: format!("{}/owner-key", root(&a)),
                    body: json!({"expectedVersion":fetched.bundle_version,"bundle":owner_bundle(&key,&a.master,a.salt,&owner_context(&a.box_id,&a.id,1)),"currentPassword":a.login_password}),
                    status: 200,
                    sql_marker: "passshare_owner_key_operation",
                }
            }
        };
        observed_race(db, p, &a, &rotation, op);
        let revision = number(&rotation.snapshot, "stateRevision");
        rejected(
            db,
            p,
            &a,
            "GET",
            &format!("{}/sharing-snapshot/items?revision={revision}", root(&a)),
            &Value::Null,
            409,
        );
        rejected(
            db,
            p,
            &a,
            "GET",
            &format!("{}/sharing-snapshot/members?revision={revision}", root(&a)),
            &Value::Null,
            409,
        );
        rejected(
            db,
            p,
            &a,
            "GET",
            &format!(
                "{}/sharing-snapshot/items/{edit_id}?revision={revision}",
                root(&a)
            ),
            &Value::Null,
            409,
        );
        rotation.abort(p, &a);
        match kind {
            "edit" => {
                items.insert(edit_id.clone(), changed.unwrap());
            }
            "create" => {
                items.insert(extra_id.clone(), changed.unwrap());
            }
            "delete" => {
                items.remove(&extra_id);
            }
            _ => {}
        }
    }

    // Complete fresh operation, with exact immutable-stage replay and all
    // completeness negatives performed before the final successful commit.
    let rotation = Rotation::prepare(db, p, &a, &b, &key, &new_key, &new_bundle, &items);
    assert_eq!(number(&rotation.snapshot, "memberCount"), 4);
    assert_eq!(number(&rotation.snapshot, "grantCount"), 2);
    sharing_sdk::snapshot_reads(db, &rt, &sdk_a, &a, [&b, &c, &d], &rotation, &key, &items);
    let live_before = state_hash(db, false);
    auth_matrix(db, p, &a, &rotation.path, &rotation.header);
    rotation.start(p, &a);
    sharing_sdk::start_replay(db, &rt, &sdk_a, &rotation);
    let mut changed_header = rotation.header.clone();
    changed_header["bundle"] = owner_bundle(
        &new_key,
        &a.master,
        a.salt,
        &owner_context(&a.box_id, &a.id, 2),
    );
    rejected(db, p, &a, "PUT", &rotation.path, &changed_header, 409);
    rotation.stage_items(p, &a, true);
    rotation.stage_grant(p, &a, &c, &new_c_grant);
    rejected(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", rotation.path),
        &json!({"currentPassword":a.login_password}),
        409,
    );
    let (last_id, last) = rotation.candidates.last_key_value().unwrap();
    let item_path = format!("{}/items/{last_id}", rotation.path);
    let item_body = json!({"expectedVersion":last.previous,"envelope":last.envelope});
    call(p, &a, "PUT", &item_path, &item_body, 200);
    sharing_sdk::item_replay(db, &rt, &sdk_a, &rotation, last);
    let mut changed_item = item_body.clone();
    changed_item["envelope"] = json!(checked(
        new_key.encrypt_item(&last.expected, &context(&a, last_id, last.previous + 1, 2)),
        "changed duplicate stage"
    ));
    rejected(db, p, &a, "PUT", &item_path, &changed_item, 409);
    let mut wrong_epoch = item_body.clone();
    wrong_epoch["envelope"] = json!(checked(
        key.encrypt_item(&last.expected, &context(&a, last_id, last.previous + 1, 1)),
        "otherwise valid old-epoch stage envelope"
    ));
    rejected(db, p, &a, "PUT", &item_path, &wrong_epoch, 400);
    let extra = ConnectId::generate().unwrap().to_string();
    let mut extra_dto = dto(&a, &extra, 110, &sentinel);
    extra_dto["version"] = json!(2);
    let extra_envelope = checked(
        new_key.encrypt_item(&extra_dto, &context(&a, &extra, 2, 2)),
        "extra stage encrypt",
    );
    rejected(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{extra}", rotation.path),
        &json!({"expectedVersion":1,"envelope":extra_envelope}),
        409,
    );
    for target in [&b, &d] {
        rejected(
            db,
            p,
            &a,
            "PUT",
            &format!("{}/grants/{}", rotation.path, target.id),
            &json!({"envelope":grant(&new_key,&a,target,2)}),
            409,
        );
    }
    let grant_path = format!("{}/grants/{}", rotation.path, c.id);
    sharing_sdk::grant_replay(db, &rt, &sdk_a, &a, &c, &rotation, &new_c_grant);
    sharing_sdk::pending_status(db, &rt, &sdk_a, &rotation);
    rejected(
        db,
        p,
        &a,
        "PUT",
        &grant_path,
        &json!({"envelope":grant(&new_key,&a,&c,2)}),
        409,
    );
    assert_eq!(
        state_hash(db, false),
        live_before,
        "all staging leaves every live row/xmin intact"
    );
    // Omit-C separately on a fully populated new operation; do not hide its
    // rejection behind a missing item or a stale revision.
    sharing_sdk::abort_pending(db, &rt, &sdk_a, &rotation);
    let without_c = Rotation::prepare(db, p, &a, &b, &key, &new_key, &new_bundle, &items);
    without_c.start(p, &a);
    without_c.stage_items(p, &a, false);
    rejected(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", without_c.path),
        &json!({"currentPassword":a.login_password}),
        409,
    );
    without_c.stage_grant(p, &a, &c, &new_c_grant);
    let rotation = without_c;
    check_table(
        db,
        "encrypted_key_grants",
        "envelope",
        &format!("box_id='{}' AND recipient_id='{}'", a.box_id, c.id),
        &grant_c,
        true,
    );
    check_table(
        db,
        "encrypted_rotation_grants",
        "envelope",
        &format!("box_id='{}' AND recipient_id='{}'", a.box_id, c.id),
        &new_c_grant,
        true,
    );
    check_table(
        db,
        "encrypted_owner_keys",
        "bundle",
        &format!("box_id='{}' AND owner_id='{}'", a.box_id, a.id),
        &setup_bundle,
        false,
    );
    let (id, candidate) = rotation.candidates.first_key_value().unwrap();
    let current = checked(
        rt.block_on(sdk_a.get_item(&a.box_id, id)),
        "existing valid row for CHECK fixture",
    );
    check_table(
        db,
        "encrypted_items",
        "envelope",
        &format!("box_id='{}' AND item_id='{id}'", a.box_id),
        &json!(current),
        false,
    );
    check_table(
        db,
        "encrypted_rotation_items",
        "envelope",
        &format!("box_id='{}' AND item_id='{id}'", a.box_id),
        &json!(candidate.envelope),
        false,
    );
    let before_restart = state_hash(db, true);
    let pending = call(p, &a, "GET", &rotation.path, &Value::Null, 200);
    drop(host);
    host = Host::start(db, network, mode);
    p = host.port;
    assert!(
        call(p, &a, "GET", &rotation.path, &Value::Null, 200) == pending,
        "pending stage survives actual host restart"
    );
    assert_eq!(
        state_hash(db, true),
        before_restart,
        "restart preserves all live/stage rows"
    );
    let commit_path = format!("{}/commit", rotation.path);
    for (headers, status) in [
        (String::new(), 401),
        (format!("Authorization: Bearer {}\r\n", a.connect), 401),
        (format!("Cookie: passshare_session={}\r\n", a.session), 403),
    ] {
        let before = state_hash(db, true);
        assert_eq!(
            http(
                p,
                "POST",
                &commit_path,
                &headers,
                &json!({"currentPassword":a.login_password})
            )
            .0,
            status
        );
        assert_eq!(
            state_hash(db, true),
            before,
            "formal commit authentication/CSRF does not mutate live/staged state"
        );
    }
    rejected(db, p, &a, "POST", &commit_path, &json!({}), 401);
    rejected(
        db,
        p,
        &a,
        "POST",
        &commit_path,
        &json!({"currentPassword":a.login_password,"unknown":true}),
        400,
    );
    rejected(
        db,
        p,
        &a,
        "POST",
        &commit_path,
        &json!({"currentPassword":format!("wrong-{}",ConnectId::generate().unwrap())}),
        401,
    );
    waiting_reauthentication(db, p, &a, &rotation, &b);
    // Synthetic owned AFTER triggers: fail after real writes, NEVER update and
    // RETURN an error that would accidentally commit partial business changes.
    for (table, event, condition, sqlstate) in [
        (
            "encrypted_items",
            "UPDATE",
            format!("NEW.box_id='{}'", a.box_id),
            "P1161",
        ),
        (
            "vault_memberships",
            "DELETE",
            format!("OLD.vault_id='{}' AND OLD.user_id='{}'", a.box_id, b.id),
            "P1162",
        ),
    ] {
        db.sql(&format!("CREATE FUNCTION passshare1163_synthetic_rotation_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF {condition} THEN RAISE EXCEPTION USING ERRCODE='{sqlstate}',MESSAGE='owned synthetic rotation rollback fault'; END IF; RETURN NULL; END $$; CREATE TRIGGER passshare1163_synthetic_rotation_fault AFTER {event} ON {table} FOR EACH ROW EXECUTE FUNCTION passshare1163_synthetic_rotation_fault();"));
        let reply = rejected(
            db,
            p,
            &a,
            "POST",
            &commit_path,
            &json!({"currentPassword":a.login_password}),
            503,
        );
        assert_eq!(reply["error"], "PS019");
        assert!(
            !reply.to_string().contains(sqlstate),
            "internal SQL fault must not escape API"
        );
        db.sql(&format!("DROP TRIGGER passshare1163_synthetic_rotation_fault ON {table}; DROP FUNCTION passshare1163_synthetic_rotation_fault();"));
    }
    let old_sdk = b.sdk(p);
    let old_envelope = checked(
        rt.block_on(old_sdk.get_item(&a.box_id, &edit_id)),
        "B can still formally read while rotation remains pending",
    );
    let old_expected = items[&edit_id].clone();
    let old_version = number(&old_expected, "version");
    let result = call(
        p,
        &a,
        "POST",
        &commit_path,
        &json!({"currentPassword":a.login_password}),
        200,
    );
    assert_eq!(result["status"], "committed");
    assert_eq!(number(&result, "keyEpoch"), 2);
    assert_eq!(result["removedAccountId"], b.id);
    let sdk_a = a.sdk(p);
    sharing_sdk::committed_status(db, &rt, &sdk_a, &rotation, &result);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_rotation_items WHERE box_id='{}')+(SELECT count(*) FROM encrypted_rotation_grants WHERE box_id='{}')",a.box_id,a.box_id)),"0","committed staging ciphertext removed");
    assert_eq!(db.sql(&format!("SELECT bool_and(header IS NULL AND staged_bytes=0 AND result IS NOT NULL) FROM encrypted_rotations WHERE box_id='{}' AND status='committed'",a.box_id)),"t","committed header bundle removed; only history remains");
    let new_snapshot = snapshot(p, &a);
    assert_eq!(number(&new_snapshot, "keyEpoch"), 2);
    assert_eq!(number(&new_snapshot, "memberCount"), 3);
    assert_eq!(number(&new_snapshot, "grantCount"), 1);
    assert_eq!(number(&new_snapshot, "liveItemCount"), 101);
    assert_eq!(
        number(&new_snapshot, "ownerBundleVersion"),
        number(&rotation.snapshot, "ownerBundleVersion") + 1
    );
    assert_eq!(
        number(&new_snapshot, "stateRevision"),
        number(&result, "stateRevision")
    );
    let final_members = call(
        p,
        &a,
        "GET",
        &format!(
            "{}/sharing-snapshot/members?revision={}",
            root(&a),
            number(&new_snapshot, "stateRevision")
        ),
        &Value::Null,
        200,
    );
    let members = final_members["members"].as_array().unwrap();
    assert!(members
        .iter()
        .all(|m| m["membershipConfirmed"] == true && m["accountId"] != b.id));
    assert!(members
        .iter()
        .any(|m| m["accountId"] == c.id && m["keyGranted"] == true));
    assert!(members
        .iter()
        .any(|m| m["accountId"] == d.id && m["keyGranted"] == false));
    let committed_hash = state_hash(db, true);
    // Reuse the post-restart transport, original session and persistent reactor.
    let historical = sharing_sdk::committed_replay(db, &rt, &sdk_a, &a, &rotation, &result);
    assert!(
        historical == result,
        "recorded historical result returned without writes"
    );
    assert_eq!(
        state_hash(db, true),
        committed_hash,
        "immediate whole DB historical replay hash"
    );
    let sdk_c = c.sdk(p);
    let fetched_owner = checked(
        rt.block_on(sdk_a.get_owner_key(&a.box_id, &owner_context(&a.box_id, &a.id, 2))),
        "fresh owner bundle from actual API",
    );
    let owner_json = json!(fetched_owner.bundle);
    let restored_a = checked(
        unwrap_bundle(
            &owner_json,
            &a.encryption_password,
            &owner_context(&a.box_id, &a.id, 2),
        ),
        "fresh A owner key unwrap",
    );
    let restored_c = own_grant(&rt, &sdk_c, &a, &c, 2);
    for (id, candidate) in &rotation.candidates {
        let fetched = checked(
            rt.block_on(sdk_c.get_item(&a.box_id, id)),
            "new C SDK item GET",
        );
        let expected_context = context(&a, id, candidate.previous + 1, 2);
        assert!(
            checked(
                restored_a.decrypt_item(&fetched, &expected_context),
                "A all rotated DTOs"
            ) == candidate.expected
        );
        assert!(
            checked(
                restored_c.decrypt_item(&fetched, &expected_context),
                "C all rotated DTOs"
            ) == candidate.expected
        );
        assert!(
            b_key.decrypt_item(&fetched, &expected_context).is_err(),
            "B retained old key cannot decrypt new epoch"
        );
    }
    assert!(
        checked(
            b_key.decrypt_item(&old_envelope, &context(&a, &edit_id, old_version, 1)),
            "B still decrypts previously retrieved envelope"
        ) == old_expected,
        "old ciphertext/key/plaintext are not recalled"
    );
    let b_sdk = b.sdk(p);
    assert_eq!(
        rt.block_on(b_sdk.get_item(&a.box_id, &edit_id))
            .err()
            .unwrap()
            .status(),
        Some(403)
    );
    rejected(
        db,
        p,
        &b,
        "GET",
        &format!("{}/grants/me", root(&a)),
        &Value::Null,
        403,
    );
    let (status, login) = http(
        p,
        "POST",
        "/api/auth/login",
        "x-passshare-client: mobile\r\n",
        &json!({"email":b.email,"password":b.login_password}),
    );
    assert_eq!(status, 200);
    let new_b = text_field(&login, "refreshToken");
    for path in [
        format!("{}/items/{edit_id}", root(&a)),
        format!("{}/grants/me", root(&a)),
    ] {
        assert_eq!(
            http(
                p,
                "GET",
                &path,
                &format!("Authorization: Bearer {new_b}\r\n"),
                &Value::Null
            )
            .0,
            403,
            "new B login gains no removed membership"
        );
    }
    let denied_candidate = &rotation.candidates[&edit_id];
    for headers in [b.headers(), format!("Authorization: Bearer {new_b}\r\n")] {
        let before = state_hash(db, true);
        assert_eq!(http(p,"PUT",&format!("{}/items/{edit_id}",root(&a)),&headers,&json!({"expectedVersion":denied_candidate.previous,"envelope":denied_candidate.envelope})).0,403,"B old/new session WRITE denied by removed membership");
        assert_eq!(state_hash(db, true), before);
    }
    keyless(db, p, &a, &d, &probe_id, &probe);
    call(
        p,
        &d,
        "GET",
        &format!("{}/grants/me", root(&a)),
        &Value::Null,
        404,
    );
    let mut later = rotation.candidates[&edit_id].expected.clone();
    let previous = number(&later, "version");
    later["version"] = json!(previous + 1);
    later["extra"]["laterUpdate"] = json!(true);
    let later_envelope = checked(
        restored_c.encrypt_item(&later, &context(&a, &edit_id, previous + 1, 2)),
        "later current-key edit",
    );
    checked(
        rt.block_on(sdk_c.put_item(&a.box_id, &edit_id, previous, &later_envelope)),
        "C SDK later write",
    );
    assert!(
        checked(
            restored_a.decrypt_item(
                &checked(
                    rt.block_on(sdk_a.get_item(&a.box_id, &edit_id)),
                    "A later GET"
                ),
                &context(&a, &edit_id, previous + 1, 2)
            ),
            "A later DTO decrypt"
        ) == later
    );
    assert!(b_key
        .decrypt_item(&later_envelope, &context(&a, &edit_id, previous + 1, 2))
        .is_err());
    let mut stale_dto = later.clone();
    stale_dto["version"] = json!(previous + 2);
    let stale = checked(
        key.encrypt_item(&stale_dto, &context(&a, &edit_id, previous + 2, 1)),
        "old C epoch write with CURRENT CAS version",
    );
    rejected(
        db,
        p,
        &c,
        "PUT",
        &format!("{}/items/{edit_id}", root(&a)),
        &json!({"expectedVersion":previous+1,"envelope":stale}),
        409,
    );
    for epoch in [1, 2] {
        let sealed = checked(
            if epoch == 1 {
                key.encrypt_item(&tomb_dto, &context(&a, &tomb_id, 1, epoch))
            } else {
                restored_a.encrypt_item(&tomb_dto, &context(&a, &tomb_id, 1, epoch))
            },
            "tombstone replay encryption",
        );
        rejected(
            db,
            p,
            &a,
            "PUT",
            &format!("{}/items/{tomb_id}", root(&a)),
            &json!({"expectedVersion":0,"envelope":sealed}),
            409,
        );
    }
    assert_eq!(db.sql(&format!("SELECT md5(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)::text) FROM encrypted_item_tombstones t WHERE box_id='{}' AND item_id='{tomb_id}'",a.box_id)),tomb_before,"old tombstone row/epoch/xmin unchanged");
    assert!(
        exact_replay(
            db,
            p,
            &a,
            "POST",
            &commit_path,
            &json!({"currentPassword":a.login_password})
        ) == result,
        "historical result after later edit does not claim current state"
    );
    assert!(
        sharing_sdk::committed_replay(db, &rt, &sdk_a, &a, &rotation, &result) == result,
        "SDK historical replay after later edit preserves the original result"
    );
    let disabled = Host::with_storage(db, network, mode, false);
    for path in [
        format!("{}/sharing-snapshot", root(&a)),
        format!("{}/grants/me", root(&a)),
        rotation.path.clone(),
    ] {
        assert_eq!(
            http_bytes(disabled.port, "GET", &path, &a.headers(), &Value::Null).0,
            404,
            "flag-off new route absent"
        );
    }
    legacy_fences(db, disabled.port, &a, &c);
    drop(disabled);
    // Formal retirement AFTER formal rotation removal; only B identity cascades.
    let retained=db.sql(&format!("SELECT md5(string_agg(jsonb_build_object('row',to_jsonb(i),'xmin',i.xmin::text)::text,'|' ORDER BY account_id)) FROM encrypted_account_identities i WHERE account_id IN ('{}','{}')",a.id,c.id));
    call(
        p,
        &b,
        "DELETE",
        "/api/auth/account",
        &json!({"currentPassword":b.login_password,"confirmationEmail":b.email}),
        204,
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_account_identities WHERE account_id='{}'",
            b.id
        )),
        "0"
    );
    assert_eq!(db.sql(&format!("SELECT md5(string_agg(jsonb_build_object('row',to_jsonb(i),'xmin',i.xmin::text)::text,'|' ORDER BY account_id)) FROM encrypted_account_identities i WHERE account_id IN ('{}','{}')",a.id,c.id)),retained);
    // Only known synthetic encryption passwords/DTO sentinel, never secret seeds
    // or real accounts. The SQL returns a count, never credential/ciphertext data.
    for sentinel in [
        a.encryption_password.as_str(),
        c.encryption_password.as_str(),
        sentinel.as_str(),
    ] {
        let escaped = sentinel.replace('\'', "''");
        assert_eq!(db.sql(&format!("SELECT count(*) FROM (SELECT to_jsonb(r)::text AS body FROM encrypted_items r UNION ALL SELECT to_jsonb(r)::text FROM encrypted_owner_keys r UNION ALL SELECT to_jsonb(r)::text FROM encrypted_key_grants r UNION ALL SELECT to_jsonb(r)::text FROM encrypted_account_identities r UNION ALL SELECT to_jsonb(r)::text FROM encrypted_rotations r) stored WHERE strpos(body,'{escaped}')>0")),"0","synthetic plaintext absent from encrypted tables");
    }
    drop(host);
    println!("sharing rotation formal acceptance passed: four signups, real invites/confirmation, SDK identity pins and HPKE Auth, 101 live full JSON DTOs (>2MiB), five DB-observed formal races (edit/create/delete/confirmation/owner rewrap), immutable staging/replay, missing/extra/wrong-epoch/grantee-set rejection, restart, synthetic CHECK/AFTER-trigger/session/credential faults, atomic B removal, fresh A/C decrypt-all, B old/new-token denial and old-ciphertext retention, keyless D, tombstones, flag-off fences and formal B retirement cascade");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_cli_preserves_host_modes_and_rejects_mixed_or_valued_flags_before_docker() {
        fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
            values.iter().map(|value| (*value).into()).collect()
        }
        for values in [
            vec!["--sharing-rotation", "native"],
            vec!["--sharing-rotation", "--image", "owned-image"],
        ] {
            let a = args(&values);
            let (identity, sharing, rest) = fixture_prefix(&a).unwrap();
            assert!(!identity && sharing);
            assert!(Mode::parse(rest).is_ok());
        }
        for values in [
            vec!["--sharing-rotation", "--account-identity", "native"],
            vec!["--go-session", "unused", "--sharing-rotation", "native"],
            vec!["--account-identity", "--go-session", "unused", "native"],
            vec!["native", "--sharing-rotation"],
            vec!["--sharing-rotation", "--sharing-rotation", "native"],
        ] {
            assert!(fixture_prefix(&args(&values)).is_err());
        }
        for values in [
            vec!["--sharing-rotation"],
            vec!["--sharing-rotation", "value", "native"],
            vec!["--sharing-rotation=value", "native"],
        ] {
            let a = args(&values);
            assert!(
                fixture_prefix(&a).is_err() || Mode::parse(fixture_prefix(&a).unwrap().2).is_err()
            );
        }
        for values in [
            vec!["native"],
            vec!["--image", "owned-image"],
            vec!["--account-identity", "native"],
        ] {
            let a = args(&values);
            let (identity, sharing, rest) = fixture_prefix(&a).unwrap();
            assert!(!sharing);
            assert_eq!(identity, values[0] == "--account-identity");
            assert!(Mode::parse(rest).is_ok());
        }
        let a = args(&["--go-session", "precompiled", "native"]);
        let (_, sharing, rest) = fixture_prefix(&a).unwrap();
        assert!(!sharing && rest == a.as_slice());
    }
}
