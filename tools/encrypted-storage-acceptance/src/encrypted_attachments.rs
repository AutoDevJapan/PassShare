//! Synthetic Core -> formal Node -> independent PostgreSQL -> Core acceptance.
//! Never uses a mock store, production account, new crypto or plaintext upload.
use super::*;
use passshare_core::cloud_crypto::{AttachmentContext, AttachmentPlaintext, EncryptedAttachment};
use std::sync::atomic::AtomicUsize;

static CHECKS: AtomicUsize = AtomicUsize::new(0);
fn check(ok: bool, label: &str) {
    assert!(ok, "attachment acceptance: {label}");
    CHECKS.fetch_add(1, Ordering::Relaxed);
}
fn send(p: u16, a: &Account, method: &str, path: &str, body: &Value, status: u16) -> Value {
    let v = call(p, a, method, path, body, status);
    CHECKS.fetch_add(1, Ordering::Relaxed);
    v
}
fn reject(db: &Database, p: u16, a: &Account, method: &str, path: &str, body: &Value, status: u16) {
    let before = state_hash(db, true);
    send(p, a, method, path, body, status);
    check(
        state_hash(db, true) == before,
        "rejection preserves every full live/staged row and xmin",
    );
}
fn replay(db: &Database, p: u16, a: &Account, method: &str, path: &str, body: &Value) -> Value {
    let before = state_hash(db, true);
    let v = send(p, a, method, path, body, 200);
    check(
        state_hash(db, true) == before,
        "exact replay preserves both resources, totals and xmin",
    );
    v
}
fn revision(db: &Database, a: &Account) -> u64 {
    db.sql(&format!(
        "SELECT state_revision FROM encrypted_box_state WHERE box_id='{}'",
        a.box_id
    ))
    .parse()
    .unwrap()
}
fn attach_context(a: &Account, item: &str, id: &str, v: u64, epoch: u64) -> AttachmentContext {
    checked(
        serde_json::from_value(
            json!({"passwordBoxId":a.box_id,"itemId":item,"attachmentId":id,"attachmentVersion":v,"keyEpoch":epoch}),
        ),
        "independently held attachment context",
    )
}
struct File {
    id: String,
    name: String,
    bytes: Vec<u8>,
    version: u64,
    sealed: Value,
}
impl File {
    fn new(key: &PasswordBoxKey, a: &Account, item: &str, name: &str, bytes: Vec<u8>) -> Self {
        let id = ConnectId::generate().unwrap().to_string();
        let sealed = seal(key, a, item, &id, name, &bytes, 1, 1);
        Self {
            id,
            name: name.to_owned(),
            bytes,
            version: 1,
            sealed,
        }
    }
    fn verify(&self, key: &PasswordBoxKey, a: &Account, item: &str, body: &Value, epoch: u64) {
        let envelope: EncryptedAttachment = checked(
            serde_json::from_value(body.clone()),
            "Core public attachment parse",
        );
        let plaintext = checked(
            key.decrypt_attachment(
                &envelope,
                &attach_context(a, item, &self.id, self.version, epoch),
            ),
            "Core attachment open",
        );
        check(
            plaintext.name() == self.name && plaintext.content() == self.bytes,
            "complete name and every original byte match",
        );
    }
}
#[allow(clippy::too_many_arguments)]
fn seal(
    key: &PasswordBoxKey,
    a: &Account,
    item: &str,
    id: &str,
    name: &str,
    bytes: &[u8],
    v: u64,
    epoch: u64,
) -> Value {
    let plain = checked(
        AttachmentPlaintext::new(name.to_owned(), bytes.to_vec()),
        "Core attachment plaintext",
    );
    json!(checked(
        key.encrypt_attachment(&plain, &attach_context(a, item, id, v, epoch)),
        "Core attachment seal"
    ))
}
fn path(a: &Account, item: &str, id: &str) -> String {
    format!("{}/items/{item}/attachments/{id}", root(a))
}
fn item_body(
    key: &PasswordBoxKey,
    a: &Account,
    item: &str,
    dto: &Value,
    v: u64,
    epoch: u64,
) -> Value {
    let dto = client_dto(dto, a, item, v);
    json!(checked(
        key.encrypt_item(&dto, &context(a, item, v, epoch)),
        "Core complete item seal"
    ))
}
fn client_dto(dto: &Value, a: &Account, item: &str, v: u64) -> Value {
    let mut result = dto.clone();
    result["id"] = json!(item);
    result["version"] = json!(v);
    result["vault"] = json!({"id":a.box_id});
    result
}
#[allow(clippy::too_many_arguments)] // Explicit client-held trust/CAS inputs.
fn mutation(
    db: &Database,
    key: &PasswordBoxKey,
    a: &Account,
    item: &str,
    dto: &Value,
    item_v: u64,
    file: &File,
    previous: u64,
) -> Value {
    json!({"expectedStateRevision":revision(db,a),"item":{"expectedVersion":item_v,"envelope":item_body(key,a,item,dto,item_v+1,1)},"expectedVersion":previous,"envelope":file.sealed})
}
fn references(
    dto: &Value,
    key: &PasswordBoxKey,
    a: &Account,
    item: &str,
    item_v: u64,
    epoch: u64,
    p: u16,
) {
    let body = send(
        p,
        a,
        "GET",
        &format!("{}/items/{item}", root(a)),
        &Value::Null,
        200,
    );
    let envelope = checked(serde_json::from_value(body), "Core item parse");
    let opened = checked(
        key.decrypt_item(&envelope, &context(a, item, item_v, epoch)),
        "Core item open",
    );
    check(
        opened == client_dto(dto, a, item, item_v),
        "entire ordered item DTO and authenticated references match",
    );
}
fn get_file(
    db: &Database,
    p: u16,
    a: &Account,
    item: &str,
    file: &File,
    key: &PasswordBoxKey,
    epoch: u64,
) -> Value {
    let body = send(
        p,
        a,
        "GET",
        &format!("{}?revision={}", path(a, item, &file.id), revision(db, a)),
        &Value::Null,
        200,
    );
    file.verify(key, a, item, &body, epoch);
    body
}
fn next_ref(file: &File, epoch: u64) -> Value {
    json!({"attachmentId":file.id,"attachmentVersion":file.version,"keyEpoch":epoch})
}
fn start(db: &Database, p: u16, a: &Account, b: &Account, new: &PasswordBoxKey) -> (String, Value) {
    let snap = send(
        p,
        a,
        "GET",
        &format!("{}/sharing-snapshot", root(a)),
        &Value::Null,
        200,
    );
    let epoch = number(&snap, "keyEpoch");
    let header = json!({"expectedStateRevision":snap["stateRevision"],"expectedKeyEpoch":epoch,"expectedOwnerBundleVersion":snap["ownerBundleVersion"],"removeAccountId":b.id,
        "bundle":owner_bundle(new,&a.master,a.salt,&owner_context(&a.box_id,&a.id,epoch+1))});
    let path = format!("{}/rotations/{}", root(a), operation_id(db));
    send(p, a, "PUT", &path, &header, 200);
    (path, header)
}
fn commit(p: u16, a: &Account, path: &str) -> Value {
    send(
        p,
        a,
        "POST",
        &format!("{path}/commit"),
        &json!({"currentPassword":a.login_password}),
        200,
    )
}
fn stage_files(
    p: u16,
    a: &Account,
    item: &str,
    rotation: &str,
    files: &[File],
    new: &PasswordBoxKey,
) -> Vec<Value> {
    files
        .iter()
        .map(|f| {
            let sealed = seal(new, a, item, &f.id, &f.name, &f.bytes, f.version + 1, 2);
            send(
                p,
                a,
                "PUT",
                &format!("{rotation}/items/{item}/attachments/{}", f.id),
                &json!({"expectedVersion":f.version,"envelope":sealed}),
                200,
            );
            sealed
        })
        .collect()
}
fn stage_item(
    p: u16,
    a: &Account,
    item: &str,
    v: u64,
    dto: &Value,
    new: &PasswordBoxKey,
    rotation: &str,
) -> Value {
    let mut next = dto.clone();
    next["attachments"]=json!(dto["attachments"].as_array().unwrap().iter().map(|r|json!({"attachmentId":r["attachmentId"],"attachmentVersion":r["attachmentVersion"].as_u64().unwrap()+1,"keyEpoch":2})).collect::<Vec<_>>());
    send(
        p,
        a,
        "PUT",
        &format!("{rotation}/items/{item}"),
        &json!({"expectedVersion":v,"envelope":item_body(new,a,item,&next,v+1,2)}),
        200,
    );
    next
}

