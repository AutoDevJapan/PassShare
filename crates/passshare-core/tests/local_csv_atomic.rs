use passshare_core::{PasswordBox, SavedChange};

#[test]
fn local_csv_save_precondition_failure_then_retry_preserves_items() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("retry.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    let before = std::fs::read(&path).unwrap();
    let csv = "Title,Username,Password\nSame,user,synthetic\nSame,user,synthetic\n";
    assert!(pb
        .apply_and_save(
            SavedChange::ImportCsv("Username,Password\nuser,synthetic\n"),
            &master,
        )
        .is_err());
    assert!(pb.list_connect_items().unwrap().is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    // This rejects the existing-file read before atomic replacement begins.
    // It proves staged-state discard, not a fault during rename.
    let blocked = path.with_extension("blocked");
    std::fs::rename(&path, &blocked).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(pb
        .apply_and_save(SavedChange::ImportCsv(csv), &master)
        .is_err());
    assert!(pb.list_connect_items().unwrap().is_empty());
    assert_eq!(std::fs::read(&blocked).unwrap(), before);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&blocked, &path).unwrap();
    assert_eq!(
        pb.apply_and_save(SavedChange::ImportCsv(csv), &master)
            .unwrap(),
        2
    );
    let reopened = PasswordBox::open(&path, &master).unwrap();
    let items = reopened.list_connect_items().unwrap();
    assert_eq!(items.len(), 2);
    assert_ne!(items[0].id, items[1].id);
    assert_eq!(
        pb.apply_and_save(SavedChange::ImportCsv(csv), &master)
            .unwrap(),
        2
    );
    assert_eq!(
        PasswordBox::open(&path, &master)
            .unwrap()
            .list_connect_items()
            .unwrap()
            .len(),
        4
    );
    let committed = std::fs::read(&path).unwrap();
    pb.lock();
    assert!(pb
        .apply_and_save(SavedChange::ImportCsv(csv), &master)
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), committed);
}
