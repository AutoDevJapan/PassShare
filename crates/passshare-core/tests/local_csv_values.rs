use passshare_core::{domain::field::FieldPurpose, PasswordBox, SavedChange};

#[test]
fn csv_secret_whitespace_survives_encrypted_save_and_reopen() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("values.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    // Construct quoting with the formal CSV writer rather than an ambiguous fixture.
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(["Title", "Username", "Password", "URL", "Notes", "Tags"])
        .unwrap();
    writer
        .write_record([
            "日本語, \"Synthetic\"",
            " user ",
            " value ",
            " https://example.test/ ",
            " first\r\n\"second\" ",
            " first ,second ",
        ])
        .unwrap();
    let data = String::from_utf8(writer.into_inner().unwrap()).unwrap();
    assert_eq!(
        pb.apply_and_save(SavedChange::ImportCsv(&data), &master)
            .unwrap(),
        1
    );
    let reopened = PasswordBox::open(&path, &master).unwrap();
    let items = reopened.list_connect_items().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "日本語, \"Synthetic\"");
    assert_eq!(
        items[0]
            .field_value_by_purpose(FieldPurpose::Password)
            .as_deref(),
        Some(" value ")
    );
    assert_eq!(
        items[0]
            .field_value_by_purpose(FieldPurpose::Username)
            .as_deref(),
        Some(" user ")
    );
    assert_eq!(
        items[0].field_value_by_label("notes").as_deref(),
        Some(" first\r\n\"second\" ")
    );
    assert_eq!(items[0].urls[0].href, "https://example.test/");
    assert_eq!(items[0].tags, vec!["first", "second"]);
    drop(reopened);
    drop(pb);
    dir.close().unwrap();
}

#[test]
fn required_blank_rows_and_invalid_header_never_publish_partial_data() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("rejected.pbox");
    let master = uuid::Uuid::new_v4().to_string();
    let mut pb = PasswordBox::create(&path, &master).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(pb
        .apply_and_save(
            SavedChange::ImportCsv("Username,Password\nuser,synthetic\n"),
            &master
        )
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(pb.list_connect_items().unwrap().is_empty());
    assert_eq!(pb.apply_and_save(SavedChange::ImportCsv(" Title , Password ,Username\r\n   ,secret,skip\r\nBlank,   ,skip\r\nKept, valid ,\r\n"), &master).unwrap(), 1);
    let reopened = PasswordBox::open(&path, &master).unwrap();
    let items = reopened.list_connect_items().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "Kept");
    assert_eq!(
        items[0]
            .field_value_by_purpose(FieldPurpose::Password)
            .as_deref(),
        Some(" valid ")
    );
    drop(reopened);
    drop(pb);
    dir.close().unwrap();
}
