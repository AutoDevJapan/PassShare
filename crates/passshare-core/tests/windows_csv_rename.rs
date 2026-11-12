#![cfg(windows)]

use passshare_core::{Item, PassShareError, PasswordBox, SavedChange};
use std::{fs, fs::OpenOptions, os::windows::fs::OpenOptionsExt};

#[test]
fn readable_box_with_delete_sharing_denied_preserves_data_until_retry() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("rename.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    let original =
        Item::new_login(pb.vault().unwrap().id.clone(), "Existing", "synthetic").unwrap();
    pb.apply_and_save(SavedChange::Add(&original), &master)
        .unwrap();
    let before = fs::read(&path).unwrap();
    let before_items = pb.list_connect_items().unwrap();

    // Permit fingerprint reads and writes, but prevent replacing this file.
    // This differs from replacing the path with a directory before save.
    let held = OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // FILE_SHARE_READ | FILE_SHARE_WRITE, no DELETE
        .open(&path)
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(PasswordBox::open(&path, &master).is_ok());

    // Establish the actual OS replacement barrier independently of the import.
    let probe = dir.path().join("replacement-probe");
    fs::write(&probe, b"owned synthetic replacement").unwrap();
    let replacement_error = fs::rename(&probe, &path).unwrap_err();
    assert!(matches!(replacement_error.raw_os_error(), Some(5 | 32)));
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_file(&probe).unwrap();

    let csv = "Title,Username,Password,Notes\nImported,user,synthetic,kept\nImported,user,synthetic,kept\n";
    let failure = pb.apply_and_save(SavedChange::ImportCsv(csv), &master);
    assert_eq!(
        failure,
        Err(PassShareError::Internal(replacement_error.to_string()))
    );
    assert_eq!(pb.list_connect_items().unwrap(), before_items);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    drop(held);

    assert_eq!(
        pb.apply_and_save(SavedChange::ImportCsv(csv), &master)
            .unwrap(),
        2
    );
    let reopened = PasswordBox::open(&path, &master).unwrap();
    let items = reopened.list_connect_items().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(
        reopened.get_item(&original.id.to_string()).unwrap(),
        &original
    );
    let imported: Vec<_> = items
        .iter()
        .filter(|item| item.title == "Imported")
        .collect();
    assert_eq!(imported.len(), 2);
    assert_ne!(imported[0].id, imported[1].id);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    drop(reopened);
    drop(pb);
    dir.close().unwrap();
}
