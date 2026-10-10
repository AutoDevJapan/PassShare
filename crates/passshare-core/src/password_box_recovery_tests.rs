use super::*;
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::TempDir;

const OLD_PASSWORD: &str = "synthetic-old-password";
const NEW_PASSWORD: &str = "synthetic-new-password";
const FIXED_CODE: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

// Frozen historical v1 wire bytes: independent of current create, encrypt and KDF.
// Synthetic plaintext uses a fixed DTO, salt [1; 16], nonce [2; 24] and FIXED_CODE.
fn write_v1(path: &Path) {
    let json = r#"{"version":1,"kdf":{"algorithm":"argon2id","salt":"AQEBAQEBAQEBAQEBAQEBAQ==","memory_kib":65536,"time_cost":3,"parallelism":4},"cipher":{"algorithm":"xchacha20poly1305","nonce":"AgICAgICAgICAgICAgICAgICAgICAgIC"},"ciphertext":"uk2E9pzsrI6RYnpuSfPcLalhiP2iy3MLWWGWhiN7gZ/Zwa5/UUX8Is4Zb9XV8JHe+kKJZfVzOxULib9Y49G2Z5/SQ32T+WGBNABjYp0E2GKJPtSy2YFpZ9xoMyRv/TPVEziLPj+pVBFR4VCsdRLT3wbjed26usQeSin+4gD8c5LyaEeL2Axop4Ur3VVvVcW0MANAOcjiO7doM/q4Ryv+e6Q938NpFZal4t3nU+NZaHcB95mArO0rZxd+NsnGyZAQf0KMWwUayw9tuqaemFRljdYQXOsQlx4Nu5tFV3mnq0wFK/t2m7vLeX1rtLJFZQNMSX/anrEJQQ/8vLAtkIGTto0cU7XQ/qn0yOYvmh8h+aueRspvSUzBo2IPuCkH+b1Wrwsa9RHwewKypAEVvp+ZuIOu0HdM2G4Vz6if3z/j9Q=="}"#;
    fs::write(path, json).unwrap();
}

fn add_complete_item(pb: &mut PasswordBox) {
    let mut item = Item::new_login(
        pb.vault().unwrap().id.clone(),
        "Synthetic",
        "synthetic-secret",
    )
    .unwrap();
    item.urls = vec![
        crate::domain::item::ItemUrl {
            href: "https://example.test/a".into(),
            primary: true,
            label: "A".into(),
        },
        crate::domain::item::ItemUrl {
            href: "https://example.test/b".into(),
            primary: false,
            label: "B".into(),
        },
    ];
    item.tags = vec!["日本語".into(), "keep,comma".into()];
    item.favorite = true;
    item.last_edited_by = Some("synthetic-editor".into());
    pb.add_item(item).unwrap();
    // Simulate authenticated future/extra Item JSON without changing the DTO.
    let mut original = SecretJson(serde_json::to_value(&pb.payload).unwrap());
    original.0["items"][0]["files"] = serde_json::json!([{"id":"synthetic-attachment","contentPath":"attachments/ref","size":42}]);
    original.0["items"][0]["version"] = serde_json::json!(17);
    original.0["items"][0]["extra"] = serde_json::json!({"nested":["synthetic-extra"]});
    original.0["items"][0]["fields"][0]["extraField"] = serde_json::json!("synthetic-field");
    original.0["items"][0]["urls"][0]["extraUrl"] = serde_json::json!("keep-url");
    original.0["extraRoot"] = serde_json::json!("keep-root");
    pb.original_payload = Some(Zeroizing::new(serde_json::to_vec(&original.0).unwrap()));
}

