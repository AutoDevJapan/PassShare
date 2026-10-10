//! Synthetic Core -> formal Node -> independent PostgreSQL -> Core acceptance.
//! Never uses a mock store, production account, new crypto or plaintext upload.
use super::*;
use passshare_connect::{
    AttachmentItemWrite, RotationAttachmentRequest, RotationExpectation, SharingItemSummary,
};
use passshare_core::cloud_crypto::{AttachmentContext, AttachmentPlaintext, EncryptedAttachment};
use std::sync::atomic::AtomicUsize;

static CHECKS: AtomicUsize = AtomicUsize::new(0);
static SDK_REQUESTS: AtomicUsize = AtomicUsize::new(0);
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

// A byte-forwarding observation point, never a response fixture. Every request
// reaches the formal Node router and its real PostgreSQL transaction. Only the
// count survives; headers, session credentials and bodies stay in memory.
struct SdkTap {
    port: u16,
    requests: std::sync::Arc<AtomicUsize>,
    lose_reply: std::sync::Arc<AtomicBool>,
    stop: std::sync::Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl SdkTap {
    fn start(upstream: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = std::sync::Arc::new(AtomicUsize::new(0));
        let lose_reply = std::sync::Arc::new(AtomicBool::new(false));
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let (count, lose, ending) = (requests.clone(), lose_reply.clone(), stop.clone());
        let worker = thread::spawn(move || {
            while !ending.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut client, _)) => {
                        client.set_nonblocking(false).unwrap();
                        client
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        client
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        let mut header = Vec::new();
                        while !header.ends_with(b"\r\n\r\n") {
                            assert!(header.len() < 65536, "SDK tap header bound");
                            let mut byte = [0];
                            client.read_exact(&mut byte).expect("SDK tap header read");
                            header.push(byte[0]);
                        }
                        let header = String::from_utf8(header).expect("SDK tap header encoding");
                        let length = header
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        assert!(length <= 2 * 1024 * 1024, "SDK tap body bound");
                        let mut body = vec![0; length];
                        client.read_exact(&mut body).expect("SDK tap body read");
                        let mut server = TcpStream::connect(("127.0.0.1", upstream)).unwrap();
                        server
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        server
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        // Close upstream framing explicitly; payload bytes are unchanged.
                        for line in header.lines().filter(|line| !line.is_empty()) {
                            if !line
                                .split_once(':')
                                .is_some_and(|(key, _)| key.eq_ignore_ascii_case("connection"))
                            {
                                write!(server, "{line}\r\n").unwrap();
                            }
                        }
                        server.write_all(b"Connection: close\r\n\r\n").unwrap();
                        server.write_all(&body).unwrap();
                        count.fetch_add(1, Ordering::SeqCst);
                        let mut response = Vec::new();
                        server
                            .take(3 * 1024 * 1024 + 1)
                            .read_to_end(&mut response)
                            .unwrap();
                        assert!(response.len() <= 3 * 1024 * 1024, "SDK tap response bound");
                        if !lose.swap(false, Ordering::SeqCst) {
                            client.write_all(&response).unwrap();
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => panic!("SDK tap accept failed"),
                }
            }
        });
        Self {
            port,
            requests,
            lose_reply,
            stop,
            worker: Some(worker),
        }
    }
    fn count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}
impl Drop for SdkTap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if self.worker.take().unwrap().join().is_err() {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
        }
    }
}

fn sdk_once<T>(tap: &SdkTap, operation: impl FnOnce() -> T) -> T {
    request_slot();
    let before = tap.count();
    let result = operation();
    check(
        tap.count() == before + 1,
        "real SDK issues exactly one formal request, no automatic retry",
    );
    SDK_REQUESTS.fetch_add(1, Ordering::Relaxed);
    result
}

