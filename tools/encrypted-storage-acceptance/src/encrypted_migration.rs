//! Independent client Core -> formal Node -> fresh owned PostgreSQL acceptance.
use super::*;
use passshare_connect::{MigrationSourceFile, MigrationState, MigrationTransportPlan};
use passshare_core::cloud_crypto::{
    migration::{
        prepare_migration, MigrationAttachmentBinding, MigrationAttachmentSource,
        MigrationItemBinding, MigrationItemSource, TrustedOwnerKeyContext,
    },
    AttachmentContext, AttachmentPlaintext, EncryptedAttachment, EncryptedItem,
};
use std::sync::atomic::AtomicUsize;

fn sdk(p: u16, a: &Account) -> passshare_connect::EncryptedSessionClient {
    checked(
        passshare_connect::EncryptedSessionClient::new(
            &format!("http://127.0.0.1:{p}"),
            &a.session,
        ),
        "migration session SDK",
    )
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn sdk_ok<T>(result: passshare_connect::EncryptedSessionResult<T>) -> T {
    let result = checked(result, "migration SDK request");
    SDK_READS.fetch_add(1, Ordering::Relaxed);
    CHECKS.fetch_add(1, Ordering::Relaxed);
    result
}
fn sdk_reject<T>(
    db: &Database,
    expected_status: u16,
    expected_code: &str,
    request: impl std::future::Future<Output = passshare_connect::EncryptedSessionResult<T>>,
) {
    let before = acceptance_state_hash(db);
    let error = runtime()
        .block_on(request)
        .err()
        .expect("SDK should preserve formal server rejection");
    verify(
        error.status() == Some(expected_status),
        "SDK preserves formal server rejection status",
    );
    verify(
        error.code() == Some(expected_code),
        "SDK preserves formal server rejection code",
    );
    verify(
        acceptance_state_hash(db) == before,
        "SDK rejection retains all original/staged rows and xmin",
    );
    REJECTIONS.fetch_add(1, Ordering::Relaxed);
}

static CHECKS: AtomicUsize = AtomicUsize::new(0);
static REPLAYS: AtomicUsize = AtomicUsize::new(0);
static REJECTIONS: AtomicUsize = AtomicUsize::new(0);
static SDK_READS: AtomicUsize = AtomicUsize::new(0);
fn verify(ok: bool, label: &str) {
    assert!(ok, "migration acceptance: {label}");
    CHECKS.fetch_add(1, Ordering::Relaxed);
}
fn request(p: u16, a: &Account, method: &str, path: &str, body: &Value, status: u16) -> Value {
    let (actual, reply) = http(
        p,
        method,
        path,
        &format!("Authorization: Bearer {}\r\n", a.session),
        body,
    );
    assert!(
        actual == status,
        "migration HTTP {method} expected={status} actual={actual}"
    );
    CHECKS.fetch_add(1, Ordering::Relaxed);
    reply
}
fn original_rows(db: &Database, box_id: &str) -> String {
    db.sql(&format!("SELECT md5(COALESCE(string_agg(v,',' ORDER BY v),'')) FROM (
      SELECT jsonb_build_object('table','connect_items','row',to_jsonb(i),'xmin',i.xmin::text)::text v FROM connect_items i WHERE vault_id='{box_id}'
      UNION ALL SELECT jsonb_build_object('table','connect_item_files','row',to_jsonb(f),'xmin',f.xmin::text)::text FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id='{box_id}'
      UNION ALL SELECT jsonb_build_object('table','mutation_operations','row',to_jsonb(m),'xmin',m.xmin::text)::text FROM mutation_operations m WHERE resource='{box_id}') original"))
}
fn reject(db: &Database, p: u16, a: &Account, method: &str, path: &str, body: &Value, status: u16) {
    let before = original_rows(db, &a.box_id);
    let entire = acceptance_state_hash(db);
    request(p, a, method, path, body, status);
    verify(
        original_rows(db, &a.box_id) == before,
        "rejection retains original full rows and xmin",
    );
    verify(
        acceptance_state_hash(db) == entire,
        "rejection has no staged/active changes",
    );
    REJECTIONS.fetch_add(1, Ordering::Relaxed);
}
fn replay(db: &Database, p: u16, a: &Account, method: &str, path: &str, body: &Value) {
    let before = acceptance_state_hash(db);
    request(p, a, method, path, body, 200);
    verify(
        acceptance_state_hash(db) == before,
        "exact replay leaves all rows and xmin unchanged",
    );
    REPLAYS.fetch_add(1, Ordering::Relaxed);
}
fn source_path(a: &Account) -> String {
    format!("/api/encrypted/boxes/{}/migration-source", a.box_id)
}
struct Original {
    item: Value,
    files: Vec<(AttachmentContext, String, Vec<u8>, bool)>,
}
fn fixture(db: &Database, a: &Account, count: usize) -> Vec<Original> {
    let mut originals = Vec::new();
    let mut statements = String::new();
    for index in 0..count {
        let id = ConnectId::generate().unwrap().to_string();
        let mut item = json!({"id":id,"version":17,"vault":{"id":a.box_id},"title":"独立した元データ🚀",
            "category":"LOGIN","fields":[{"id":"login","value":"not-a-real-secret","extra":{"nil":null}}],
            "urls":[{"href":"https://example.test/一","primary":true,"extra":{"順序":[3,null,"é"]}},
                {"href":"https://example.test/二","primary":false,"unknown":[false,7]}],
            "tags":["二","一","二"],"unknown":[null,{"original":"inner","nested":[4,3,2]},"🧪"],
            "unknownInteger":u64::MAX,"unknownFloat":1.0,
            "notesPlain":null,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","original":{"preserved":true}});
        let mut files = Vec::new();
        if index == 0 {
            for (name, bytes, available) in [
                ("00ff日本語.bin", vec![0, 255, 0, 255], true),
                ("空.bin", Vec::new(), true),
                (
                    "archive🧪.bin",
                    (0..=255).chain([0, 254, 255]).collect::<Vec<_>>(),
                    false,
                ),
            ] {
                let context: AttachmentContext = checked(
                    serde_json::from_value(json!({"passwordBoxId":a.box_id,"itemId":id,
                    "attachmentId":ConnectId::generate().unwrap(),"attachmentVersion":17,"keyEpoch":1})),
                    "independent file context",
                );
                files.push((context, name.to_owned(), bytes, available));
            }
            item["attachments"] = json!(files
                .iter()
                .map(
                    |(c, n, b, _)| json!({"attachmentId":c.attachment_id,"attachmentVersion":17,
                "keyEpoch":1,"name":n,"contentBytes":b.len(),"unknown":{"nil":null,"array":[2,1]}})
                )
                .collect::<Vec<_>>());
        }
        statements.push_str(&format!(
            "INSERT INTO connect_items(id,vault_id,document) VALUES('{id}','{}','{}'::jsonb)",
            a.box_id,
            sql_json(&item)
        ));
        statements.push(';');
        for (c, name, bytes, available) in &files {
            let content = if *available {
                format!("decode('{}','base64')", BASE64.encode(bytes))
            } else {
                "NULL".to_owned()
            };
            statements.push_str(&format!("INSERT INTO connect_item_files(id,item_id,name,size,content) VALUES('{}','{id}','{}',{}, {content});",c.attachment_id,name.replace('\'',"''"),bytes.len()));
        }
        originals.push(Original { item, files });
    }
    db.sql(&statements);
    // Old create receipts also hold full plaintext. Commit must remove these.
    db.sql(&format!("INSERT INTO mutation_operations VALUES('{}','{}','item','synthetic-receipt','synthetic-hash','{}'::jsonb)",a.id,a.box_id,sql_json(&originals[0].item)));
    originals
}
struct Plan {
    path: String,
    header: Value,
    wire: Value,
    stable: Vec<u8>,
    key: PasswordBoxKey,
    bindings: Vec<MigrationItemBinding>,
    sdk: MigrationTransportPlan,
}
fn prepare(p: u16, a: &Account, originals: &[Original]) -> Plan {
    prepare_routes(p, a, originals, false)
}
fn prepare_routes(p: u16, a: &Account, originals: &[Original], remap: bool) -> Plan {
    let client = sdk(p, a);
    let rt = runtime();
    let snapshot = sdk_ok(rt.block_on(client.migration_source(&a.box_id)));
    let revision = snapshot.source_revision;
    let mut after: Option<String> = None;
    let mut ids = Vec::new();
    loop {
        let page = sdk_ok(rt.block_on(client.migration_source_items(
            &a.box_id,
            revision,
            after.as_deref(),
        )));
        verify(page.items.len() <= 100, "source page limit");
        ids.extend(page.items.iter().map(|i| i.id.to_string()));
        after = page.after.map(|c| c.to_string());
        if after.is_none() {
            break;
        }
    }
    let mut expected = originals
        .iter()
        .map(|o| o.item["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    expected.sort();
    verify(
        ids == expected,
        "complete independent source item inventory",
    );
    let mut sources = Vec::new();
    let mut bindings = Vec::new();
    for original in originals {
        let id = original.item["id"].as_str().unwrap();
        let context: ItemContext = checked(
            serde_json::from_value(
                json!({"passwordBoxId":a.box_id,"itemId":id,"itemVersion":17,"keyEpoch":1}),
            ),
            "independent item context",
        );
        let fetched = sdk_ok(rt.block_on(client.migration_source_item(revision, &context)));
        verify(
            fetched.json() == &original.item,
            "SDK complete original JSON and numeric values",
        );
        let mut attachments = Vec::new();
        let mut target = context.clone();
        if remap {
            target.item_id = ConnectId::generate().unwrap();
        }
        let mut file_bindings = Vec::new();
        for (c, name, bytes, available) in &original.files {
            let file = sdk_ok(rt.block_on(client.migration_source_file(revision, c)));
            match &file {
                MigrationSourceFile::Available(file) => verify(
                    *available && file.name() == name && file.content() == bytes,
                    "SDK actual source filename and all bytes including empty",
                ),
                MigrationSourceFile::Missing { metadata } => verify(
                    !available
                        && metadata.json()["content"].is_null()
                        && metadata.json()["contentBytes"] == bytes.len()
                        && metadata.json()["name"] == *name,
                    "SDK missing source content remains distinct from empty",
                ),
            }
            attachments.push(MigrationAttachmentSource {
                context: c.clone(),
                plaintext: checked(
                    AttachmentPlaintext::new(name.to_owned(), bytes.clone()),
                    "trusted archive actual file bytes",
                ),
            });
            let mut target_file = c.clone();
            target_file.item_id = target.item_id.clone();
            if remap {
                target_file.attachment_id = ConnectId::generate().unwrap();
            }
            file_bindings.push(MigrationAttachmentBinding {
                source: c.clone(),
                target: target_file,
            });
        }
        sources.push(MigrationItemSource {
            item: fetched,
            attachments,
        });
        bindings.push(MigrationItemBinding {
            source: context.clone(),
            target,
            attachments: file_bindings,
        });
    }
    let key = checked(PasswordBoxKey::generate(), "OS box key");
    let owner = owner_context(&a.box_id, &a.id, 1);
    let trusted = checked(
        TrustedOwnerKeyContext::new(owner.clone()),
        "independent owner context",
    );
    let operation = checked(
        serde_json::from_value(json!(format!(
            "{}-{}-4{}-a{}-{}",
            hex_entropy(8),
            hex_entropy(4),
            hex_entropy(3),
            hex_entropy(3),
            hex_entropy(12)
        ))),
        "OS operation UUID",
    );
    let prepared = checked(
        prepare_migration(
            &key,
            &trusted,
            operation,
            &serde_json::from_value(json!(a.box_id)).unwrap(),
            revision,
            &sources,
            &bindings,
        ),
        "Core finite prepare",
    );
    let stable = prepared.replay_bytes().to_vec();
    verify(
        stable == prepared.replay_bytes(),
        "Core stable bytes reused without encryption/nonces",
    );
    let wire: Value = checked(serde_json::from_slice(&stable), "Core ciphertext wire");
    let mut header = wire.clone();
    header.as_object_mut().unwrap().remove("items");
    header["itemCount"] = json!(snapshot.item_count);
    header["attachmentCount"] = json!(snapshot.attachment_count);
    header["ownerBundle"] = owner_bundle(&key, &a.master, a.salt, &owner);
    let sdk = checked(
        MigrationTransportPlan::new(
            &prepared,
            checked(
                serde_json::from_value(header["ownerBundle"].clone()),
                "SDK opaque owner bundle",
            ),
        ),
        "SDK frozen Core transport plan",
    );
    verify(
        serde_json::from_slice::<Value>(sdk.header_request_bytes()).unwrap() == header,
        "SDK header keeps Core operation and owner bindings",
    );
    verify(
        sdk.core_replay_bytes() == stable,
        "SDK retains exact original Core replay bytes",
    );
    let path = format!(
        "/api/encrypted/boxes/{}/migrations/{}",
        a.box_id,
        wire["operationId"].as_str().unwrap()
    );
    Plan {
        path,
        header,
        wire,
        stable,
        key,
        bindings,
        sdk,
    }
}
fn hex_entropy(n: usize) -> String {
    generate_salt()
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..n]
        .to_owned()
}
fn stage(p: u16, a: &Account, plan: &Plan, files: bool) {
    let client = sdk(p, a);
    let rt = runtime();
    sdk_ok(rt.block_on(client.stage_migration_header(&plan.sdk)));
    for (index, item) in plan.wire["items"].as_array().unwrap().iter().enumerate() {
        sdk_ok(rt.block_on(client.stage_migration_item(&plan.sdk, index)));
        if files {
            for (file, _) in item["attachments"].as_array().unwrap().iter().enumerate() {
                sdk_ok(rt.block_on(client.stage_migration_file(&plan.sdk, index, file)));
            }
        }
    }
}
fn readback(p: u16, a: &Account, plan: &Plan, originals: &[Original], committed: bool) {
    let client = sdk(p, a);
    let rt = runtime();
    let bundle = if committed {
        request(
            p,
            a,
            "GET",
            &format!("/api/encrypted/boxes/{}/owner-key", a.box_id),
            &Value::Null,
            200,
        )["bundle"]
            .clone()
    } else {
        json!(
            sdk_ok(rt.block_on(client.migration_status(&plan.sdk)))
                .header
                .owner_bundle
        )
    };
    let key = checked(
        unwrap_bundle(
            &bundle,
            &a.encryption_password,
            &owner_context(&a.box_id, &a.id, 1),
        ),
        "client unwrap fetched owner bundle",
    );
    let wrong = checked(PasswordBoxKey::generate(), "independent wrong key");
    for (index, (prepared, original)) in plan.wire["items"]
        .as_array()
        .unwrap()
        .iter()
        .zip(originals)
        .enumerate()
    {
        let ctx = plan.bindings[index].target.clone();
        let path = if committed {
            format!("/api/encrypted/boxes/{}/items/{}", a.box_id, ctx.item_id)
        } else {
            format!("{}/items/{}", plan.path, ctx.item_id)
        };
        let wire = if committed {
            request(p, a, "GET", &path, &Value::Null, 200)
        } else {
            json!(sdk_ok(rt.block_on(client.staged_migration_item(&plan.sdk, index))).envelope)
        };
        verify(
            wire == prepared["envelope"],
            "exact nonce and ciphertext after formal API read",
        );
        let envelope: EncryptedItem = checked(serde_json::from_value(wire), "Core item decode");
        let opened = checked(
            key.decrypt_item(&envelope, &ctx),
            "Core decrypt fetched staged/active item",
        );
        let expected_refs = plan.bindings[index].attachments.iter().map(|b|json!({"attachmentId":b.target.attachment_id,"attachmentVersion":17,"keyEpoch":1})).collect::<Vec<_>>();
        verify(
            opened
                == json!({"id":ctx.item_id,"version":17,"vault":{"id":a.box_id},"attachments":expected_refs,"original":original.item}),
            "independent complete wrapper and full original equality",
        );
        verify(
            wrong.decrypt_item(&envelope, &ctx).is_err(),
            "Core wrong key rejected",
        );
        let mut bad = ctx.clone();
        bad.item_version = 18;
        verify(
            key.decrypt_item(&envelope, &bad).is_err(),
            "Core independent wrong context rejected",
        );
        for (file_index, ((_, name, bytes, _), binding)) in original
            .files
            .iter()
            .zip(&plan.bindings[index].attachments)
            .enumerate()
        {
            let c = &binding.target;
            let path = if committed {
                let state = request(
                    p,
                    a,
                    "GET",
                    &format!("/api/encrypted/boxes/{}/sharing-snapshot", a.box_id),
                    &Value::Null,
                    200,
                );
                format!(
                    "/api/encrypted/boxes/{}/items/{}/attachments/{}?revision={}",
                    a.box_id, c.item_id, c.attachment_id, state["stateRevision"]
                )
            } else {
                format!(
                    "{}/items/{}/files/{}",
                    plan.path, c.item_id, c.attachment_id
                )
            };
            let returned = if committed {
                request(p, a, "GET", &path, &Value::Null, 200)
            } else {
                json!(sdk_ok(rt.block_on(
                    client.staged_migration_file(&plan.sdk, index, file_index)
                )))
            };
            let prepared_file = prepared["attachments"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["context"]["attachmentId"] == c.attachment_id.as_str())
                .unwrap();
            verify(
                returned == *prepared_file,
                "exact attachment ciphertext replay",
            );
            let envelope: EncryptedAttachment =
                checked(serde_json::from_value(returned), "Core file decode");
            let opened = checked(
                key.decrypt_attachment(&envelope, c),
                "Core independent file decrypt",
            );
            verify(
                opened.name() == name && opened.content() == bytes,
                "file name and all real bytes including zero file match",
            );
            let mut wrong_ref = c.clone();
            wrong_ref.attachment_version = 18;
            verify(
                key.decrypt_attachment(&envelope, &wrong_ref).is_err(),
                "Core wrong attachment reference rejected",
            );
        }
    }
    verify(
        plan.key
            .decrypt_item(
                &serde_json::from_value(plan.wire["items"][0]["envelope"].clone()).unwrap(),
                &serde_json::from_value(plan.wire["items"][0]["binding"]["target"].clone())
                    .unwrap(),
            )
            .is_ok(),
        "original plan key still opens",
    );
    verify(
        serde_json::from_slice::<Value>(&plan.stable).unwrap() == plan.wire,
        "retained original Core replay bytes parse to exact plan",
    );
    if committed {
        let state = request(
            p,
            a,
            "GET",
            &format!("/api/encrypted/boxes/{}/sharing-snapshot", a.box_id),
            &Value::Null,
            200,
        );
        let revision = state["stateRevision"].as_u64().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let client = checked(
                EncryptedSessionClient::new(&format!("http://127.0.0.1:{p}"), &a.session),
                "existing session SDK",
            );
            for (index, (prepared, original)) in plan.wire["items"]
                .as_array()
                .unwrap()
                .iter()
                .zip(originals)
                .enumerate()
            {
                let context = plan.bindings[index].target.clone();
                let item = checked(
                    client.get_item(&a.box_id, context.item_id.as_str()).await,
                    "existing SDK item read",
                );
                SDK_READS.fetch_add(1, Ordering::Relaxed);
                verify(
                    serde_json::to_value(&item).unwrap() == prepared["envelope"],
                    "existing SDK exact ciphertext with preserved version",
                );
                verify(
                    key.decrypt_item(&item, &context).unwrap()["original"] == original.item,
                    "existing SDK Core full original readback",
                );
                for ((_, name, bytes, _), binding) in
                    original.files.iter().zip(&plan.bindings[index].attachments)
                {
                    let context = &binding.target;
                    let file = checked(
                        client.get_attachment(revision, context).await,
                        "existing SDK file read",
                    );
                    SDK_READS.fetch_add(1, Ordering::Relaxed);
                    let opened = checked(
                        key.decrypt_attachment(&file, context),
                        "existing SDK independent Core file open",
                    );
                    verify(
                        opened.name() == name && opened.content() == bytes,
                        "existing SDK exact attachment name and bytes",
                    );
                }
            }
        });
    }
}

pub(crate) fn run(db: &Database, network: &Network, mode: &Mode) {
    let host = Host::start(db, network, mode);
    let p = host.port;
    let a = Account::signup(p);
    let outsider = Account::signup(p);
    db.sql("DO $$ DECLARE actor uuid; operation text; BEGIN BEGIN PERFORM request_key FROM mutation_operations WHERE resource='synthetic-diagnostic-only' ORDER BY actor,resource,operation,request_key FOR UPDATE; RAISE EXCEPTION 'original SQL ambiguity was not reproduced'; EXCEPTION WHEN ambiguous_column THEN NULL; END; END $$");
    println!("migration diagnostics: original unqualified SQL ambiguity reproduced SQLSTATE=42702; wait predicates use PostgreSQL booleans");
    verify(db.sql("SELECT passshare_migration_budget(1073741824,1024) AND NOT passshare_migration_budget(1073741825,1024) AND NOT passshare_migration_budget(0,1025) AND NOT passshare_migration_budget(-1,0)")=="t","server budget exact boundary without allocating 1GiB");
    let mut originals = fixture(db, &a, 101);
    // Invalid source associations are refused before any source-stage state is
    // created. This includes explicit NULL and duplicate reference ambiguity.
    let source_id = originals[0].item["id"].as_str().unwrap();
    for bad in [
        Value::Null,
        json!([
            originals[0].item["attachments"][0],
            originals[0].item["attachments"][0]
        ]),
        json!([{"attachmentId":ConnectId::generate().unwrap(),"attachmentVersion":17,"keyEpoch":1}]),
    ] {
        let mut dto = originals[0].item.clone();
        dto["attachments"] = bad;
        db.sql(&format!(
            "UPDATE connect_items SET document='{}'::jsonb WHERE id='{source_id}'",
            sql_json(&dto)
        ));
        reject(db, p, &a, "GET", &source_path(&a), &Value::Null, 409);
    }
    db.sql(&format!(
        "UPDATE connect_items SET document='{}'::jsonb WHERE id='{source_id}'",
        sql_json(&originals[0].item)
    ));
    println!("migration phase=full_source_prepare item_inventory=101");
    let plan = prepare(p, &a, &originals);
    let client = sdk(p, &a);
    let other = sdk(p, &outsider);
    sdk_reject(db, 403, "PS016", other.migration_source(&a.box_id));
    let absent = ConnectId::generate().unwrap();
    sdk_reject(
        db,
        409,
        "PS015",
        client.migration_source_items(
            &a.box_id,
            plan.sdk.header().source_revision,
            Some(absent.as_str()),
        ),
    );
    let bad_selector = format!(
        "{}/items?revision={}&after={}",
        source_path(&a),
        plan.header["sourceRevision"],
        ConnectId::generate().unwrap()
    );
    reject(db, p, &a, "GET", &bad_selector, &Value::Null, 409);
    let before = original_rows(db, &a.box_id);
    stage(p, &a, &plan, false);
    sdk_reject(db, 409, "PS015", client.commit_migration(&plan.sdk));
    verify(
        original_rows(db, &a.box_id) == before,
        "prepare/stage retains full original rows and xmin",
    );
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        409,
    );
    reject(db, p, &outsider, "GET", &source_path(&a), &Value::Null, 403);
    let mut wrong_owner = plan.header.clone();
    wrong_owner["ownerContext"]["ownerAccountId"] = json!(outsider.id);
    reject(db, p, &a, "PUT", &plan.path, &wrong_owner, 400);
    let item = &plan.wire["items"][0];
    let id = item["binding"]["target"]["itemId"].as_str().unwrap();
    let payload = json!({"binding":item["binding"],"envelope":item["envelope"]});
    replay(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{id}", plan.path),
        &payload,
    );
    // Express matches static path segments without case sensitivity. Verify
    // the same alias actually reaches replay before using it as a negative.
    let alias = format!("{}/items/{id}", plan.path)
        .replace("/api/encrypted/boxes/", "/API/ENCRYPTED/BOXES/")
        .replace("/migrations/", "/MIGRATIONS/")
        .replace("/items/", "/ITEMS/");
    replay(db, p, &a, "PUT", &alias, &payload);
    for raw in [
        payload
            .to_string()
            .replacen("\"format\":1", "\"format\":1.0", 1),
        payload
            .to_string()
            .replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
    ] {
        let before = acceptance_state_hash(db);
        let reply = http_payload(
            p,
            "PUT",
            &alias,
            &format!("Authorization: Bearer {}\r\n", a.session),
            &raw,
        );
        verify(
            reply.0 == 400,
            "case alias cannot bypass raw duplicate/float rejection",
        );
        verify(
            acceptance_state_hash(db) == before,
            "lexically ambiguous rejection preserves all rows and xmin",
        );
        REJECTIONS.fetch_add(1, Ordering::Relaxed);
    }
    let mut changed = payload.clone();
    changed["envelope"]["nonce"] = json!(BASE64.encode(
        generate_salt()
            .unwrap()
            .into_iter()
            .chain([0u8; 8])
            .collect::<Vec<_>>()
    ));
    reject(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{id}", plan.path),
        &changed,
        409,
    );
    let mut extra = payload.clone();
    extra["binding"]["source"]["itemId"] = json!(ConnectId::generate().unwrap());
    reject(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{id}", plan.path),
        &extra,
        400,
    );
    for file in item["attachments"].as_array().unwrap() {
        let fid = file["context"]["attachmentId"].as_str().unwrap();
        let path = format!("{}/items/{id}/files/{fid}", plan.path);
        let payload = json!({"envelope":file});
        request(p, &a, "PUT", &path, &payload, 200);
        replay(db, p, &a, "PUT", &path, &payload);
        let mut bad = payload.clone();
        bad["envelope"]["context"]["attachmentVersion"] = json!(18);
        reject(db, p, &a, "PUT", &path, &bad, 409);
    }
    readback(p, &a, &plan, &originals, false);
    println!("migration phase=independent_staged_readback_passed");
    // Prove atomic rollback with a fault AFTER the first original row deletion.
    println!("migration phase=transaction_fault");
    db.sql("CREATE FUNCTION passshare_migration_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='synthetic migration rollback'; END $$; CREATE TRIGGER passshare_migration_fixture_fault AFTER DELETE ON connect_items FOR EACH ROW EXECUTE FUNCTION passshare_migration_fixture_fault();");
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        503,
    );
    db.sql("DROP TRIGGER passshare_migration_fixture_fault ON connect_items; DROP FUNCTION passshare_migration_fixture_fault();");
    // Same operation ID cannot be reused for a new ciphertext or owner bundle.
    let mut bad = plan.header.clone();
    bad["ownerBundle"]["salt"] = json!(BASE64.encode(generate_salt().unwrap()));
    reject(db, p, &a, "PUT", &plan.path, &bad, 409);
    // Current source edits and removal advance authoritative generation even
    println!("migration phase=feature_off_legacy_edit");
    // on a host with encrypted HTTP disabled. No caller hash can hide changes.
    let off = Host::with_storage(db, network, mode, false);
    let source_id = originals[1].item["id"].as_str().unwrap().to_owned();
    let edit_path = format!("/v1/vaults/{}/items/{source_id}", a.box_id);
    let (status, edited) = http(
        off.port,
        "PUT",
        &edit_path,
        &format!("Authorization: Bearer {}\r\n", a.connect),
        &originals[1].item,
    );
    verify(
        status == 200 && edited["version"] == 18,
        "legacy feature-off accepted write changes generation",
    );
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        409,
    );
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    db.sql(&format!(
        "UPDATE connect_items SET document='{}'::jsonb WHERE id='{source_id}'",
        sql_json(&originals[1].item)
    ));
    // Pagination was independently checked with 101 source DTOs. The repeated
    // race/rollback fixtures need only two; stay inside real production budgets.
    let removed = originals[2..]
        .iter()
        .map(|o| format!("'{}'", o.item["id"].as_str().unwrap()))
        .collect::<Vec<_>>()
        .join(",");
    db.sql(&format!(
        "DELETE FROM connect_items WHERE id IN ({removed})"
    ));
    originals.truncate(2);
    let plan = prepare(p, &a, &originals);
    stage(p, &a, &plan, true);
    println!("migration phase=source_removal");
    db.sql(&format!("DELETE FROM connect_items WHERE id='{source_id}'"));
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        409,
    );
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    db.sql(&format!(
        "INSERT INTO connect_items(id,vault_id,document) VALUES('{source_id}','{}','{}'::jsonb)",
        a.box_id,
        sql_json(&originals[1].item)
    ));
    let plan = prepare(p, &a, &originals);
    stage(p, &a, &plan, true);
    // Published membership changes invalidate the plan; do not grant any key
    println!("migration phase=membership_change");
    // or synthetic other-recipient access. Restore only the same owner fixture.
    db.sql(&format!(
        "UPDATE vault_memberships SET confirmed_at=clock_timestamp() WHERE vault_id='{}'",
        a.box_id
    ));
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        409,
    );
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    let plan = prepare(p, &a, &originals);
    stage(p, &a, &plan, true);
    db.sql(&format!(
        "UPDATE vault_memberships SET role='member' WHERE vault_id='{}'",
        a.box_id
    ));
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        403,
    );
    db.sql(&format!(
        "UPDATE vault_memberships SET role='owner' WHERE vault_id='{}'",
        a.box_id
    ));
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    let plan = prepare(p, &a, &originals);
    stage(p, &a, &plan, true);
    db.sql(&format!("UPDATE encrypted_migrations SET expires_at=clock_timestamp()-interval '1 second' WHERE box_id='{}' AND status='pending'",a.box_id));
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        409,
    );
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    let plan = prepare(p, &a, &originals);
    stage(p, &a, &plan, true);
    db.sql(&format!(
        "UPDATE users SET email='{}@example.test' WHERE id='{}'",
        ConnectId::generate().unwrap(),
        a.id
    ));
    reject(
        db,
        p,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        409,
    );
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    let plan = prepare(p, &a, &originals);
    stage(p, &a, &plan, true);
    // Expiry during an observed parent-lock wait, after middleware admitted it.
    println!("migration phase=session_expiry_lock_wait");
    db.sql(&format!(
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id='{}'",
        a.id
    ));
    let label = format!("migration_wait_{}", hex_entropy(12));
    let mut held = HeldBox::start(db, &a.box_id, &label);
    verify(wait_db(db,&format!("SELECT count(*)>0 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction'")),"explicit parent lock acquired");
    let port = p;
    let token = a.session.clone();
    let path = format!("{}/commit", plan.path);
    let worker = thread::spawn(move || {
        http(
            port,
            "POST",
            &path,
            &format!("Authorization: Bearer {token}\r\n"),
            &Value::Null,
        )
        .0
    });
    verify(wait_db(db,"SELECT count(*)>0 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%passshare_migration_operation%'"),"commit reached DB lock wait before expiry");
    verify(wait_db(db,&format!("SELECT count(*)>0 FROM sessions WHERE user_id='{}' AND expires_at<=clock_timestamp()",a.id)),"session expired while blocked");
    let original_before = original_rows(db, &a.box_id);
    held.commit();
    verify(
        worker.join().unwrap() == 401,
        "final DB authorization rejects expired session after lock wait",
    );
    verify(
        original_rows(db, &a.box_id) == original_before,
        "expiry wait preserves original xmin",
    );
    db.sql(&format!(
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE user_id='{}'",
        a.id
    ));
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).cancel_migration(&plan.sdk)))
            == MigrationState::Aborted,
        "SDK explicit cancellation",
    );
    // Explicit no-token and foreign account tests on final prepared plan.
    let plan = prepare_routes(p, &a, &originals, true);
    request(p, &a, "PUT", &plan.path, &plan.header, 200);
    let mut cross = json!({"binding":plan.wire["items"][0]["binding"],"envelope":plan.wire["items"][0]["envelope"]});
    let other = originals[1].item["id"].as_str().unwrap();
    cross["binding"]["target"]["itemId"] = json!(other);
    cross["envelope"]["context"]["itemId"] = json!(other);
    for f in cross["binding"]["attachments"].as_array_mut().unwrap() {
        f["target"]["itemId"] = json!(other);
    }
    reject(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{other}", plan.path),
        &cross,
        409,
    );
    let target_id = plan.bindings[0].target.item_id.as_str();
    let mut cross = json!({"binding":plan.wire["items"][0]["binding"],"envelope":plan.wire["items"][0]["envelope"]});
    cross["binding"]["attachments"][0]["target"]["attachmentId"] =
        json!(originals[0].files[1].0.attachment_id);
    reject(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{target_id}", plan.path),
        &cross,
        409,
    );
    stage(p, &a, &plan, true);
    readback(p, &a, &plan, &originals, false);
    verify(
        http(
            p,
            "POST",
            &format!("{}/commit", plan.path),
            "",
            &Value::Null,
        )
        .0 == 401,
        "unauthenticated commit refused",
    );
    reject(
        db,
        p,
        &outsider,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
        403,
    );
    // Archive/restore includes nonempty migration headers/stages/counters.
    let restored = encrypted_restore::attachment_roundtrip(db, network);
    let resumed = Host::start(&restored, network, mode);
    readback(resumed.port, &a, &plan, &originals, false);
    drop(resumed);
    drop(restored);
    // Send commit then lose the response deliberately. Determine committed
    // state independently, then use explicit authenticated status + exact replay.
    let mut stream = TcpStream::connect(("127.0.0.1", p)).unwrap();
    write!(stream,"POST {}/commit HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nAuthorization: Bearer {}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",plan.path,a.session).unwrap();
    drop(stream);
    verify(wait_db(db,&format!("SELECT count(*)>0 FROM encrypted_migrations WHERE box_id='{}' AND status='committed'",a.box_id)),"commit response loss independently observed committed state");
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).migration_status(&plan.sdk))).status
            == MigrationState::Committed,
        "explicit status before replay",
    );
    let before = acceptance_state_hash(db);
    verify(
        sdk_ok(runtime().block_on(sdk(p, &a).commit_migration(&plan.sdk)))
            == MigrationState::Committed,
        "explicit SDK commit retry after authenticated status",
    );
    verify(
        acceptance_state_hash(db) == before,
        "SDK explicit committed retry preserves every row and xmin",
    );
    REPLAYS.fetch_add(1, Ordering::Relaxed);
    replay(db, p, &a, "PUT", &plan.path, &plan.header);
    let item = &plan.wire["items"][0];
    let id = item["binding"]["target"]["itemId"].as_str().unwrap();
    replay(
        db,
        p,
        &a,
        "PUT",
        &format!("{}/items/{id}", plan.path),
        &json!({"binding":item["binding"],"envelope":item["envelope"]}),
    );
    readback(p, &a, &plan, &originals, true);
    verify(db.sql(&format!("SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{}' AND last_live_version=17",a.box_id))=="2","remapped source item IDs reserved at preserved versions");
    verify(db.sql(&format!("SELECT count(*) FROM encrypted_attachment_tombstones WHERE box_id='{}' AND last_live_version=17",a.box_id))=="3","remapped source file IDs reserved at preserved versions");
    verify(
        db.sql(&format!(
            "SELECT count(*) FROM connect_items WHERE vault_id='{}'",
            a.box_id
        )) == "0",
        "legacy item plaintext absent from active public rows",
    );
    verify(
        db.sql("SELECT count(*) FROM connect_item_files") == "0",
        "all legacy file names and bytes removed",
    );
    verify(
        db.sql(&format!(
            "SELECT count(*) FROM mutation_operations WHERE resource='{}'",
            a.box_id
        )) == "0",
        "legacy plaintext mutation receipts removed",
    );
    verify(
        http(
            off.port,
            "GET",
            &edit_path,
            &format!("Authorization: Bearer {}\r\n", a.connect),
            &Value::Null,
        )
        .0 == 409,
        "flag-off instance observes ciphertext boundary",
    );
    let restored = encrypted_restore::attachment_roundtrip(db, network);
    let resumed = Host::start(&restored, network, mode);
    readback(resumed.port, &a, &plan, &originals, true);
    replay(
        &restored,
        resumed.port,
        &a,
        "POST",
        &format!("{}/commit", plan.path),
        &Value::Null,
    );
    drop(resumed);
    drop(restored);
    drop(off);
    drop(host);
    println!("migration acceptance checks={} rejected_unchanged={} exact_replays={} sdk_successful_requests={} source_pagination_items=101 committed_items=2 files=3 preserved_item_version=17 preserved_file_version=17 response_loss=1 source_archive_missing_binary=1; pending+committed restore full public equality; Core client staged+active readback; no parsers/UI/all-client claim",CHECKS.load(Ordering::Relaxed),REJECTIONS.load(Ordering::Relaxed),REPLAYS.load(Ordering::Relaxed),SDK_READS.load(Ordering::Relaxed));
}