fn raw_payload(path: &Path, password: &str) -> SecretJson {
    let file = PasswordBoxFile::load_from_path(path).unwrap();
    let key = derive_master_key_with_params(
        password,
        &file.kdf.salt_bytes().unwrap(),
        file.kdf.memory_kib,
        file.kdf.time_cost,
        file.kdf.parallelism,
    )
    .unwrap();
    let bytes = Zeroizing::new(
        decrypt(&file.ciphertext, &key, &file.cipher.nonce_bytes().unwrap()).unwrap(),
    );
    SecretJson(serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn first_save_and_rekey_preserve_reference_extensions_and_duplicate_url_metadata() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("extensions.pbox");
    let mut pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    add_complete_item(&mut pb);
    let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
    // Seed independently authenticated bytes, before the merge implementation
    // gets a chance to omit anything during its first save.
    let mut full = SecretJson(serde_json::to_value(&pb.payload).unwrap());
    full.0["localKeyRecoveryVersion"] = serde_json::json!(2);
    full.0["items"][0]["vault"]["name"] = serde_json::json!("synthetic-reference-name");
    full.0["items"][0]["vault"]["contentVersion"] = serde_json::json!(91);
    full.0["items"][0]["urls"] = serde_json::json!([
        {"href":"https://example.invalid/same","primary":true,"label":"First","extension":"first-only"},
        {"href":"https://example.invalid/same","primary":false,"label":"Second","extension":"second-only"}
    ]);
    let mut file = PasswordBoxFile::load_from_path(&path).unwrap();
    let key = derive_master_key_with_params(
        OLD_PASSWORD,
        &file.kdf.salt_bytes().unwrap(),
        file.kdf.memory_kib,
        file.kdf.time_cost,
        file.kdf.parallelism,
    )
    .unwrap();
    let bytes = Zeroizing::new(serde_json::to_vec(&full.0).unwrap());
    let (ciphertext, nonce) = encrypt(&bytes, &key).unwrap();
    file.ciphertext = ciphertext;
    file.cipher.nonce = BASE64.encode(nonce);
    let (ciphertext, nonce) = encrypt_recovery_key(
        &key,
        &recovery_key(&code).unwrap(),
        &file.recovery_aad().unwrap(),
    )
    .unwrap();
    file.recovery = Some(RecoveryWrapper {
        cipher: StoredCipher {
            algorithm: "xchacha20poly1305".into(),
            nonce: BASE64.encode(nonce),
        },
        ciphertext,
    });
    file.save_to_path(&path).unwrap();
    drop(pb);
    let original = raw_payload(&path, OLD_PASSWORD);
    assert_eq!(
        original.0["items"][0]["vault"]["name"],
        "synthetic-reference-name"
    );
    assert_eq!(
        original.0["items"][0]["urls"][1]["extension"],
        "second-only"
    );
    let mut opened = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    opened.save(OLD_PASSWORD).unwrap();
    drop(opened);
    let saved = raw_payload(&path, OLD_PASSWORD);
    assert_eq!(
        saved.0["items"][0]["vault"],
        original.0["items"][0]["vault"]
    );
    assert_eq!(saved.0["items"][0]["urls"], original.0["items"][0]["urls"]);
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    recovered.rekey_recovered(NEW_PASSWORD).unwrap();
    drop(recovered);
    let rekeyed = raw_payload(&path, NEW_PASSWORD);
    assert_eq!(
        rekeyed.0["items"][0]["vault"],
        original.0["items"][0]["vault"]
    );
    assert_eq!(
        rekeyed.0["items"][0]["urls"],
        original.0["items"][0]["urls"]
    );
}

#[test]
fn v2_restart_recover_rekey_preserves_full_json_and_code() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let backup = dir.path().join("backup.pbox");
    let mut pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    add_complete_item(&mut pb);
    pb.save(OLD_PASSWORD).unwrap();
    let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
    let expected = pb.payload.clone();
    let raw_before = raw_payload(&path, OLD_PASSWORD);
    let before = fs::read(&path).unwrap();
    fs::copy(&path, &backup).unwrap();
    assert_eq!(PasswordBoxFile::load_from_path(&path).unwrap().version, 2);
    drop(pb);
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    assert_eq!(recovered.payload, expected);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        recovered.save(NEW_PASSWORD),
        Err(PassShareError::InvalidMasterPassword)
    );
    let item = Item::new_secure_note(
        recovered.vault().unwrap().id.clone(),
        "Blocked save",
        "Synthetic",
    )
    .unwrap();
    assert_eq!(
        recovered.apply_and_save(SavedChange::Add(&item), NEW_PASSWORD),
        Err(PassShareError::InvalidMasterPassword)
    );
    assert_eq!(recovered.payload, expected);
    assert_eq!(fs::read(&path).unwrap(), before);
    recovered.rekey_recovered(NEW_PASSWORD).unwrap();
    drop(recovered);
    assert_eq!(
        PasswordBox::open(&path, OLD_PASSWORD).err(),
        Some(PassShareError::InvalidMasterPassword)
    );
    let mut reopened = PasswordBox::open(&path, NEW_PASSWORD).unwrap();
    assert_eq!(reopened.payload, expected);
    reopened.save(NEW_PASSWORD).unwrap();
    assert_eq!(raw_payload(&path, NEW_PASSWORD).0, raw_before.0);
    assert_eq!(
        PasswordBox::recover(&path, &code).unwrap().payload,
        expected
    );
    assert_eq!(
        PasswordBox::open(&backup, OLD_PASSWORD).unwrap().payload,
        expected
    );
    assert_eq!(
        PasswordBox::recover(&backup, &code).unwrap().payload,
        expected
    );
}

