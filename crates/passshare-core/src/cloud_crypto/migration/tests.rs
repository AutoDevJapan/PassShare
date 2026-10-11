use super::*;

struct Fixture {
    key: PasswordBoxKey,
    owner: TrustedOwnerKeyContext,
    source_box: ConnectId,
    operation: Uuid,
    sources: Vec<MigrationItemSource>,
    bindings: Vec<MigrationItemBinding>,
}

fn only_public_fields(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().all(|(name, value)| {
            matches!(
                name.as_str(),
                "format"
                    | "operationId"
                    | "ownerContext"
                    | "sourcePasswordBoxId"
                    | "sourceRevision"
                    | "items"
                    | "binding"
                    | "source"
                    | "target"
                    | "attachments"
                    | "envelope"
                    | "context"
                    | "passwordBoxId"
                    | "ownerAccountId"
                    | "keyEpoch"
                    | "itemId"
                    | "itemVersion"
                    | "attachmentId"
                    | "attachmentVersion"
                    | "contentBytes"
                    | "nonce"
                    | "ciphertext"
            ) && only_public_fields(value)
        }),
        Value::Array(values) => values.iter().all(only_public_fields),
        _ => true,
    }
}

impl Fixture {
    fn new() -> Self {
        let source_box = ConnectId::generate().unwrap();
        let target_box = ConnectId::generate().unwrap();
        let owner = TrustedOwnerKeyContext::new(OwnerKeyContext {
            password_box_id: target_box.clone(),
            owner_account_id: Uuid::new_v4(),
            key_epoch: 3,
        })
        .unwrap();
        let mut fixture = Self {
            key: PasswordBoxKey::generate().unwrap(),
            owner,
            source_box,
            operation: Uuid::new_v4(),
            sources: Vec::new(),
            bindings: Vec::new(),
        };
        for index in 0..2 {
            let source = ItemContext {
                password_box_id: fixture.source_box.clone(),
                item_id: ConnectId::generate().unwrap(),
                item_version: 17 + index,
                key_epoch: 1,
            };
            let target = ItemContext {
                password_box_id: target_box.clone(),
                item_id: ConnectId::generate().unwrap(),
                item_version: source.item_version,
                key_epoch: 3,
            };
            let mut attachments = Vec::new();
            let mut files = Vec::new();
            let mut references = Vec::new();
            // Duplicate names/contents are allowed; identities must be distinct.
            for (name, content) in [
                ("", vec![]),
                ("添付🌏.bin", vec![0, 0xff, 0x80, 0]),
                ("添付🌏.bin", vec![0, 0xff, 0x80, 0]),
            ] {
                let context = AttachmentContext {
                    password_box_id: source.password_box_id.clone(),
                    item_id: source.item_id.clone(),
                    attachment_id: ConnectId::generate().unwrap(),
                    attachment_version: 9,
                    key_epoch: 1,
                };
                references.push(serde_json::json!({
                    "attachmentId": context.attachment_id, "attachmentVersion": 9,
                    "keyEpoch": 1, "name": name, "contentBytes": content.len(),
                    "unknownFileMetadata": [false, {"original": "untouched"}],
                }));
                attachments.push(MigrationAttachmentBinding {
                    source: context.clone(),
                    target: AttachmentContext {
                        password_box_id: target.password_box_id.clone(),
                        item_id: target.item_id.clone(),
                        attachment_id: ConnectId::generate().unwrap(),
                        attachment_version: 9,
                        key_epoch: 3,
                    },
                });
                files.push(MigrationAttachmentSource {
                    context,
                    plaintext: AttachmentPlaintext::new(name.to_owned(), content).unwrap(),
                });
            }
            files.reverse(); // Matching must use exact identity, not input position.
            let mut random = Zeroizing::new([0u8; 32]);
            getrandom::fill(random.as_mut()).unwrap();
            let secret = Zeroizing::new(BASE64.encode(random.as_ref()));
            let value = serde_json::json!({
                "id": source.item_id, "version": source.item_version, "vault": {"id": source.password_box_id, "extension": "保管"},
                "title": "移行する項目", "category": "CUSTOM", "fields": [{"id": ConnectId::generate().unwrap(), "label": "private", "type": "CONCEALED", "value": secret.as_str(), "extra": [3,2,1]}],
                "createdAt": "2026-10-10T00:00:00Z", "updatedAt": "2026-10-11T00:00:00Z",
                "urls": [{"href": "https://example.invalid/two", "unknown": [2,1]}, {"href": "https://example.invalid/one"}],
                "attachments": references,
                "original": {"unknown": "do not overwrite me"}, "future": {"array": [null, true, 2, {"新しい属性": [9,7,8]}]},
            });
            fixture.sources.push(MigrationItemSource {
                item: MigrationItemPlaintext::new(value).unwrap(),
                attachments: files,
            });
            fixture.bindings.push(MigrationItemBinding {
                source,
                target,
                attachments,
            });
        }
        fixture
    }