pub(crate) fn run(db: &Database, network: &Network, mode: &Mode) {
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
    let d = Account::signup(p);
    for account in [&a, &b, &c, &d] {
        account.register(p, &rt);
    }
    let old = checked(PasswordBoxKey::generate(), "client box key");
    let new = checked(PasswordBoxKey::generate(), "client next box key");
    send(
        p,
        &a,
        "POST",
        &format!("{}/setup", root(&a)),
        &json!({"bundle":owner_bundle(&old,&a.master,a.salt,&owner_context(&a.box_id,&a.id,1))}),
        200,
    );
    accept(p, &b, &invite(p, &a, &b));
    accept(p, &c, &invite(p, &a, &c));
    let unconfirmed = invite(p, &a, &d);
    // Explicit synthetic unconfirmed membership exercises the DB's CURRENT
    // confirmation contract, independently of the HTTP invite adapter.
    db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES('{}','{}','member',NULL)",d.id,a.box_id));
    for recipient in [&b, &c] {
        send(
            p,
            &a,
            "PUT",
            &format!("{}/grants/{}", root(&a), recipient.id),
            &json!({"expectedStateRevision":revision(db,&a),"keyEpoch":1,"expectedVersion":0,"envelope":grant(&old,&a,recipient,1)}),
            200,
        );
    }
    let item = ConnectId::generate().unwrap().to_string();
    let mut item_v = 1;
    let mut dto = json!({"title":"synthetic attachment item","attachments":[],"unknown":{"ordered":[3,1,2]},"fields":[{"value":"synthetic-only"}]});
    send(
        p,
        &a,
        "PUT",
        &format!("{}/items/{item}", root(&a)),
        &json!({"expectedVersion":0,"envelope":item_body(&old,&a,&item,&dto,1,1)}),
        200,
    );
    let mut files = Vec::new();
    for (name, bytes) in [
        ("先頭-名前🦀.bin", vec![0xff, 0, 1, 0, 0xfe]),
        ("空\0Unicode", Vec::new()),
        ("third.txt", "本文\0éЖ🦀".as_bytes().to_vec()),
    ] {
        let f = File::new(&old, &a, &item, name, bytes);
        dto["attachments"]
            .as_array_mut()
            .unwrap()
            .push(next_ref(&f, 1));
        let body = mutation(db, &old, &a, &item, &dto, item_v, &f, 0);
        let endpoint = path(&a, &item, &f.id);
        let reply = send(p, &a, "PUT", &endpoint, &body, 200);
        check(
            reply["itemVersion"] == item_v + 1 && reply["attachmentVersion"] == 1,
            "independent item/attachment CAS",
        );
        check(
            replay(db, p, &a, "PUT", &endpoint, &body) == reply,
            "lost reply returns same public result",
        );
        let mut changed = body.clone();
        changed["expectedStateRevision"] = json!(revision(db, &a));
        reject(db, p, &a, "PUT", &endpoint, &changed, 409);
        changed = body.clone();
        changed["envelope"] = seal(&old, &a, &item, &f.id, &f.name, &f.bytes, 1, 1);
        reject(db, p, &a, "PUT", &endpoint, &changed, 409);
        item_v += 1;
        get_file(db, p, &a, &item, &f, &old, 1);
        files.push(f);
    }
    references(&dto, &old, &a, &item, item_v, 1, p);
    let attachment_rows=db.sql("SELECT md5(string_agg(to_jsonb(a)::text||a.xmin::text,'|' ORDER BY box_id,item_id,attachment_id)) FROM encrypted_attachments a");
    dto["title"] = json!("synthetic title edit");
    send(
        p,
        &a,
        "PUT",
        &format!("{}/items/{item}", root(&a)),
        &json!({"expectedVersion":item_v,"envelope":item_body(&old,&a,&item,&dto,item_v+1,1)}),
        200,
    );
    item_v += 1;
    check(db.sql("SELECT md5(string_agg(to_jsonb(a)::text||a.xmin::text,'|' ORDER BY box_id,item_id,attachment_id)) FROM encrypted_attachments a")==attachment_rows,"ordinary title edit never rewrites/deletes attachments");

    // Native AND SQL public-shape contract, including raw duplicate/float keys.
    let probe = File::new(&old, &a, &item, "never-uploaded-name", vec![0xff, 0]);
    let good = mutation(db, &old, &a, &item, &dto, item_v, &probe, 0);
    let endpoint = path(&a, &item, &probe.id);
    for (pointer, value) in [
        ("/envelope/contentBytes", json!(1_048_577)),
        ("/envelope/context/attachmentId", json!(files[0].id)),
        ("/envelope/context/keyEpoch", json!(2)),
        ("/expectedVersion", json!(9_007_199_254_740_992u64)),
        ("/item/expectedVersion", json!(item_v - 1)),
    ] {
        let mut bad = good.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        reject(db, p, &a, "PUT", &endpoint, &bad, 400);
    }
    for pointer in ["/envelope", "/envelope/context", "/item", "/item/envelope"] {
        let mut bad = good.clone();
        bad.pointer_mut(pointer).unwrap()["name"] = json!("forbidden");
        reject(db, p, &a, "PUT", &endpoint, &bad, 400);
    }
    for raw in [
        good.to_string()
            .replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
        good.to_string()
            .replacen("\"format\":1", "\"format\":1.0", 1),
    ] {
        let before = state_hash(db, true);
        request_slot();
        let (status, _) = http_payload(p, "PUT", &endpoint, &a.headers(), &raw);
        check(
            status == 400 && state_hash(db, true) == before,
            "raw duplicate or lexical float rejected before normalization",
        );
    }
    reject(db, p, &d, "PUT", &endpoint, &good, 403);
    db.sql(&format!(
        "UPDATE vault_memberships SET role='readonly' WHERE vault_id='{}' AND user_id='{}'",
        a.box_id, c.id
    ));
    let mut current = good.clone();
    current["expectedStateRevision"] = json!(revision(db, &a));
    reject(db, p, &c, "PUT", &endpoint, &current, 403);
    db.sql(&format!(
        "UPDATE vault_memberships SET role='member' WHERE vault_id='{}' AND user_id='{}'",
        a.box_id, c.id
    ));
    let good = mutation(db, &old, &a, &item, &dto, item_v, &probe, 0);
    for headers in [
        String::new(),
        format!("Authorization: Bearer {}\r\n", a.connect),
    ] {
        let before = state_hash(db, true);
        let (status, _) = http(p, "PUT", &endpoint, &headers, &good);
        check(
            status == 401 && state_hash(db, true) == before,
            "formal session required; Connect token rejected",
        );
    }
    waiting_attachment_session(db, p, &a, &endpoint, &good);
    // No parent and a stale state selector cannot create either half.
    let missing = ConnectId::generate().unwrap().to_string();
    let missing_file = File::new(&old, &a, &missing, "absent", vec![]);
    reject(
        db,
        p,
        &a,
        "PUT",
        &path(&a, &missing, &missing_file.id),
        &mutation(db, &old, &a, &missing, &dto, 1, &missing_file, 0),
        409,
    );
    let mut stale = good.clone();
    stale["expectedStateRevision"] = json!(revision(db, &a) - 1);
    reject(db, p, &a, "PUT", &endpoint, &stale, 409);
    let mut cas = good.clone();
    cas["item"]["expectedVersion"] = json!(item_v - 1);
    cas["item"]["envelope"] = item_body(&old, &a, &item, &dto, item_v, 1);
    reject(db, p, &a, "PUT", &endpoint, &cas, 409);
    // Direct SQL cannot bypass the same public shape checks.
    let mut bad = good.clone();
    bad["envelope"]["name"] = json!("forbidden");
    let before = state_hash(db, true);
    let reply: Value=checked(serde_json::from_str(&db.sql(&format!("SELECT passshare_attachment_operation('{}','{}','{}','put','{}','{}','{}'::jsonb)::text",a.id,db.sql(&format!("SELECT id FROM sessions WHERE user_id='{}' ORDER BY created_at LIMIT 1",a.id)),a.box_id,item,probe.id,sql_json(&bad)))),"SQL shape rejection");
    check(
        reply["status"] == 400 && state_hash(db, true) == before,
        "SQL contract rejects bad shape in its real transaction",
    );

    // Fault after parent write: implicit single-request transaction rolls back.
    db.sql("CREATE FUNCTION fixture_attachment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='fixture'; END $$; CREATE TRIGGER fixture_attachment_fault BEFORE INSERT OR UPDATE ON encrypted_attachments FOR EACH ROW EXECUTE FUNCTION fixture_attachment_fault()");
    reject(db, p, &a, "PUT", &endpoint, &good, 409);
    db.sql("DROP TRIGGER fixture_attachment_fault ON encrypted_attachments; DROP FUNCTION fixture_attachment_fault()");

    // The largest Core envelope goes through the existing 2MiB formal body.
    let largest = File::new(&old, &a, &item, &"名".repeat(1365), vec![0xff; 1_048_576]);
    let mut max_dto = dto.clone();
    max_dto["attachments"]
        .as_array_mut()
        .unwrap()
        .push(next_ref(&largest, 1));
    let max_body = mutation(db, &old, &a, &item, &max_dto, item_v, &largest, 0);
    check(
        max_body.to_string().len() < 2 * 1024 * 1024,
        "actual public HTTP wrapper fits unchanged body bound",
    );
    send(p, &a, "PUT", &path(&a, &item, &largest.id), &max_body, 200);
    item_v += 1;
    get_file(db, p, &a, &item, &largest, &old, 1);
    let delete = json!({"expectedStateRevision":revision(db,&a),"item":{"expectedVersion":item_v,"envelope":item_body(&old,&a,&item,&dto,item_v+1,1)},"expectedVersion":1,"keyEpoch":1});
    send(p, &a, "DELETE", &path(&a, &item, &largest.id), &delete, 200);
    replay(db, p, &a, "DELETE", &path(&a, &item, &largest.id), &delete);
    item_v += 1;
    reject(
        db,
        p,
        &a,
        "PUT",
        &path(&a, &item, &largest.id),
        &mutation(db, &old, &a, &item, &max_dto, item_v, &largest, 0),
        409,
    );

    // Update one attachment independently from the parent's many title/add edits.
    files[0].version += 1;
    files[0].name = "更新-🦀.bin".to_owned();
    files[0].bytes = vec![0, 0xff, 0, 0xab];
    files[0].sealed = seal(
        &old,
        &a,
        &item,
        &files[0].id,
        &files[0].name,
        &files[0].bytes,
        2,
        1,
    );
    dto["attachments"][0] = next_ref(&files[0], 1);
    let update = mutation(db, &old, &a, &item, &dto, item_v, &files[0], 1);
    send(p, &a, "PUT", &path(&a, &item, &files[0].id), &update, 200);
    replay(db, p, &a, "PUT", &path(&a, &item, &files[0].id), &update);
    item_v += 1;
    get_file(db, p, &a, &item, &files[0], &old, 1);
    let mut wrong = update.clone();
    wrong["expectedVersion"] = json!(0);
    wrong["envelope"] = seal(
        &old,
        &a,
        &item,
        &files[0].id,
        &files[0].name,
        &files[0].bytes,
        1,
        1,
    );
    reject(
        db,
        p,
        &a,
        "PUT",
        &path(&a, &item, &files[0].id),
        &wrong,
        409,
    );

    // More than one metadata page, with ciphertext fetch bound to the same state.
    for n in 0..98 {
        let f = File::new(
            &old,
            &a,
            &item,
            &format!("ordered-{n}"),
            vec![n as u8, 0, 0xff],
        );
        dto["attachments"]
            .as_array_mut()
            .unwrap()
            .push(next_ref(&f, 1));
        send(
            p,
            &a,
            "PUT",
            &path(&a, &item, &f.id),
            &mutation(db, &old, &a, &item, &dto, item_v, &f, 0),
            200,
        );
        item_v += 1;
        files.push(f);
    }
    let snap = send(
        p,
        &a,
        "GET",
        &format!("{}/sharing-snapshot", root(&a)),
        &Value::Null,
        200,
    );
    let rev = number(&snap, "stateRevision");
    check(
        snap["liveAttachmentCount"] == 101,
        "snapshot counts all live attachments",
    );
    check(snap["liveAttachmentBytes"].as_u64().unwrap()==db.sql(&format!("SELECT sum(octet_length(envelope::text)) FROM encrypted_attachments WHERE box_id='{}'",a.box_id)).parse::<u64>().unwrap(),"total is exact persisted UTF8 envelope bytes");
    let page = send(
        p,
        &a,
        "GET",
        &format!("{}/sharing-snapshot/attachments?revision={rev}", root(&a)),
        &Value::Null,
        200,
    );
    check(
        page["attachments"].as_array().unwrap().len() == 100,
        "first metadata page is bounded to 100",
    );
    let page2 = send(
        p,
        &a,
        "GET",
        &format!(
            "{}/sharing-snapshot/attachments?revision={rev}&after={}",
            root(&a),
            text_field(&page, "nextCursor")
        ),
        &Value::Null,
        200,
    );
    check(
        page2["attachments"].as_array().unwrap().len() == 1 && page2["nextCursor"].is_null(),
        "second page completes the set",
    );
    let seen = page["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .chain(page2["attachments"].as_array().unwrap())
        .map(|v| {
            (
                text_field(v, "attachmentId"),
                number(v, "attachmentVersion"),
            )
        })
        .collect::<BTreeMap<_, _>>();
    check(
        files.iter().all(|f| seen.get(&f.id) == Some(&f.version)),
        "all IDs and independent versions match client set",
    );
    let cipher = send(
        p,
        &a,
        "GET",
        &format!(
            "{}/sharing-snapshot/items/{item}/attachments/{}?revision={rev}",
            root(&a),
            files[0].id
        ),
        &Value::Null,
        200,
    );
    files[0].verify(&old, &a, &item, &cipher, 1);
    reject(
        db,
        p,
        &a,
        "GET",
        &format!(
            "{}/sharing-snapshot/attachments?revision={}",
            root(&a),
            rev - 1
        ),
        &Value::Null,
        409,
    );
    references(&dto, &old, &a, &item, item_v, 1, p);
    println!("attachment CRUD, public shapes, exact replay, real SQL rollback and 101-entry snapshot passed");

    // Intermediate failures, abort and resume never change live ciphertext.
    let (rotation, header) = start(db, p, &a, &b, &new);
    replay(db, p, &a, "PUT", &rotation, &header);
    let before_live = state_hash(db, false);
    let _ = stage_item(p, &a, &item, item_v, &dto, &new, &rotation);
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{rotation}/commit"),
        &json!({"currentPassword":a.login_password}),
        409,
    );
    let first = seal(
        &new,
        &a,
        &item,
        &files[0].id,
        &files[0].name,
        &files[0].bytes,
        files[0].version + 1,
        2,
    );
    let stage_path = format!("{rotation}/items/{item}/attachments/{}", files[0].id);
    let stage_body = json!({"expectedVersion":files[0].version,"envelope":first});
    send(p, &a, "PUT", &stage_path, &stage_body, 200);
    replay(db, p, &a, "PUT", &stage_path, &stage_body);
    let mut different = stage_body.clone();
    different["envelope"] = seal(
        &new,
        &a,
        &item,
        &files[0].id,
        &files[0].name,
        &files[0].bytes,
        files[0].version + 1,
        2,
    );
    reject(db, p, &a, "PUT", &stage_path, &different, 409);
    let status = send(p, &a, "GET", &rotation, &Value::Null, 200);
    check(
        status["attachmentCount"] == 1,
        "resume/status sees one staged attachment",
    );
    let limit = db.sql(&format!(
        "SELECT byte_limit FROM encrypted_rotations WHERE operation_id='{}'",
        rotation.rsplit('/').next().unwrap()
    ));
    db.sql(&format!(
        "UPDATE encrypted_rotations SET byte_limit=staged_bytes WHERE operation_id='{}'",
        rotation.rsplit('/').next().unwrap()
    ));
    let second = seal(
        &new,
        &a,
        &item,
        &files[1].id,
        &files[1].name,
        &files[1].bytes,
        2,
        2,
    );
    reject(
        db,
        p,
        &a,
        "PUT",
        &format!("{rotation}/items/{item}/attachments/{}", files[1].id),
        &json!({"expectedVersion":1,"envelope":second}),
        409,
    );
    db.sql(&format!(
        "UPDATE encrypted_rotations SET byte_limit={limit} WHERE operation_id='{}'",
        rotation.rsplit('/').next().unwrap()
    ));
    check(
        state_hash(db, false) == before_live,
        "stage capacity failure leaves all live state unchanged",
    );
    db.sql(&format!("UPDATE encrypted_rotations SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id='{}'",rotation.rsplit('/').next().unwrap()));
    reject(db, p, &a, "PUT", &stage_path, &stage_body, 410);
    check(
        send(p, &a, "GET", &rotation, &Value::Null, 200)["status"] == "expired",
        "expired status retained",
    );
    send(p, &a, "DELETE", &rotation, &Value::Null, 204);
    check(
        state_hash(db, false) == before_live,
        "abort preserves full live state",
    );

    // Any concurrently edited/deleted/added attachment invalidates the original
    // snapshot even if a stage request repeats byte-for-byte.
    for operation in ["edit", "add", "delete"] {
        let (rotation, _) = start(db, p, &a, &b, &new);
        if operation == "edit" {
            let prior = files[0].version;
            files[0].version += 1;
            files[0].name = "parallel attachment edit".to_owned();
            files[0].sealed = seal(
                &old,
                &a,
                &item,
                &files[0].id,
                &files[0].name,
                &files[0].bytes,
                files[0].version,
                1,
            );
            dto["attachments"][0] = next_ref(&files[0], 1);
            send(
                p,
                &a,
                "PUT",
                &path(&a, &item, &files[0].id),
                &mutation(db, &old, &a, &item, &dto, item_v, &files[0], prior),
                200,
            );
            item_v += 1;
        } else if operation == "add" {
            let f = File::new(&old, &a, &item, "parallel attachment", vec![0xff]);
            let mut candidate = dto.clone();
            candidate["attachments"]
                .as_array_mut()
                .unwrap()
                .push(next_ref(&f, 1));
            send(
                p,
                &a,
                "PUT",
                &path(&a, &item, &f.id),
                &mutation(db, &old, &a, &item, &candidate, item_v, &f, 0),
                200,
            );
            item_v += 1;
            dto = candidate;
            files.push(f);
        } else {
            let f = files.pop().unwrap();
            dto["attachments"]
                .as_array_mut()
                .unwrap()
                .retain(|r| r["attachmentId"] != f.id);
            send(
                p,
                &a,
                "DELETE",
                &path(&a, &item, &f.id),
                &json!({"expectedStateRevision":revision(db,&a),"item":{"expectedVersion":item_v,"envelope":item_body(&old,&a,&item,&dto,item_v+1,1)},"expectedVersion":f.version,"keyEpoch":1}),
                200,
            );
            item_v += 1;
        }
        reject(
            db,
            p,
            &a,
            "POST",
            &format!("{rotation}/commit"),
            &json!({"currentPassword":a.login_password}),
            409,
        );
        send(p, &a, "DELETE", &rotation, &Value::Null, 204);
    }
    let (rotation, _) = start(db, p, &a, &b, &new);
    let next_dto = stage_item(p, &a, &item, item_v, &dto, &new, &rotation);
    let stages = stage_files(p, &a, &item, &rotation, &files, &new);
    send(
        p,
        &a,
        "PUT",
        &format!("{rotation}/grants/{}", c.id),
        &json!({"envelope":grant(&new,&a,&c,2)}),
        200,
    );
    let extra = ConnectId::generate().unwrap().to_string();
    let extra_seal = seal(&new, &a, &item, &extra, "extra stage", &[], 2, 2);
    db.sql(&format!("INSERT INTO encrypted_rotation_attachments(box_id,operation_id,item_id,attachment_id,previous,key_epoch,envelope) VALUES('{}','{}','{}','{}',1,2,'{}'::jsonb)",a.box_id,rotation.rsplit('/').next().unwrap(),item,extra,sql_json(&extra_seal)));
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{rotation}/commit"),
        &json!({"currentPassword":a.login_password}),
        409,
    );
    db.sql(&format!(
        "DELETE FROM encrypted_rotation_attachments WHERE box_id='{}' AND attachment_id='{}'",
        a.box_id, extra
    ));
    waiting_auth(db, p, &a, &b, &rotation);
    // Reuse the formal all-public-table archive path, including live bytes,
    // tombstones and pending ciphertext stages, into another OWNED database.
    let restored = encrypted_restore::attachment_roundtrip(db, network);
    let restore_host = Host::start(&restored, network, mode);
    references(&dto, &old, &a, &item, item_v, 1, restore_host.port);
    for file in &files {
        get_file(&restored, restore_host.port, &a, &item, file, &old, 1);
    }
    drop(restore_host);
    drop(restored);
    let before = state_hash(db, true);
    // Fault AFTER all live item and attachment updates, before wrapper change.
    db.sql("CREATE FUNCTION fixture_rotation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='fixture'; END $$; CREATE TRIGGER fixture_rotation_fault BEFORE UPDATE ON encrypted_owner_keys FOR EACH ROW EXECUTE FUNCTION fixture_rotation_fault()");
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{rotation}/commit"),
        &json!({"currentPassword":a.login_password}),
        409,
    );
    db.sql("DROP TRIGGER fixture_rotation_fault ON encrypted_owner_keys; DROP FUNCTION fixture_rotation_fault()");
    check(
        state_hash(db, true) == before,
        "rotation transaction fault preserves all stages and original ciphertext",
    );
    let result = commit(p, &a, &rotation);
    let exact = replay(
        db,
        p,
        &a,
        "POST",
        &format!("{rotation}/commit"),
        &json!({"currentPassword":a.login_password}),
    );
    check(
        result == exact && result["attachmentCount"] == files.len() as u64,
        "exact atomic commit result replay",
    );
    item_v += 1;
    references(&next_dto, &new, &a, &item, item_v, 2, p);
    for (file, sealed) in files.iter_mut().zip(stages) {
        file.version += 1;
        file.sealed = sealed;
    }
    let member_key = own_grant(&rt, &c.sdk(p), &a, &c, 2);
    for file in &files {
        let cipher = get_file(db, p, &a, &item, file, &new, 2);
        file.verify(&member_key, &a, &item, &cipher, 2);
        let envelope: EncryptedAttachment =
            checked(serde_json::from_value(cipher), "post-rotation envelope");
        check(
            old.decrypt_attachment(
                &envelope,
                &attach_context(&a, &item, &file.id, file.version, 2),
            )
            .is_err(),
            "only new key decrypts current ciphertext",
        );
    }
    // Both cancelled old session and a NEW valid account session are unable to
    // obtain future item, grant, owner key or attachment ciphertext.
    let (status, login) = http(
        p,
        "POST",
        "/api/auth/login",
        "x-passshare-client: mobile\r\n",
        &json!({"email":b.email,"password":b.login_password}),
    );
    check(
        status == 200,
        "removed member can still sign in to their own account",
    );
    for (session, expected) in [
        (&b.session[..], 403),
        (login["refreshToken"].as_str().unwrap(), 403),
        (&b.connect[..], 401),
        (login["connectAccessToken"].as_str().unwrap(), 401),
    ] {
        for endpoint in [
            format!("{}/items/{item}", root(&a)),
            format!("{}/grants/me", root(&a)),
            format!("{}/owner-key", root(&a)),
            format!(
                "{}?revision={}",
                path(&a, &item, &files[0].id),
                revision(db, &a)
            ),
        ] {
            let (status, _) = http(
                p,
                "GET",
                &endpoint,
                &format!("Authorization: Bearer {session}\r\n"),
                &Value::Null,
            );
            check(
                status == expected,
                "removed old/new session and Connect tokens cannot read future item/key/attachment",
            );
        }
    }
    let dead = File::new(&new, &a, &item, "reserved", vec![]);
    let mut dead_body = mutation(db, &new, &a, &item, &next_dto, item_v, &dead, 0);
    dead_body["envelope"] = seal(
        &new,
        &a,
        &item,
        &largest.id,
        &largest.name,
        &largest.bytes,
        1,
        2,
    );
    dead_body["item"]["envelope"] = item_body(&new, &a, &item, &next_dto, item_v + 1, 2);
    reject(
        db,
        p,
        &a,
        "PUT",
        &path(&a, &item, &largest.id),
        &dead_body,
        409,
    );
    // Parent deletion reserves its ID and cascades all live attachment rows.
    send(
        p,
        &a,
        "DELETE",
        &format!("{}/items/{item}", root(&a)),
        &json!({"expectedVersion":item_v,"keyEpoch":2}),
        204,
    );
    check(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_attachments WHERE box_id='{}'",
            a.box_id
        )) == "0",
        "parent delete removes full live attachment set",
    );
    reject(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{item}", root(&a)),
        &json!({"expectedVersion":0,"envelope":item_body(&new,&a,&item,&next_dto,1,2)}),
        409,
    );
    reject(
        db,
        p,
        &a,
        "PUT",
        &path(&a, &item, &largest.id),
        &dead_body,
        409,
    );
    check(
        db.sql("SELECT count(*) FROM encrypted_rotation_attachments") == "0",
        "commit/abort removes staged attachments",
    );
    // ZERO live attachments must keep the existing strict SDK wire unchanged.
    let sdk = a.sdk(p);
    let sharing = SharingRotationClient::new(&sdk);
    let empty = checked(
        rt.block_on(sharing.sharing_snapshot(&a.box_id, &a.id)),
        "existing SDK zero-attachment snapshot",
    );
    check(
        empty.live_item_count == 0,
        "existing strict snapshot accepts zero-attachment box",
    );
    accept(p, &d, &unconfirmed);
    let third = checked(PasswordBoxKey::generate(), "client third box key");
    let (zero_rotation, _) = start(db, p, &a, &d, &third);
    let pending = send(p, &a, "GET", &zero_rotation, &Value::Null, 200);
    check(
        serde_json::from_value::<passshare_connect::RotationStatusReply>(pending).is_ok(),
        "existing strict SDK pending rotation status remains compatible",
    );
    send(
        p,
        &a,
        "PUT",
        &format!("{zero_rotation}/grants/{}", c.id),
        &json!({"envelope":grant(&third,&a,&c,3)}),
        200,
    );
    let committed = commit(p, &a, &zero_rotation);
    check(
        serde_json::from_value::<passshare_connect::RotationCommitReply>(committed.clone()).is_ok(),
        "existing strict SDK zero-attachment commit remains compatible",
    );
    check(
        replay(
            db,
            p,
            &a,
            "POST",
            &format!("{zero_rotation}/commit"),
            &json!({"currentPassword":a.login_password}),
        ) == committed,
        "zero-attachment commit exact replay",
    );
    let status = send(p, &a, "GET", &zero_rotation, &Value::Null, 200);
    check(
        serde_json::from_value::<passshare_connect::RotationStatusReply>(status).is_ok(),
        "existing strict SDK committed rotation status remains compatible",
    );
    // The unrelated invitation survived removal of b and was just accepted.
    check(
        db.sql(&format!(
            "SELECT status FROM vault_invitations WHERE id='{}'",
            text_field(&unconfirmed, "id")
        )) == "accepted",
        "unrelated invitation retained",
    );
    println!("encrypted attachment acceptance: {} measured HTTP/Core/PG assertions passed; 101-entry pagination; all-name/all-byte comparisons; no skipped cases",CHECKS.load(Ordering::Relaxed));
}