#[test]
fn fixed_v1_stays_v1_until_authenticated_explicit_upgrade() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("legacy.pbox");
    let backup = dir.path().join("backup.pbox");
    write_v1(&path);
    fs::copy(&path, &backup).unwrap();
    assert!(PasswordBox::recover(&path, FIXED_CODE).is_err());
    let mut pb = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    pb.save(OLD_PASSWORD).unwrap();
    assert_eq!(PasswordBoxFile::load_from_path(&path).unwrap().version, 1);
    let before = fs::read(&path).unwrap();
    assert_eq!(
        pb.enable_recovery("wrong").err(),
        Some(PassShareError::InvalidMasterPassword)
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    let code = pb.enable_recovery(OLD_PASSWORD).unwrap();
    assert_eq!(code.as_str(), FIXED_CODE);
    assert_eq!(PasswordBoxFile::load_from_path(&path).unwrap().version, 2);
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    assert_eq!(recovered.payload, pb.payload);
    recovered.rekey_recovered(NEW_PASSWORD).unwrap();
    assert!(PasswordBox::open(&path, OLD_PASSWORD).is_err());
    assert!(PasswordBox::open(&path, NEW_PASSWORD).is_ok());
    assert_eq!(PasswordBoxFile::load_from_path(&backup).unwrap().version, 1);
    assert!(PasswordBox::open(&backup, OLD_PASSWORD).is_ok());
    assert!(PasswordBox::recover(&backup, &code).is_err());
}

#[test]
fn upgrade_without_legacy_code_generates_one() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("legacy.pbox");
    write_v1(&path);
    let mut pb = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    pb.payload.recovery_secret = None;
    pb.save(OLD_PASSWORD).unwrap();
    drop(pb);
    let mut pb = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    let code = pb.enable_recovery(OLD_PASSWORD).unwrap();
    assert_eq!(BASE64.decode(code.as_str()).unwrap().len(), 32);
    assert!(PasswordBox::recover(&path, &code).is_ok());
}

#[test]
fn wrong_code_cross_file_wrapper_and_primary_tampering_are_rejected() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.pbox");
    let other = dir.path().join("b.pbox");
    let pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
    let second = PasswordBox::create(&other, OLD_PASSWORD).unwrap();
    let other_code = Zeroizing::new(second.recovery_secret().unwrap().unwrap().to_owned());
    assert!(PasswordBox::recover(&path, &other_code).is_err());
    assert!(PasswordBox::recover(&path, "not-base64").is_err());
    assert!(PasswordBox::recover(&path, code.trim_end_matches('=')).is_err());
    let original = PasswordBoxFile::load_from_path(&path).unwrap();
    let other_file = PasswordBoxFile::load_from_path(&other).unwrap();
    let mut mixed = original.clone();
    mixed.recovery = other_file.recovery;
    mixed.save_to_path(&path).unwrap();
    assert!(PasswordBox::recover(&path, &other_code).is_err());
    assert!(PasswordBox::open(&path, OLD_PASSWORD).is_err());
    for mutate in [
        (|f: &mut PasswordBoxFile| f.ciphertext[0] ^= 1) as fn(&mut PasswordBoxFile),
        |f| f.kdf.salt = BASE64.encode([9; 16]),
        |f| f.kdf.time_cost += 1,
        |f| f.cipher.nonce = BASE64.encode([9; 24]),
        |f| f.recovery.as_mut().unwrap().ciphertext[0] ^= 1,
        |f| f.recovery.as_mut().unwrap().cipher.nonce = BASE64.encode([9; 24]),
    ] {
        let mut altered = original.clone();
        mutate(&mut altered);
        altered.save_to_path(&path).unwrap();
        assert!(PasswordBox::recover(&path, &code).is_err());
        assert!(PasswordBox::open(&path, OLD_PASSWORD).is_err());
    }
}