    fn prepare(&self) -> Result<PreparedMigration> {
        prepare_migration(
            &self.key,
            &self.owner,
            self.operation,
            &self.source_box,
            42,
            &self.sources,
            &self.bindings,
        )
    }

    fn snapshot(&self) -> Vec<Zeroizing<Vec<u8>>> {
        self.sources
            .iter()
            .map(|source| Zeroizing::new(serde_json::to_vec(source.item.json()).unwrap()))
            .collect()
    }

    fn unchanged(&self, before: &[Zeroizing<Vec<u8>>]) -> bool {
        self.sources.iter().zip(before).all(|(source, bytes)| {
            let after = Zeroizing::new(serde_json::to_vec(source.item.json()).unwrap());
            after.as_slice() == bytes.as_slice()
        })
    }

    fn rejected_unchanged(&self) {
        let before = self.snapshot();
        let bytes: Vec<_> = self
            .sources
            .iter()
            .flat_map(|source| &source.attachments)
            .map(|file| {
                (
                    Zeroizing::new(file.plaintext.name().to_owned()),
                    Zeroizing::new(file.plaintext.content().to_vec()),
                )
            })
            .collect();
        assert!(self.prepare().is_err());
        assert!(self.unchanged(&before));
        assert!(self
            .sources
            .iter()
            .flat_map(|source| &source.attachments)
            .zip(bytes)
            .all(|(file, (name, content))| {
                file.plaintext.name() == name.as_str()
                    && file.plaintext.content() == content.as_slice()
            }));
    }
}

#[test]
fn full_dto_names_arbitrary_bytes_and_order_survive_real_crypto() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let plan = fixture.prepare().unwrap();
    assert!(fixture.unchanged(&before));
    assert!(plan.operation_id() == fixture.operation);
    for ((prepared, source), expected) in plan
        .items()
        .iter()
        .zip(&fixture.sources)
        .zip(&fixture.bindings)
    {
        let decoded = MigrationItemPlaintext::new(
            fixture
                .key
                .decrypt_item(prepared.envelope(), &expected.target)
                .unwrap(),
        )
        .unwrap();
        assert!(decoded.json()["original"] == *source.item.json());
        assert!(decoded.json()["version"] == expected.source.item_version);
        assert!(decoded.json()["id"] == expected.target.item_id.as_str());
        assert!(decoded.json()["original"]["id"] == expected.source.item_id.as_str());
        assert!(prepared.binding() == expected);
        for ((encrypted, binding), reference) in prepared
            .attachments()
            .iter()
            .zip(&expected.attachments)
            .zip(decoded.json()["attachments"].as_array().unwrap())
        {
            let plaintext = fixture
                .key
                .decrypt_attachment(encrypted, &binding.target)
                .unwrap();
            let original = file(source, binding).unwrap();
            assert!(
                plaintext.name() == original.name() && plaintext.content() == original.content()
            );
            assert!(reference["attachmentId"] == binding.target.attachment_id.as_str());
            assert!(reference["attachmentVersion"] == 9 && reference["keyEpoch"] == 3);
        }
        // Useful negative comparisons: a serializer dropping any of these must
        // fail full-object equality, even if id/title/typed fields still match.
        for pointer in [
            "/future",
            "/urls/0/unknown",
            "/fields/0/extra",
            "/attachments/2/unknownFileMetadata",
            "/original",
        ] {
            assert!(
                decoded.json()["original"].pointer(pointer) == source.item.json().pointer(pointer)
            );
            assert!(decoded.json()["original"].pointer(pointer).is_some());
        }
    }
}

