use crate::domain::field::FieldPurpose;
use crate::domain::item::Item;

/// Neutralize spreadsheet formula injection.
///
/// A cell whose first character is `=`, `+`, `-`, `@` (or a leading tab / CR)
/// is evaluated as a formula when the CSV is opened in Excel or Google Sheets.
/// A vault shared by another user could inject such a value (via title, notes,
/// tags, …); prefix it with an apostrophe so the spreadsheet treats it as text.
///
/// CSV quoting of `"`, `,` and newlines is handled by the `csv` writer, so this
/// helper only performs the formula-neutralization step. Mirrors the `escapeCsv`
/// neutralization in `shared/lib/csv-export.ts` (the shared TS SSOT, #324).
fn neutralize_formula(value: &str) -> String {
    if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_string()
    }
}

/// Export items to 1Password-compatible CSV (Title, Username, Password, URL, Notes, Tags).
///
/// Every item is exported regardless of category. Password-less categories such
/// as `SecureNote` / `CreditCard` / `Identity` are kept — dropping them would
/// silently lose data during a backup (#364). For those items the Password
/// column is left empty and their content is preserved in the Notes column.
///
/// Each cell is passed through [`neutralize_formula`] to prevent spreadsheet
/// formula injection.
pub fn export_onepassword_csv(items: &[Item]) -> String {
    let mut writer = csv::WriterBuilder::new()
        .flexible(true)
        .from_writer(Vec::new());

    writer
        .write_record(["Title", "Username", "Password", "URL", "Notes", "Tags"])
        .expect("csv header");

    for item in items {
        let username = item.field_value_by_purpose(FieldPurpose::Username).unwrap_or_default();
        let password = item.field_value_by_purpose(FieldPurpose::Password).unwrap_or_default();
        let url = item
            .urls
            .iter()
            .find(|u| u.primary)
            .map(|u| u.href.as_str())
            .or_else(|| item.urls.first().map(|u| u.href.as_str()))
            .unwrap_or("");
        let notes = item
            .field_value_by_label("notes")
            .or_else(|| item.field_value_by_purpose(FieldPurpose::Notes))
            .or_else(|| item.field_value_by_label("notesPlain"))
            .unwrap_or_default();
        let tags = item.tags.join(", ");

        writer
            .write_record([
                neutralize_formula(&item.title),
                neutralize_formula(&username),
                neutralize_formula(&password),
                neutralize_formula(url),
                neutralize_formula(&notes),
                neutralize_formula(&tags),
            ])
            .expect("csv row");
    }

    String::from_utf8(writer.into_inner().expect("csv buffer")).expect("utf8 csv")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::vault::Vault;
    use crate::import::import_onepassword_csv;

    #[test]
    fn exports_login_row() {
        let vault = Vault::new("Test").unwrap();
        let mut item = Item::new_login(vault.id.clone(), "Example", "secret").unwrap();
        item = item
            .with_optional_fields(
                Some("https://example.com".into()),
                Some("user".into()),
                Some("note".into()),
            )
            .unwrap();
        item.tags = vec!["work".into()];

        let csv = export_onepassword_csv(&[item]);
        assert!(csv.contains("Example"));
        assert!(csv.contains("user"));
        assert!(csv.contains("secret"));
        assert!(csv.contains("https://example.com"));
        assert!(csv.contains("work"));
    }

    #[test]
    fn neutralizes_formula_injection_in_all_columns() {
        let vault = Vault::new("Test").unwrap();
        let mut item = Item::new_login(vault.id.clone(), "=HYPERLINK(\"http://evil\")", "-1")
            .unwrap()
            .with_optional_fields(None, Some("+cmd".into()), Some("@formula".into()))
            .unwrap();
        item.tags = vec!["=danger".into()];

        let csv = export_onepassword_csv(&[item]);
        // The title contains a comma/quote so the whole (neutralized) cell is quoted.
        assert!(csv.contains("\"'=HYPERLINK"));
        assert!(csv.contains("'+cmd"));
        assert!(csv.contains("'-1"));
        assert!(csv.contains("'@formula"));
        assert!(csv.contains("'=danger"));
    }

    #[test]
    fn neutralizes_leading_tab_and_cr() {
        let vault = Vault::new("Test").unwrap();
        let item = Item::new_login(vault.id.clone(), "\tTabbed", "secret").unwrap();
        let csv = export_onepassword_csv(&[item]);
        // A leading tab is neutralized with an apostrophe. A tab is not a
        // CSV-special character, so the writer does not add surrounding quotes.
        assert!(csv.contains("'\tTabbed"));
    }

    #[test]
    fn leaves_benign_values_untouched() {
        let vault = Vault::new("Test").unwrap();
        let item = Item::new_login(vault.id.clone(), "GitHub", "s3cret").unwrap();
        let csv = export_onepassword_csv(&[item]);
        assert!(csv.contains("GitHub"));
        assert!(csv.contains("s3cret"));
        assert!(!csv.contains("'GitHub"));
        assert!(!csv.contains("'s3cret"));
    }

    #[test]
    fn keeps_password_less_categories() {
        let vault = Vault::new("Test").unwrap();
        let note = Item::new_secure_note(vault.id.clone(), "Recovery codes", "one two three").unwrap();
        let login = Item::new_login(vault.id.clone(), "Site", "pw").unwrap();

        let csv = export_onepassword_csv(&[note, login]);
        let rows: Vec<&str> = csv.lines().collect();
        // Header + secure note + login: the note is NOT silently dropped.
        assert_eq!(rows.len(), 3);
        assert!(csv.contains("Recovery codes"));
        assert!(csv.contains("one two three"));
        // The note's Password column is empty (Title,Username,Password,...).
        assert!(csv.contains("Recovery codes,,,"));
    }

    #[test]
    fn login_survives_csv_roundtrip_through_import() {
        let vault = Vault::new("Roundtrip").unwrap();
        let item = Item::new_login(vault.id.clone(), "GitHub", "secret123")
            .unwrap()
            .with_optional_fields(
                Some("https://github.com".into()),
                Some("dev@example.com".into()),
                Some("work account".into()),
            )
            .unwrap();

        let csv = export_onepassword_csv(&[item]);
        let imported = import_onepassword_csv(&vault, &csv).unwrap();
        assert_eq!(imported.len(), 1);
        let back = &imported[0];
        assert_eq!(back.title, "GitHub");
        assert_eq!(
            back.field_value_by_purpose(FieldPurpose::Password),
            Some("secret123".into())
        );
        assert_eq!(
            back.field_value_by_purpose(FieldPurpose::Username),
            Some("dev@example.com".into())
        );
        assert_eq!(back.urls[0].href, "https://github.com");
        assert_eq!(back.field_value_by_label("notes"), Some("work account".into()));
    }

    #[test]
    fn roundtrip_skips_password_less_rows_without_failing() {
        // A backup CSV mixes a login with a password-less secure note. Re-import
        // keeps the login and skips the note instead of failing the whole import.
        let vault = Vault::new("Backup").unwrap();
        let note = Item::new_secure_note(vault.id.clone(), "Recovery", "codes").unwrap();
        let login = Item::new_login(vault.id.clone(), "Site", "pw").unwrap();

        let csv = export_onepassword_csv(&[note, login]);
        let imported = import_onepassword_csv(&vault, &csv).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].title, "Site");
    }
}