#[test]
fn malformed_header_shapes_algorithms_versions_and_kdf_costs_rejected() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
    let original = PasswordBoxFile::load_from_path(&path).unwrap();
    for mutate in [
        (|f: &mut PasswordBoxFile| f.version = 3) as fn(&mut PasswordBoxFile),
        |f| f.version = 1,
        |f| {
            f.version = 1;
            f.recovery = None;
        },
        |f| f.recovery = None,
        |f| f.kdf.memory_kib = 1024,
        |f| f.kdf.memory_kib = u32::MAX,
        |f| f.kdf.time_cost = 1,
        |f| f.kdf.time_cost = u32::MAX,
        |f| f.kdf.parallelism = 0,
        |f| f.kdf.parallelism = u32::MAX,
        |f| f.kdf.algorithm = "unknown".into(),
        |f| f.cipher.algorithm = "unknown".into(),
        |f| f.recovery.as_mut().unwrap().cipher.algorithm = "unknown".into(),
        |f| f.kdf.salt = "AAAA".into(),
        |f| f.cipher.nonce = "AAAA".into(),
        |f| f.recovery.as_mut().unwrap().cipher.nonce = "AAAA".into(),
        |f| {
            f.recovery
                .as_mut()
                .unwrap()
                .ciphertext
                .pop()
                .map(|_| ())
                .unwrap()
        },
    ] {
        let mut changed = original.clone();
        mutate(&mut changed);
        changed.save_to_path(&path).unwrap();
        assert_eq!(
            PasswordBox::open(&path, OLD_PASSWORD).err(),
            Some(PassShareError::CorruptFile)
        );
        assert_eq!(
            PasswordBox::recover(&path, &code).err(),
            Some(PassShareError::CorruptFile)
        );
    }
    for field in ["root", "kdf", "cipher", "recovery", "wrapperCipher"] {
        let mut json = serde_json::to_value(&original).unwrap();
        match field {
            "root" => json["unknown"] = serde_json::json!(1),
            "wrapperCipher" => json["recovery"]["cipher"]["unknown"] = serde_json::json!(1),
            _ => json[field]["unknown"] = serde_json::json!(1),
        }
        fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
        assert_eq!(
            PasswordBox::recover(&path, &code).err(),
            Some(PassShareError::CorruptFile)
        );
        assert_eq!(
            PasswordBox::open(&path, OLD_PASSWORD).err(),
            Some(PassShareError::CorruptFile)
        );
    }
}

fn failure_preserves_original(upgrade: bool) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let backup = dir.path().join("before.pbox");
    let (mut pb, code) = if upgrade {
        write_v1(&path);
        (
            PasswordBox::open(&path, OLD_PASSWORD).unwrap(),
            Zeroizing::new(FIXED_CODE.to_owned()),
        )
    } else {
        let pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
        let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
        (PasswordBox::recover(&path, &code).unwrap(), code)
    };
    let payload = pb.payload.clone();
    let salt = pb.salt;
    let version = pb.file_version;
    let before = fs::read(&path).unwrap();
    let hash = Sha256::digest(&before);
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();
    let failure = if upgrade {
        pb.enable_recovery(OLD_PASSWORD).map(|_| ())
    } else {
        pb.rekey_recovered(NEW_PASSWORD)
    };
    assert!(failure.is_err());
    assert_eq!(pb.payload, payload);
    assert_eq!(pb.salt, salt);
    assert_eq!(pb.file_version, version);
    assert_eq!(fs::read(&backup).unwrap(), before);
    assert_eq!(Sha256::digest(fs::read(&backup).unwrap()), hash);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    let restarted = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    assert_eq!(restarted.payload, payload);
    if upgrade {
        pb.enable_recovery(OLD_PASSWORD).unwrap();
    } else {
        assert_eq!(PasswordBox::recover(&path, &code).unwrap().payload, payload);
        assert!(pb.recovery_only);
        pb.rekey_recovered(NEW_PASSWORD).unwrap();
    }
    assert!(PasswordBox::recover(&path, &code).is_ok());
}

#[test]
fn failed_rekey_preserves_exact_bytes_and_is_retryable() {
    failure_preserves_original(false);
}

#[test]
fn failed_upgrade_preserves_exact_bytes_and_is_retryable() {
    failure_preserves_original(true);
}