#[test]
fn replay_is_stable_public_only_and_new_preparation_is_fresh() {
    let fixture = Fixture::new();
    let plan = fixture.prepare().unwrap();
    let replay = plan.replay_bytes().to_vec();
    assert!(plan.replay_bytes() == replay);
    let wire: Value = serde_json::from_slice(&replay).unwrap();
    assert!(wire["operationId"] == fixture.operation.to_string());
    assert!(wire["sourceRevision"] == 42);
    assert!(
        wire["items"][0]["envelope"] == serde_json::to_value(plan.items()[0].envelope()).unwrap()
    );
    let text = std::str::from_utf8(&replay).unwrap();
    for source in &fixture.sources {
        assert!(!text.contains(source.item.json()["title"].as_str().unwrap()));
        assert!(!text.contains(source.item.json()["fields"][0]["value"].as_str().unwrap()));
        assert!(!text.contains("添付🌏.bin"));
    }
    assert!(only_public_fields(&wire));
    for forbidden in ["original", "name", "sourceHash", "rawKey"] {
        let mut leaked = wire.clone();
        leaked["items"][0]
            .as_object_mut()
            .unwrap()
            .insert(forbidden.into(), serde_json::json!("forbidden"));
        assert!(!only_public_fields(&leaked));
    }
    let fresh = fixture.prepare().unwrap();
    assert!(fresh.operation_id() == plan.operation_id());
    assert!(fresh.items()[0].envelope().nonce != plan.items()[0].envelope().nonce);
    assert!(fresh.replay_bytes() != replay);
}

#[test]
fn editing_only_title_retains_every_other_original_property_and_files() {
    let mut fixture = Fixture::new();
    let before = fixture.snapshot();
    fixture.sources[0].item.0["title"] = Value::String("変更したタイトル".into());
    let plan = fixture.prepare().unwrap();
    let decoded = MigrationItemPlaintext::new(
        fixture
            .key
            .decrypt_item(plan.items()[0].envelope(), &fixture.bindings[0].target)
            .unwrap(),
    )
    .unwrap();
    let mut expected =
        MigrationItemPlaintext::new(serde_json::from_slice(&before[0]).unwrap()).unwrap();
    expected.0["title"] = Value::String("変更したタイトル".into());
    assert!(decoded.json()["original"] == *expected.json());
    assert!(plan.items()[0].attachments().len() == 3);
}

#[test]
fn missing_and_extra_file_byte_sets_are_rejected() {
    let mut fixture = Fixture::new();
    fixture.sources[0].attachments.pop();
    fixture.rejected_unchanged();
    let mut fixture = Fixture::new();
    let extra = MigrationAttachmentSource {
        context: fixture.bindings[0].attachments[0].source.clone(),
        plaintext: AttachmentPlaintext::new(String::new(), Vec::new()).unwrap(),
    };
    fixture.sources[0].attachments.push(extra);
    fixture.rejected_unchanged();
}

#[test]
fn equal_count_with_duplicate_or_wrong_source_files_is_rejected() {
    for duplicate in [false, true] {
        let mut fixture = Fixture::new();
        fixture.sources[0].attachments[0].context = if duplicate {
            fixture.sources[0].attachments[1].context.clone()
        } else {
            fixture.sources[1].attachments[0].context.clone()
        };
        fixture.rejected_unchanged();
    }
}

#[test]
fn duplicate_references_and_wrong_reference_order_are_rejected() {
    let mut fixture = Fixture::new();
    fixture.sources[0].item.0["attachments"][1] =
        fixture.sources[0].item.0["attachments"][0].clone();
    fixture.rejected_unchanged();
    let mut fixture = Fixture::new();
    fixture.bindings[0].attachments.swap(0, 1);
    fixture.rejected_unchanged();
    let mut fixture = Fixture::new();
    fixture.bindings[0].attachments[1] = fixture.bindings[0].attachments[0].clone();
    fixture.rejected_unchanged();
}