fn waiting_attachment_session(db: &Database, p: u16, a: &Account, endpoint: &str, request: &Value) {
    let (status, login) = http(
        p,
        "POST",
        "/api/auth/login",
        "x-passshare-client: mobile\r\n",
        &json!({"email":a.email,"password":a.login_password}),
    );
    check(status == 200, "fresh attachment mutation test session");
    let token = text_field(&login, "refreshToken");
    let session = db.sql(&format!(
        "SELECT id::text FROM sessions WHERE user_id='{}' ORDER BY created_at DESC LIMIT 1",
        a.id
    ));
    let label = format!(
        "passshare1163-attach-session-{}",
        ConnectId::generate().unwrap()
    );
    let mut held = HeldBox::start(db, &a.box_id, &label);
    check(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"attachment authorization box lock held");
    let before = state_hash(db, true);
    let path = endpoint.to_owned();
    let body = request.clone();
    let worker = thread::spawn(move || {
        http(
            p,
            "PUT",
            &path,
            &format!("Authorization: Bearer {token}\r\n"),
            &body,
        )
    });
    let waiting=wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='{label}' AND w.query LIKE '%passshare_attachment_operation(%')"));
    if !waiting {
        held.commit();
        let _ = worker.join();
        panic!("attachment mutation must actually wait before session fault");
    }
    db.sql(&format!("DELETE FROM sessions WHERE id='{session}'"));
    held.commit();
    let (status, _) = worker.join().unwrap();
    check(
        status == 401 && state_hash(db, true) == before,
        "session revoked during wait cannot mutate either item or attachment",
    );
}

