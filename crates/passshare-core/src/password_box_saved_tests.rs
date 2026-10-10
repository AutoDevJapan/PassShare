use super::*;
use std::fs;
use tempfile::TempDir;

std::thread_local! {
    // Test-only, same-thread observation of live buffers after wiping and before
    // release. Store only the id and an empty-value flag, never a secret value.
    static SCRUB_EVENTS: std::cell::RefCell<Vec<(String, bool)>> = const {
        std::cell::RefCell::new(Vec::new())
    };
}

pub(super) fn observe_scrubbed_item(item: &Item) {
    SCRUB_EVENTS.with_borrow_mut(|events| {
        events.push((
            item.id.to_string(),
            item.fields.iter().all(|field| field.value.is_empty()),
        ));
    });
}

#[derive(Clone, Copy)]
enum Operation {
    Add,
    Update,
    Delete,
    Import,
    Upsert,
    UpsertNew,
}

// Fail the real atomic replacement, rather than mock a save error. The directory
// at the target path makes persist fail under root Docker and ordinary Windows.
// Keep an independent copy of the previous ciphertext to verify byte equality.
fn failure_then_retry(operation: Operation) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let backup = dir.path().join("before.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    let mut original = Item::new_login(
        pb.vault().unwrap().id.clone(),
        "Original",
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    original.tags = vec!["keep,comma".into(), "unchanged".into()];
    original.urls = vec![
        crate::domain::item::ItemUrl {
            extensions: Default::default(),
            href: "https://example.test/first".into(),
            primary: true,
            label: "First".into(),
        },
        crate::domain::item::ItemUrl {
            extensions: Default::default(),
            href: "https://example.test/second".into(),
            primary: false,
            label: "Second".into(),
        },
    ];
    pb.apply_and_save(SavedChange::Add(&original), &master)
        .unwrap();
    let before_payload = pb.payload.clone();
    let before_bytes = fs::read(&path).unwrap();
    let mut edited = original.clone();
    edited.title = "Changed".into();
    let added =
        Item::new_secure_note(pb.vault().unwrap().id.clone(), "Added", "Synthetic").unwrap();
    let id = original.id.to_string();
    let csv = "title,url,username,password,notes\nImported,https://example.test,csv-user,synthetic-value,kept\n";
    let change = match operation {
        Operation::Add => SavedChange::Add(&added),
        Operation::Update => SavedChange::Update(&edited),
        Operation::Delete => SavedChange::Delete(&id),
        Operation::Import => SavedChange::ImportCsv(csv),
        Operation::Upsert => SavedChange::Upsert(&edited),
        Operation::UpsertNew => SavedChange::Upsert(&added),
    };
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(pb.apply_and_save(change, &master).is_err());
    assert_eq!(pb.payload, before_payload);
    assert_eq!(pb.state(), PasswordBoxState::Unlocked);
    assert_eq!(fs::read(&backup).unwrap(), before_bytes);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);

    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    let reopened = PasswordBox::open(&path, &master).unwrap();
    assert_eq!(reopened.payload, before_payload);
    drop(reopened);
    assert_eq!(pb.apply_and_save(change, &master).unwrap(), 1);
    let reopened = PasswordBox::open(&path, &master).unwrap();
    assert_eq!(reopened.payload, pb.payload);
    match operation {
        Operation::Add | Operation::UpsertNew => {
            assert_eq!(reopened.payload.items, vec![original, added]);
        }
        Operation::Update | Operation::Upsert => {
            assert_eq!(reopened.payload.items, vec![edited]);
        }
        Operation::Delete => assert!(reopened.payload.items.is_empty()),
        Operation::Import => {
            assert_eq!(reopened.payload.items.len(), 2);
            assert_eq!(reopened.payload.items[0], original);
            let imported = &reopened.payload.items[1];
            assert_eq!(imported.title, "Imported");
            assert_eq!(
                imported
                    .field_value_by_purpose(crate::domain::field::FieldPurpose::Username)
                    .as_deref(),
                Some("csv-user")
            );
        }
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn saved_add_failure_retry_has_no_duplicate() {
    failure_then_retry(Operation::Add);
}

#[test]
fn saved_update_failure_preserves_original() {
    failure_then_retry(Operation::Update);
}

#[test]
fn saved_delete_failure_preserves_original() {
    failure_then_retry(Operation::Delete);
}

#[test]
fn saved_csv_failure_retry_imports_once() {
    failure_then_retry(Operation::Import);
}

#[test]
fn saved_sync_failure_preserves_original() {
    failure_then_retry(Operation::Upsert);
}

#[test]
fn saved_new_sync_failure_retry_adds_once() {
    failure_then_retry(Operation::UpsertNew);
}

#[test]
fn saved_replaced_and_removed_values_are_scrubbed_before_release() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    let original = Item::new_login(
        pb.vault().unwrap().id.clone(),
        "Original",
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let id = original.id.to_string();
    for operation in [Operation::Update, Operation::Upsert, Operation::Delete] {
        pb.upsert_sync_item(original.clone()).unwrap();
        SCRUB_EVENTS.with_borrow_mut(Vec::clear);
        match operation {
            Operation::Update => pb.update_item(original.clone()).unwrap(),
            Operation::Upsert => pb.upsert_sync_item(original.clone()).unwrap(),
            Operation::Delete => pb.delete_item(&id).unwrap(),
            _ => unreachable!(),
        }
        SCRUB_EVENTS.with_borrow(|events| assert_eq!(events.as_slice(), &[(id.clone(), true)]));
    }
    // The independent caller's original is not scrubbed by the mutation.
    assert!(original.fields.iter().any(|field| !field.value.is_empty()));
}

#[test]
fn saved_invalid_update_never_changes_memory_or_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("box.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    let original = pb.payload.clone();
    let bytes = fs::read(&path).unwrap();
    let missing =
        Item::new_secure_note(pb.vault().unwrap().id.clone(), "Missing", "Unused").unwrap();
    assert!(matches!(
        pb.apply_and_save(SavedChange::Update(&missing), &master),
        Err(PassShareError::ItemNotFound)
    ));
    assert_eq!(pb.payload, original);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    pb.lock();
    assert!(matches!(
        pb.apply_and_save(SavedChange::Add(&missing), &master),
        Err(PassShareError::BoxLocked)
    ));
    assert_eq!(pb.state(), PasswordBoxState::Locked);
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