#[test]
fn duplicate_source_and_target_item_identities_are_rejected() {
    let mut fixture = Fixture::new();
    fixture.bindings[1].source = fixture.bindings[0].source.clone();
    fixture.rejected_unchanged();
    let mut fixture = Fixture::new();
    fixture.bindings[1].target.item_id = fixture.bindings[0].target.item_id.clone();
    fixture.rejected_unchanged();
    let mut fixture = Fixture::new();
    fixture.bindings[0].attachments[1].target.attachment_id = fixture.bindings[0].attachments[0]
        .target
        .attachment_id
        .clone();
    fixture.rejected_unchanged();
}

#[test]
fn item_original_identity_and_independent_version_must_match() {
    for field in ["id", "version", "vault"] {
        let mut fixture = Fixture::new();
        fixture.sources[0].item.0[field] = match field {
            "id" => Value::String(ConnectId::generate().unwrap().to_string()),
            "version" => serde_json::json!(1),
            _ => serde_json::json!({"id": ConnectId::generate().unwrap()}),
        };
        fixture.rejected_unchanged();
    }
}

#[test]
fn versions_cannot_reset_or_be_zero_or_unsafe() {
    for version in [0, 1, MAX_JSON_INTEGER + 1] {
        let mut fixture = Fixture::new();
        fixture.bindings[0].target.item_version = version;
        fixture.rejected_unchanged();
        let mut fixture = Fixture::new();
        fixture.bindings[0].attachments[0].target.attachment_version = version;
        fixture.rejected_unchanged();
    }
    for revision in [0, MAX_JSON_INTEGER + 1] {
        let fixture = Fixture::new();
        assert!(prepare_migration(
            &fixture.key,
            &fixture.owner,
            fixture.operation,
            &fixture.source_box,
            revision,
            &fixture.sources,
            &fixture.bindings
        )
        .is_err());
    }
}

#[test]
fn owner_box_epoch_and_source_box_are_independent_requirements() {
    for variant in 0..5 {
        let mut fixture = Fixture::new();
        match variant {
            0 => fixture.source_box = ConnectId::generate().unwrap(),
            1 => fixture.bindings[0].target.password_box_id = ConnectId::generate().unwrap(),
            2 => fixture.bindings[0].target.key_epoch += 1,
            3 => fixture.bindings[0].source.key_epoch = 0,
            _ => fixture.operation = Uuid::nil(),
        }
        fixture.rejected_unchanged();
    }
    let mut context = Fixture::new().owner.0;
    context.owner_account_id = Uuid::nil();
    assert!(TrustedOwnerKeyContext::new(context).is_err());
}

#[test]
fn cross_item_cross_box_and_wrong_file_versions_are_rejected() {
    for variant in 0..8 {
        let mut fixture = Fixture::new();
        let other_item = fixture.bindings[1].source.item_id.clone();
        let binding = &mut fixture.bindings[0].attachments[0];
        match variant {
            0 => binding.source.item_id = other_item,
            1 => binding.source.password_box_id = ConnectId::generate().unwrap(),
            2 => binding.source.attachment_version += 1,
            3 => binding.source.key_epoch += 1,
            4 => binding.target.item_id = ConnectId::generate().unwrap(),
            5 => binding.target.password_box_id = ConnectId::generate().unwrap(),
            6 => binding.target.key_epoch += 1,
            _ => binding.source.attachment_version = 0,
        }
        fixture.rejected_unchanged();
    }
}

#[test]
fn metadata_cannot_substitute_for_bytes_or_a_different_name() {
    for (field, value) in [
        ("name", serde_json::json!("別名")),
        ("contentBytes", serde_json::json!(123)),
        ("attachmentVersion", serde_json::json!(1)),
        ("keyEpoch", serde_json::json!(2)),
        (
            "attachmentId",
            serde_json::json!(ConnectId::generate().unwrap()),
        ),
    ] {
        let mut fixture = Fixture::new();
        fixture.sources[0].item.0["attachments"][0][field] = value;
        fixture.rejected_unchanged();
    }
}