// Omit FILE_SHARE_DELETE: reads and password verification still work, but the
// actual atomic replacement fails against the original file on Windows.
#[cfg(windows)]
#[test]
fn real_atomic_failures_leave_the_original_path_and_state_unchanged() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    write_v1(&path);
    let mut legacy = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    let before = fs::read(&path).unwrap();
    let hash = Sha256::digest(&before);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    assert!(matches!(
        legacy.enable_recovery(OLD_PASSWORD),
        Err(PassShareError::Internal(_))
    ));
    assert_eq!(legacy.file_version, 1);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(Sha256::digest(fs::read(&path).unwrap()), hash);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert!(PasswordBox::open(&path, OLD_PASSWORD).is_ok());
    drop(held);
    let code = legacy.enable_recovery(OLD_PASSWORD).unwrap();
    let before = fs::read(&path).unwrap();
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    let salt = recovered.salt;
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    assert!(matches!(
        recovered.rekey_recovered(NEW_PASSWORD),
        Err(PassShareError::Internal(_))
    ));
    assert!(recovered.recovery_only);
    assert_eq!(recovered.salt, salt);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        Sha256::digest(fs::read(&path).unwrap()),
        Sha256::digest(&before)
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert!(PasswordBox::open(&path, OLD_PASSWORD).is_ok());
    assert!(PasswordBox::recover(&path, &code).is_ok());
    assert!(PasswordBox::open(&path, NEW_PASSWORD).is_err());
    assert!(legacy.rotate_recovery(OLD_PASSWORD).is_err());
    assert_eq!(legacy.recovery_secret().unwrap(), Some(code.as_str()));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(legacy.save(OLD_PASSWORD).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(held);
    recovered.rekey_recovered(NEW_PASSWORD).unwrap();
    assert!(PasswordBox::open(&path, NEW_PASSWORD).is_ok());
    assert!(PasswordBox::recover(&path, &code).is_ok());
}

#[test]
fn rotation_invalidates_current_code_and_preserves_backup_access() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let backup = dir.path().join("backup.pbox");
    let mut pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    let old_code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
    fs::copy(&path, &backup).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(pb.rotate_recovery("wrong").is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    let new_code = pb.rotate_recovery(OLD_PASSWORD).unwrap();
    assert_ne!(new_code.as_str(), old_code.as_str());
    assert!(PasswordBox::recover(&path, &old_code).is_err());
    assert!(PasswordBox::recover(&path, &new_code).is_ok());
    assert!(PasswordBox::open(&path, OLD_PASSWORD).is_ok());
    assert!(PasswordBox::recover(&backup, &old_code).is_ok());
    assert!(PasswordBox::recover(&backup, &new_code).is_err());
}

#[test]
fn recovered_lock_and_drop_scrub_owned_buffers_and_return_no_secrets() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let mut pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    add_complete_item(&mut pb);
    pb.save(OLD_PASSWORD).unwrap();
    let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_owned());
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    recovered.zeroize_secrets();
    assert!(recovered
        .payload
        .items
        .iter()
        .flat_map(|item| &item.fields)
        .all(|field| field.value.is_empty()));
    assert_eq!(recovered.payload.recovery_secret.as_deref(), Some(""));
    assert!(recovered.original_payload.is_none());
    recovered.lock();
    assert_eq!(recovered.recovery_secret(), Err(PassShareError::BoxLocked));
    assert_eq!(
        recovered.list_connect_items(),
        Err(PassShareError::BoxLocked)
    );
    assert_eq!(
        recovered.rekey_recovered(NEW_PASSWORD),
        Err(PassShareError::BoxLocked)
    );
    drop(recovered);
    let recovered = PasswordBox::recover(&path, &code).unwrap();
    drop(recovered); // Existing shared scrub observer covers actual Drop execution.
}

#[test]
fn unknown_item_fields_survive_but_removed_known_fields_stay_removed() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let mut pb = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    add_complete_item(&mut pb);
    pb.save(OLD_PASSWORD).unwrap();
    drop(pb);
    let mut pb = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    let mut edited = pb.payload.items[0].clone();
    edited.urls.clear();
    edited.tags.clear();
    edited.last_edited_by = None;
    edited.fields[0].purpose = None;
    let id = edited.id.to_string();
    pb.apply_and_save(SavedChange::Update(&edited), OLD_PASSWORD)
        .unwrap();
    let raw = raw_payload(&path, OLD_PASSWORD);
    assert!(raw.0["items"][0].get("urls").is_none());
    assert!(raw.0["items"][0].get("tags").is_none());
    assert!(raw.0["items"][0].get("lastEditedBy").is_none());
    assert!(raw.0["items"][0]["fields"][0].get("purpose").is_none());
    assert_eq!(raw.0["items"][0]["version"], 17);
    assert_eq!(
        raw.0["items"][0]["files"][0]["contentPath"],
        "attachments/ref"
    );
    pb.apply_and_save(SavedChange::Delete(&id), OLD_PASSWORD)
        .unwrap();
    assert_eq!(
        raw_payload(&path, OLD_PASSWORD).0["items"],
        serde_json::json!([])
    );
}