fn waiting_auth(db: &Database, p: u16, a: &Account, b: &Account, rotation: &str) {
    for credentials_changed in [false, true] {
        let (status, login) = http(
            p,
            "POST",
            "/api/auth/login",
            "x-passshare-client: mobile\r\n",
            &json!({"email":a.email,"password":a.login_password}),
        );
        check(status == 200, "fresh finite test session");
        let token = text_field(&login, "refreshToken");
        let session = db.sql(&format!(
            "SELECT id::text FROM sessions WHERE user_id='{}' ORDER BY created_at DESC LIMIT 1",
            a.id
        ));
        let label = format!(
            "passshare1163-attach-auth-{}",
            ConnectId::generate().unwrap()
        );
        let mut held = HeldBox::start(db, &a.box_id, &label);
        check(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"box lock really held");
        let before = state_hash(db, true);
        let path = format!("{rotation}/commit");
        let body = json!({"currentPassword":a.login_password});
        let worker = thread::spawn(move || {
            http(
                p,
                "POST",
                &path,
                &format!("Authorization: Bearer {token}\r\n"),
                &body,
            )
        });
        let waiting=wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid=ANY(pg_blocking_pids(w.pid)) WHERE h.application_name='{label}' AND w.query LIKE '%passshare_sharing_operation(%')"));
        if !waiting {
            held.commit();
            let _ = worker.join();
            panic!("attachment rotation auth test must observe actual database wait");
        }
        if credentials_changed {
            db.sql(&format!("CREATE TABLE passshare1163_attach_credential_restore AS SELECT id,password_hash FROM users WHERE id='{}'; UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE id='{}') WHERE id='{}'",a.id,b.id,a.id));
        } else {
            db.sql(&format!("DELETE FROM sessions WHERE id='{session}'"));
        }
        held.commit();
        let (status, reply) = worker.join().unwrap();
        check(
            status == 401
                && reply["error"]
                    == if credentials_changed {
                        "PS026"
                    } else {
                        "PS024"
                    },
            "post-wait session and credential snapshot rechecked",
        );
        check(
            state_hash(db, true) == before,
            "auth change preserves all live attachment and staged ciphertext",
        );
        if credentials_changed {
            db.sql("UPDATE users u SET password_hash=r.password_hash FROM passshare1163_attach_credential_restore r WHERE u.id=r.id; DROP TABLE passshare1163_attach_credential_restore");
        }
    }
}