#[test]
fn invalid_reference_shapes_and_incomplete_bindings_are_rejected() {
    for value in [
        Value::Null,
        serde_json::json!({}),
        serde_json::json!([null]),
        serde_json::json!([{}]),
    ] {
        let mut fixture = Fixture::new();
        fixture.sources[0].item.0["attachments"] = value;
        fixture.rejected_unchanged();
    }
    let mut fixture = Fixture::new();
    fixture.bindings.pop();
    fixture.rejected_unchanged();
}

#[test]
fn ciphertext_requires_independent_item_and_attachment_context_and_key() {
    let fixture = Fixture::new();
    let plan = fixture.prepare().unwrap();
    let prepared = &plan.items()[0];
    assert!(fixture
        .key
        .decrypt_item(prepared.envelope(), &fixture.bindings[1].target)
        .is_err());
    assert!(fixture
        .key
        .decrypt_attachment(
            &prepared.attachments()[0],
            &fixture.bindings[0].attachments[1].target
        )
        .is_err());
    let wrong_key = PasswordBoxKey::generate().unwrap();
    assert!(wrong_key
        .decrypt_item(prepared.envelope(), &fixture.bindings[0].target)
        .is_err());
    assert!(wrong_key
        .decrypt_attachment(
            &prepared.attachments()[0],
            &fixture.bindings[0].attachments[0].target
        )
        .is_err());
    let mut changed = prepared.envelope().clone();
    changed.context = fixture.bindings[1].target.clone();
    assert!(fixture
        .key
        .decrypt_item(&changed, &fixture.bindings[1].target)
        .is_err());
    let mut changed = prepared.attachments()[0].clone();
    changed.context = fixture.bindings[1].attachments[0].target.clone();
    assert!(fixture
        .key
        .decrypt_attachment(&changed, &fixture.bindings[1].attachments[0].target)
        .is_err());
}

#[test]
fn caller_owner_bundle_round_trip_uses_the_same_immutable_key() {
    let fixture = Fixture::new();
    let root = MasterKey::generate().unwrap();
    let bundle = fixture
        .key
        .wrap_for_owner(&root, fixture.owner.context())
        .unwrap();
    let restored =
        PasswordBoxKey::unwrap_for_owner(&bundle, &root, fixture.owner.context()).unwrap();
    let plan = fixture.prepare().unwrap();
    let decoded = MigrationItemPlaintext::new(
        restored
            .decrypt_item(plan.items()[0].envelope(), &fixture.bindings[0].target)
            .unwrap(),
    )
    .unwrap();
    assert!(decoded.json()["original"] == *fixture.sources[0].item.json());
    let mut wrong_owner = fixture.owner.context().clone();
    wrong_owner.owner_account_id = Uuid::new_v4();
    assert!(PasswordBoxKey::unwrap_for_owner(&bundle, &root, &wrong_owner).is_err());
}

#[test]
fn file_and_utf8_name_limits_are_enforced_in_bytes() {
    assert!(AttachmentPlaintext::new(String::new(), vec![0; MAX_ATTACHMENT_BYTES + 1]).is_err());
    assert!(
        AttachmentPlaintext::new("界".repeat(MAX_ATTACHMENT_NAME_BYTES / 3 + 1), vec![]).is_err()
    );
    let fixture = Fixture::new();
    let plaintext = AttachmentPlaintext::new(
        "界".repeat(MAX_ATTACHMENT_NAME_BYTES / 3),
        vec![0xff; MAX_ATTACHMENT_BYTES],
    )
    .unwrap();
    let context = &fixture.bindings[0].attachments[0].target;
    let encrypted = fixture.key.encrypt_attachment(&plaintext, context).unwrap();
    let decoded = fixture.key.decrypt_attachment(&encrypted, context).unwrap();
    assert!(decoded.name() == plaintext.name() && decoded.content() == plaintext.content());
}