#[test]
fn stale_boxes_cannot_overwrite_a_saved_update_or_rotated_code() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let mut current = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    let code = Zeroizing::new(current.recovery_secret().unwrap().unwrap().to_owned());
    let mut stale = PasswordBox::open(&path, OLD_PASSWORD).unwrap();
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    let item =
        Item::new_secure_note(current.vault().unwrap().id.clone(), "Saved", "Synthetic").unwrap();
    current
        .apply_and_save(SavedChange::Add(&item), OLD_PASSWORD)
        .unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        stale.enable_recovery(OLD_PASSWORD).err(),
        Some(PassShareError::CorruptFile)
    );
    assert_eq!(
        stale.rotate_recovery(OLD_PASSWORD).err(),
        Some(PassShareError::CorruptFile)
    );
    assert_eq!(stale.save(OLD_PASSWORD), Err(PassShareError::CorruptFile));
    assert_eq!(
        recovered.rekey_recovered(NEW_PASSWORD),
        Err(PassShareError::CorruptFile)
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(recovered.recovery_only);
    let mut recovered = PasswordBox::recover(&path, &code).unwrap();
    let new_code = current.rotate_recovery(OLD_PASSWORD).unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        recovered.rekey_recovered(NEW_PASSWORD),
        Err(PassShareError::CorruptFile)
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(PasswordBox::recover(&path, &new_code).is_ok());
}

#[test]
fn binding_rejects_a_wrapper_with_correct_key_and_different_payload_code() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    let mut file = PasswordBoxFile::load_from_path(&path).unwrap();
    let key = derive_master_key(OLD_PASSWORD, &file.kdf.salt_bytes().unwrap()).unwrap();
    let wrong_recovery = recovery_key(FIXED_CODE).unwrap();
    let (ciphertext, nonce) =
        encrypt_recovery_key(&key, &wrong_recovery, &file.recovery_aad().unwrap()).unwrap();
    file.recovery = Some(RecoveryWrapper {
        cipher: StoredCipher {
            algorithm: "xchacha20poly1305".into(),
            nonce: BASE64.encode(nonce),
        },
        ciphertext,
    });
    file.save_to_path(&path).unwrap();
    // Unwrapping and primary decryption both succeed; payload/code binding must fail.
    assert_eq!(
        PasswordBox::unwrap_recovery_key(&file, FIXED_CODE)
            .unwrap()
            .as_bytes(),
        key.as_bytes()
    );
    assert_eq!(
        PasswordBox::recover(&path, FIXED_CODE).err(),
        Some(PassShareError::CorruptFile)
    );
    assert_eq!(
        PasswordBox::open(&path, OLD_PASSWORD).err(),
        Some(PassShareError::CorruptFile)
    );
}

#[test]
fn cross_file_wrapper_is_rejected_even_with_identical_master_and_recovery_keys() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.pbox");
    let other = dir.path().join("b.pbox");
    let first = PasswordBox::create(&path, OLD_PASSWORD).unwrap();
    let code = Zeroizing::new(first.recovery_secret().unwrap().unwrap().to_owned());
    let mut second = PasswordBox::create(&other, OLD_PASSWORD).unwrap();
    second.salt = first.salt;
    second.payload.recovery_secret = Some(code.to_string());
    second.save(OLD_PASSWORD).unwrap();
    assert!(PasswordBox::recover(&other, &code).is_ok());
    let mut original = PasswordBoxFile::load_from_path(&path).unwrap();
    original.recovery = PasswordBoxFile::load_from_path(&other).unwrap().recovery;
    original.save_to_path(&path).unwrap();
    assert!(PasswordBox::recover(&path, &code).is_err());
    assert!(PasswordBox::open(&path, OLD_PASSWORD).is_err());
}