fn sdk_rotation(a: &Account, path: &str, original: &Value) -> RotationExpectation {
    RotationExpectation {
        password_box_id: a.box_id.parse().unwrap(),
        owner_account_id: a.id.clone(),
        operation_id: path.rsplit('/').next().unwrap().to_owned(),
        expected_state_revision: number(original, "expectedStateRevision"),
        expected_key_epoch: number(original, "expectedKeyEpoch"),
        expected_owner_bundle_version: number(original, "expectedOwnerBundleVersion"),
        remove_account_id: text_field(original, "removeAccountId"),
        item_count: None,
        grant_count: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn sdk_reads(
    db: &Database,
    p: u16,
    rt: &tokio::runtime::Runtime,
    a: &Account,
    key: &PasswordBoxKey,
    item: &str,
    dto: &Value,
    item_v: u64,
    files: &[File],
    epoch: u64,
) {
    let tap = SdkTap::start(p);
    let session = a.sdk(tap.port);
    let sharing = SharingRotationClient::new(&session);
    let snapshot = checked(
        sdk_once(&tap, || {
            rt.block_on(sharing.sharing_snapshot(&a.box_id, &a.id))
        }),
        "SDK attachment snapshot",
    );
    check(
        snapshot.state_revision == revision(db, a)
            && snapshot.key_epoch == epoch
            && snapshot.live_attachment_count == Some(files.len() as u64),
        "SDK independently held snapshot revision/epoch/count",
    );
    let summary = SharingItemSummary {
        item_id: item.parse().unwrap(),
        item_version: item_v,
        key_epoch: epoch,
    };
    let cipher = checked(
        sdk_once(&tap, || {
            rt.block_on(sharing.snapshot_item(&a.box_id, &snapshot, &summary))
        }),
        "SDK authenticated snapshot item",
    );
    let opened = checked(
        key.decrypt_item(&cipher, &context(a, item, item_v, epoch)),
        "Core snapshot item authentication",
    );
    check(
        opened == client_dto(dto, a, item, item_v),
        "SDK full plaintext DTO including ordered references and every unknown field",
    );
    let first = checked(
        sdk_once(&tap, || {
            rt.block_on(sharing.snapshot_attachments(&a.box_id, &snapshot, None))
        }),
        "SDK first metadata page",
    );
    check(
        first.attachments.len() == files.len().min(100),
        "SDK bounded first page",
    );
    let mut metadata = first.attachments;
    if let Some(cursor) = first.next_cursor {
        // Keep the complete server cursor; never split/reconstruct it for transport.
        let next = checked(
            sdk_once(&tap, || {
                rt.block_on(sharing.snapshot_attachments(&a.box_id, &snapshot, Some(&cursor)))
            }),
            "SDK opaque cursor roundtrip",
        );
        check(
            next.next_cursor.is_none() && next.attachments.len() == files.len() - 100,
            "SDK cursor completes exact set without skipped entries",
        );
        metadata.extend(next.attachments);
    }
    let actual = metadata
        .iter()
        .map(|m| {
            (
                m.attachment_id.to_string(),
                (m.item_id.to_string(), m.attachment_version, m.key_epoch),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let expected = files
        .iter()
        .map(|f| (f.id.clone(), (item.to_owned(), f.version, epoch)))
        .collect::<BTreeMap<_, _>>();
    check(
        metadata.len() == files.len() && actual == expected,
        "SDK list all independently held IDs/items/versions/epochs, no duplicates",
    );
    for (reference, file) in opened["attachments"].as_array().unwrap().iter().zip(files) {
        check(
            *reference == next_ref(file, epoch),
            "authenticated reference order matches original input",
        );
        // This context is derived from the authenticated ITEM at this revision,
        // independently compared with original inputs, never attachment metadata.
        let expected = attach_context(
            a,
            item,
            reference["attachmentId"].as_str().unwrap(),
            reference["attachmentVersion"].as_u64().unwrap(),
            reference["keyEpoch"].as_u64().unwrap(),
        );
        let cipher = checked(
            sdk_once(&tap, || {
                rt.block_on(sharing.snapshot_attachment(&a.box_id, &snapshot, &expected))
            }),
            "SDK snapshot attachment",
        );
        file.verify(key, a, item, &json!(cipher), epoch);
        let live = checked(
            sdk_once(&tap, || {
                rt.block_on(session.get_attachment(snapshot.state_revision, &expected))
            }),
            "SDK revision-bound live attachment",
        );
        check(
            live == cipher,
            "SDK live and snapshot ciphertext match completely",
        );
        file.verify(key, a, item, &json!(live), epoch);
    }
    let mut stale = snapshot.clone();
    stale.state_revision -= 1;
    let before = state_hash(db, true);
    let rejected = sdk_once(&tap, || {
        rt.block_on(sharing.snapshot_attachments(&a.box_id, &stale, None))
    });
    check(
        rejected.err().is_some_and(|e| e.status() == Some(409)) && state_hash(db, true) == before,
        "SDK stale snapshot returns 409 without mutation/retry",
    );
    let mut wrong = attach_context(a, item, &files[0].id, files[0].version + 1, epoch);
    let rejected = sdk_once(&tap, || {
        rt.block_on(session.get_attachment(snapshot.state_revision, &wrong))
    });
    check(
        matches!(rejected, Err(EncryptedSessionError::ContextMismatch)),
        "SDK does not trust fetched envelope version",
    );
    wrong = attach_context(a, item, &files[0].id, files[0].version, epoch + 1);
    let rejected = sdk_once(&tap, || {
        rt.block_on(session.get_attachment(snapshot.state_revision, &wrong))
    });
    check(
        matches!(rejected, Err(EncryptedSessionError::ContextMismatch)),
        "SDK does not trust fetched envelope epoch",
    );
    check(
        state_hash(db, true) == before,
        "SDK read/context failures preserve every live/staged row and xmin",
    );
}

#[allow(clippy::too_many_arguments)]
fn sdk_mutations(
    db: &Database,
    p: u16,
    rt: &tokio::runtime::Runtime,
    a: &Account,
    denied: &Account,
    key: &PasswordBoxKey,
    item: &str,
    dto: &Value,
    item_v: &mut u64,
) {
    let tap = SdkTap::start(p);
    let session = a.sdk(tap.port);
    let mut file = File::new(key, a, item, "SDK\0任意-Ж🦀.bin", (0..=255).collect());
    let mut next = dto.clone();
    next["attachments"]
        .as_array_mut()
        .unwrap()
        .insert(1, next_ref(&file, 1));
    let item_write: AttachmentItemWrite = checked(
        serde_json::from_value(
            json!({"expectedVersion":*item_v,"envelope":item_body(key,a,item,&next,*item_v+1,1)}),
        ),
        "SDK item write",
    );
    let cipher = checked(
        serde_json::from_value(file.sealed.clone()),
        "SDK attachment cipher",
    );
    let expected = attach_context(a, item, &file.id, 1, 1);
    let rev = revision(db, a);
    let before = state_hash(db, true);
    for (client, status) in [
        (denied.sdk(tap.port), 403),
        (
            checked(
                EncryptedSessionClient::new(&format!("http://127.0.0.1:{}", tap.port), &a.connect),
                "SDK invalid session",
            ),
            401,
        ),
    ] {
        let result = sdk_once(&tap, || {
            rt.block_on(client.put_attachment(rev, &item_write, 0, &cipher, &expected))
        });
        check(
            result.err().is_some_and(|e| e.status() == Some(status))
                && state_hash(db, true) == before,
            "SDK formal auth rejection preserves both resources without retry",
        );
    }
    let result = sdk_once(&tap, || {
        rt.block_on(session.put_attachment(rev - 1, &item_write, 0, &cipher, &expected))
    });
    check(
        result.err().is_some_and(|e| e.status() == Some(409)) && state_hash(db, true) == before,
        "SDK atomic stale CAS rejection without retry",
    );
    db.sql("CREATE FUNCTION fixture_sdk_attachment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0015',MESSAGE='fixture'; END $$; CREATE TRIGGER fixture_sdk_attachment_fault BEFORE INSERT ON encrypted_attachments FOR EACH ROW EXECUTE FUNCTION fixture_sdk_attachment_fault()");
    let result = sdk_once(&tap, || {
        rt.block_on(session.put_attachment(rev, &item_write, 0, &cipher, &expected))
    });
    check(
        result.err().is_some_and(|e| e.status() == Some(409)) && state_hash(db, true) == before,
        "SDK real SQL fault after item write rolls back both resources once",
    );
    db.sql("DROP TRIGGER fixture_sdk_attachment_fault ON encrypted_attachments; DROP FUNCTION fixture_sdk_attachment_fault()");
    tap.lose_reply.store(true, Ordering::SeqCst);
    let lost = sdk_once(&tap, || {
        rt.block_on(session.put_attachment(rev, &item_write, 0, &cipher, &expected))
    });
    check(
        matches!(lost, Err(EncryptedSessionError::Transport(_))) && revision(db, a) == rev + 2,
        "SDK lost real committed PUT reply is surfaced without automatic retry",
    );
    let committed = state_hash(db, true);
    let reply = checked(
        sdk_once(&tap, || {
            rt.block_on(session.put_attachment(rev, &item_write, 0, &cipher, &expected))
        }),
        "SDK explicit exact PUT retry",
    );
    check(
        reply.state_revision == rev + 2
            && reply.item_version == *item_v + 1
            && reply.attachment_version == 1
            && reply.key_epoch == 1
            && state_hash(db, true) == committed,
        "SDK exact PUT retry result and unchanged full rows/xmin",
    );
    *item_v += 1;
    references(&next, key, a, item, *item_v, 1, p);
    let live = checked(
        sdk_once(&tap, || {
            rt.block_on(session.get_attachment(reply.state_revision, &expected))
        }),
        "SDK arbitrary binary GET",
    );
    file.verify(key, a, item, &json!(live), 1);
    file.version = 2;
    file.name = "SDK更新\0🦀.bin".to_owned();
    file.bytes.reverse();
    file.sealed = seal(key, a, item, &file.id, &file.name, &file.bytes, 2, 1);
    next["attachments"][1] = next_ref(&file, 1);
    let update_item: AttachmentItemWrite = checked(
        serde_json::from_value(
            json!({"expectedVersion":*item_v,"envelope":item_body(key,a,item,&next,*item_v+1,1)}),
        ),
        "SDK update item",
    );
    let updated_context = attach_context(a, item, &file.id, 2, 1);
    let updated_cipher = checked(
        serde_json::from_value(file.sealed.clone()),
        "SDK update cipher",
    );
    let updated = checked(
        sdk_once(&tap, || {
            rt.block_on(session.put_attachment(
                reply.state_revision,
                &update_item,
                1,
                &updated_cipher,
                &updated_context,
            ))
        }),
        "SDK real atomic attachment update",
    );
    let updated_rows = state_hash(db, true);
    let updated_retry = checked(
        sdk_once(&tap, || {
            rt.block_on(session.put_attachment(
                reply.state_revision,
                &update_item,
                1,
                &updated_cipher,
                &updated_context,
            ))
        }),
        "SDK exact update retry",
    );
    check(
        updated == updated_retry
            && updated.state_revision == rev + 4
            && updated.attachment_version == 2
            && updated.item_version == *item_v + 1
            && state_hash(db, true) == updated_rows,
        "SDK independent attachment update CAS and exact retry preserve full rows/xmin",
    );
    *item_v += 1;
    references(&next, key, a, item, *item_v, 1, p);
    let live = checked(
        sdk_once(&tap, || {
            rt.block_on(session.get_attachment(updated.state_revision, &updated_context))
        }),
        "SDK updated binary GET",
    );
    file.verify(key, a, item, &json!(live), 1);
    let delete_item: AttachmentItemWrite = checked(
        serde_json::from_value(
            json!({"expectedVersion":*item_v,"envelope":item_body(key,a,item,dto,*item_v+1,1)}),
        ),
        "SDK delete item write",
    );
    let deleted = checked(
        sdk_once(&tap, || {
            rt.block_on(session.delete_attachment(
                updated.state_revision,
                &delete_item,
                &updated_context,
            ))
        }),
        "SDK atomic DELETE",
    );
    let after = state_hash(db, true);
    let exact = checked(
        sdk_once(&tap, || {
            rt.block_on(session.delete_attachment(
                updated.state_revision,
                &delete_item,
                &updated_context,
            ))
        }),
        "SDK explicit exact DELETE retry",
    );
    check(
        deleted == exact
            && deleted.deleted
            && deleted.state_revision == rev + 6
            && deleted.item_version == *item_v + 1
            && deleted.key_epoch == 1
            && state_hash(db, true) == after,
        "SDK atomic DELETE metadata and exact retry preserve rows/xmin",
    );
    *item_v += 1;
    references(dto, key, a, item, *item_v, 1, p);
    let gone = sdk_once(&tap, || {
        rt.block_on(session.get_attachment(deleted.state_revision, &updated_context))
    });
    check(
        gone.err().is_some_and(|e| e.status() == Some(404)),
        "SDK deleted ciphertext unavailable at current revision",
    );
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
    let mut dto = json!({"title":"synthetic attachment item","attachments":[],"unknown":{"ordered":[3,1,2],"nested":{"null":null,"flag":true,"unicode":"\0Ж🦀","bytes":(0..=255).collect::<Vec<u8>>() }},"fields":[{"id":"password","type":"CONCEALED","value":"synthetic-only\0éЖ🦀","unknown":[false,17,null]},{"id":"notes","value":"line1\nline2"}],"tags":["z","a","z"],"urls":[{"href":"https://example.invalid/","primary":true}],"notesPlain":"\0synthetic","category":"LOGIN"});
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
    sdk_mutations(db, p, &rt, &a, &d, &old, &item, &dto, &mut item_v);
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
    sdk_reads(db, p, &rt, &a, &old, &item, &dto, item_v, &files, 1);
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
    let expected_rotation = sdk_rotation(&a, &rotation, &header);
    let tap = SdkTap::start(p);
    let stage_session = a.sdk(tap.port);
    let sharing = SharingRotationClient::new(&stage_session);
    let staged = checked(
        sdk_once(&tap, || {
            rt.block_on(sharing.stage_attachment(
                &expected_rotation,
                &checked(
                    serde_json::from_value(stage_body.clone()),
                    "SDK stage request",
                ),
                &attach_context(&a, &item, &files[0].id, files[0].version + 1, 2),
            ))
        }),
        "SDK real first stage",
    );
    check(
        staged.attachment_version == files[0].version + 1 && state_hash(db, false) == before_live,
        "SDK first stage writes future cipher without changing live rows",
    );
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
    let staged_before = state_hash(db, true);
    let stage_request: RotationAttachmentRequest = checked(
        serde_json::from_value(stage_body.clone()),
        "SDK saved exact stage",
    );
    let staged_again = checked(
        sdk_once(&tap, || {
            rt.block_on(sharing.stage_attachment(
                &expected_rotation,
                &stage_request,
                &attach_context(&a, &item, &files[0].id, files[0].version + 1, 2),
            ))
        }),
        "SDK exact stage retry",
    );
    check(
        staged_again == staged && state_hash(db, true) == staged_before,
        "SDK exact stage retry preserves all stages/xmin",
    );
    let different_request = checked(
        serde_json::from_value(different.clone()),
        "SDK changed stage request",
    );
    let rejected = sdk_once(&tap, || {
        rt.block_on(sharing.stage_attachment(
            &expected_rotation,
            &different_request,
            &attach_context(&a, &item, &files[0].id, files[0].version + 1, 2),
        ))
    });
    check(
        rejected.err().is_some_and(|e| e.status() == Some(409))
            && state_hash(db, true) == staged_before,
        "SDK changed stage conflict is surfaced once and preserves all rows",
    );
    drop(tap);
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
    sdk_reads(db, p, &rt, &a, &new, &item, &next_dto, item_v, &files, 2);
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
    println!("encrypted attachment acceptance: {} measured HTTP/SDK/Core/PG assertions passed; {} observed real SDK requests; 101-entry pagination; all-field/all-name/all-byte comparisons; no skipped cases",CHECKS.load(Ordering::Relaxed),SDK_REQUESTS.load(Ordering::Relaxed));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_tap_forwards_fragmented_request_bytes_and_observes_lost_reply() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let tap = SdkTap::start(upstream.local_addr().unwrap().port());
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = upstream.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let mut bytes = [0; 3];
                stream.read_exact(&mut bytes).unwrap();
                assert!(bytes == [0, 255, 17]);
                assert!(header.starts_with(b"PUT /probe HTTP/1.1\r\n"));
                assert!(header.ends_with(b"Connection: close\r\n\r\n"));
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
                    )
                    .unwrap();
            }
        });
        for lost in [false, true] {
            tap.lose_reply.store(lost, Ordering::SeqCst);
            let mut stream = TcpStream::connect(("127.0.0.1", tap.port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream.write_all(b"P").unwrap();
            // Deliberate fragmentation exposes inherited Windows nonblocking
            // sockets; this delay injects the defect rather than asserting timing.
            thread::sleep(Duration::from_millis(30));
            stream
                .write_all(b"UT /probe HTTP/1.1\r\nContent-Length: 3\r\n\r\n")
                .unwrap();
            thread::sleep(Duration::from_millis(30));
            stream.write_all(&[0, 255, 17]).unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            assert!(if lost {
                response.is_empty()
            } else {
                response.ends_with(b"\r\n\r\nabc")
            });
        }
        server.join().unwrap();
        assert_eq!(tap.count(), 2);
    }

    #[test]
    fn independent_attachment_context_binds_every_field_and_arbitrary_plaintext() {
        let key = PasswordBoxKey::generate().unwrap();
        let original: AttachmentContext = serde_json::from_value(json!({
            "passwordBoxId":ConnectId::generate().unwrap(), "itemId":ConnectId::generate().unwrap(),
            "attachmentId":ConnectId::generate().unwrap(), "attachmentVersion":7, "keyEpoch":3
        }))
        .unwrap();
        let bytes: Vec<u8> = (0..=255).chain((0..=255).rev()).collect();
        let plain = AttachmentPlaintext::new("任意\0éЖ🦀\n.bin".to_owned(), bytes.clone()).unwrap();
        let sealed = key.encrypt_attachment(&plain, &original).unwrap();
        let opened = key.decrypt_attachment(&sealed, &original).unwrap();
        assert!(opened.name() == plain.name() && opened.content() == bytes);
        for (field, replacement) in [
            ("passwordBoxId", json!(ConnectId::generate().unwrap())),
            ("itemId", json!(ConnectId::generate().unwrap())),
            ("attachmentId", json!(ConnectId::generate().unwrap())),
            ("attachmentVersion", json!(8)),
            ("keyEpoch", json!(4)),
        ] {
            let mut changed = json!(original);
            changed[field] = replacement;
            let independent = serde_json::from_value(changed).unwrap();
            assert!(
                key.decrypt_attachment(&sealed, &independent).is_err(),
                "independent {field} must bind"
            );
        }
    }
}