#[test]
fn item_limit_includes_routing_wrapper_and_oversize_keeps_source_unchanged() {
    assert!(
        MigrationItemPlaintext::new(serde_json::json!({"huge": "x".repeat(MAX_ITEM_BYTES)}))
            .is_err()
    );
    assert!(MigrationItemPlaintext::new(serde_json::json!([])).is_err());
    let mut fixture = Fixture::new();
    fixture.sources[0].item.0["huge"] = Value::String("x".repeat(MAX_ITEM_BYTES));
    fixture.rejected_unchanged();
    let mut fixture = Fixture::new();
    let size = fixture.sources[0].item.encoded_size().unwrap();
    // Original fits exactly; target wrapper does not. No dropped fields to fit.
    fixture.sources[0].item.0["padding"] = Value::String("x".repeat(MAX_ITEM_BYTES - size - 13));
    assert!(fixture.sources[0].item.encoded_size().unwrap() == MAX_ITEM_BYTES);
    fixture.rejected_unchanged();
}

#[test]
fn attachment_count_and_checked_box_budget_have_exact_boundaries() {
    assert!(budget_add(MAX_MIGRATION_BOX_BYTES - 1, 1).unwrap() == MAX_MIGRATION_BOX_BYTES);
    assert!(budget_add(MAX_MIGRATION_BOX_BYTES, 1).is_err());
    assert!(budget_add(usize::MAX, 1).is_err());
    let mut fixture = Fixture::new();
    fixture.sources[0].item.0["attachments"] =
        serde_json::json!(vec![Value::Null; MAX_MIGRATION_ATTACHMENTS + 1]);
    fixture.rejected_unchanged();
    // Across items, not just a single array. Empty names/files avoid 1 GiB allocation.
    let mut fixture = Fixture::new();
    fixture.sources.clear();
    fixture.bindings.clear();
    for _ in 0..2 {
        let source = ItemContext {
            password_box_id: fixture.source_box.clone(),
            item_id: ConnectId::generate().unwrap(),
            item_version: 17,
            key_epoch: 1,
        };
        let target = ItemContext {
            password_box_id: fixture.owner.0.password_box_id.clone(),
            item_id: ConnectId::generate().unwrap(),
            item_version: 17,
            key_epoch: 3,
        };
        let mut attachments = Vec::new();
        let mut files = Vec::new();
        let mut refs = Vec::new();
        for _ in 0..513 {
            let context = AttachmentContext {
                password_box_id: source.password_box_id.clone(),
                item_id: source.item_id.clone(),
                attachment_id: ConnectId::generate().unwrap(),
                attachment_version: 4,
                key_epoch: 1,
            };
            refs.push(serde_json::json!({"attachmentId": context.attachment_id, "attachmentVersion": 4, "keyEpoch": 1}));
            attachments.push(MigrationAttachmentBinding {
                source: context.clone(),
                target: AttachmentContext {
                    password_box_id: target.password_box_id.clone(),
                    item_id: target.item_id.clone(),
                    attachment_id: ConnectId::generate().unwrap(),
                    attachment_version: 4,
                    key_epoch: 3,
                },
            });
            files.push(MigrationAttachmentSource {
                context,
                plaintext: AttachmentPlaintext::new(String::new(), Vec::new()).unwrap(),
            });
        }
        fixture.sources.push(MigrationItemSource { item: MigrationItemPlaintext::new(serde_json::json!({"id": source.item_id,"version": 17,"vault": {"id": source.password_box_id},"attachments": refs})).unwrap(), attachments: files });
        fixture.bindings.push(MigrationItemBinding {
            source,
            target,
            attachments,
        });
    }
    fixture.rejected_unchanged();
    // Exactly 1024 succeeds through the public API; all bytes/references present.
    for index in 0..2 {
        fixture.sources[index].attachments.pop();
        fixture.sources[index].item.0["attachments"]
            .as_array_mut()
            .unwrap()
            .pop();
        fixture.bindings[index].attachments.pop();
    }
    assert!(
        fixture
            .prepare()
            .unwrap()
            .items()
            .iter()
            .map(|item| item.attachments().len())
            .sum::<usize>()
            == 1024
    );
}

