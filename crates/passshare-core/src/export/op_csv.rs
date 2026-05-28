use crate::domain::field::FieldPurpose;
use crate::domain::item::{Item, ItemCategory};

/// Export items to 1Password-compatible CSV (Title, Username, Password, URL, Notes, Tags).
pub fn export_onepassword_csv(items: &[Item]) -> String {
    let mut writer = csv::WriterBuilder::new()
        .flexible(true)
        .from_writer(Vec::new());

    writer
        .write_record(["Title", "Username", "Password", "URL", "Notes", "Tags"])
        .expect("csv header");

    for item in items {
        if !is_exportable(item) {
            continue;
        }
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
                item.title.as_str(),
                username.as_str(),
                password.as_str(),
                url,
                notes.as_str(),
                tags.as_str(),
            ])
            .expect("csv row");
    }

    String::from_utf8(writer.into_inner().expect("csv buffer")).expect("utf8 csv")
}

fn is_exportable(item: &Item) -> bool {
    matches!(
        item.category,
        ItemCategory::Login | ItemCategory::Password
    ) && item
        .field_value_by_purpose(FieldPurpose::Password)
        .is_some_and(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::vault::Vault;

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
}