#[test]
fn empty_snapshot_and_items_without_attachments_can_be_prepared() {
    let mut fixture = Fixture::new();
    for (source, binding) in fixture.sources.iter_mut().zip(&mut fixture.bindings) {
        source.item.0.as_object_mut().unwrap().remove("attachments");
        source.attachments.clear();
        binding.attachments.clear();
    }
    assert!(fixture.prepare().unwrap().items().len() == 2);
    fixture.sources.clear();
    fixture.bindings.clear();
    assert!(fixture.prepare().unwrap().items().is_empty());
}

#[test]
fn caller_decodes_pbox_read_only_and_preparation_never_replaces_source() {
    use crate::crypto::{
        decrypt, derive_master_key, encrypt, generate_salt, FILE_VERSION, KDF_MEMORY_KIB,
        KDF_PARALLELISM, KDF_TIME_COST,
    };
    use crate::storage::file_format::{KdfParams, PasswordBoxFile, StoredCipher};
    let mut fixture = Fixture::new();
    let mut random = Zeroizing::new([0u8; 32]);
    getrandom::fill(random.as_mut()).unwrap();
    let password = Zeroizing::new(BASE64.encode(random.as_ref()));
    let salt = generate_salt().unwrap();
    let root = derive_master_key(&password, &salt).unwrap();
    let mut source_vault = crate::domain::vault::Vault::new("元のパスワードボックス").unwrap();
    source_vault.id = fixture.source_box.clone();
    let payload = MigrationItemPlaintext::new(serde_json::json!({
        "payloadVersion": 2,
        "vault": source_vault,
        "items": [fixture.sources[0].item.json()],
        "unknownBoxMetadata": [true, "保持"],
    }))
    .unwrap();
    let original = Zeroizing::new(serde_json::to_vec(payload.json()).unwrap());
    let (ciphertext, nonce) = encrypt(&original, &root).unwrap();
    let file = PasswordBoxFile {
        version: FILE_VERSION,
        kdf: KdfParams {
            algorithm: "argon2id".into(),
            salt: BASE64.encode(salt),
            memory_kib: KDF_MEMORY_KIB,
            time_cost: KDF_TIME_COST,
            parallelism: KDF_PARALLELISM,
        },
        cipher: StoredCipher {
            algorithm: "xchacha20poly1305".into(),
            nonce: BASE64.encode(nonce),
        },
        ciphertext,
        recovery: None,
    };
    // Existing storage test helper owns this file; only ciphertext is on disk.
    let temp = tempfile::NamedTempFile::new().unwrap().into_temp_path();
    file.save_to_path(&temp).unwrap();
    let before = std::fs::read(&temp).unwrap();
    let loaded = PasswordBoxFile::load_from_path(&temp).unwrap();
    loaded.validate_version().unwrap();
    // A genuine complete .pbox also opens through the existing read-only API.
    let opened = crate::PasswordBox::open(&temp, &password).unwrap();
    assert!(opened
        .get_item(fixture.bindings[0].source.item_id.as_str())
        .is_ok());
    assert!(std::fs::read(&temp).unwrap() == before);
    let decoded = Zeroizing::new(
        decrypt(
            &loaded.ciphertext,
            &root,
            &loaded.cipher.nonce_bytes().unwrap(),
        )
        .unwrap(),
    );
    let decoded_payload =
        MigrationItemPlaintext::new(serde_json::from_slice(&decoded).unwrap()).unwrap();
    fixture.sources[0].item =
        MigrationItemPlaintext::new(decoded_payload.json()["items"][0].clone()).unwrap();
    let plan = fixture.prepare().unwrap();
    let decrypted = MigrationItemPlaintext::new(
        fixture
            .key
            .decrypt_item(plan.items()[0].envelope(), &fixture.bindings[0].target)
            .unwrap(),
    )
    .unwrap();
    assert!(decrypted.json()["original"] == *fixture.sources[0].item.json());
    assert!(std::fs::read(&temp).unwrap() == before);
    fixture.sources[0].attachments.clear();
    fixture.rejected_unchanged();
    assert!(std::fs::read(&temp).unwrap() == before);
    drop(plan); // Abandoned staging/cancellation of a prepared plan has no I/O.
    assert!(std::fs::read(&temp).unwrap() == before);
}
