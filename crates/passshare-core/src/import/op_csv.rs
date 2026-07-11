use std::collections::HashMap;

use crate::domain::item::{Item, ItemCategory, ItemUrl};
use crate::domain::vault::Vault;
use crate::error::PassShareError;

/// Import 1Password CSV export into Connect-compatible LOGIN items.
///
/// Expected columns (case-insensitive): Title, Username, Password, URL/Website, Notes, Tags.
pub fn import_onepassword_csv(vault: &Vault, csv_data: &str) -> Result<Vec<Item>, PassShareError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(csv_data.as_bytes());

    let headers = reader
        .headers()
        .map_err(|e| PassShareError::ImportError(e.to_string()))?
        .clone();
    let column_map = build_column_map(&headers);

    let title_idx = *column_map
        .get("title")
        .ok_or_else(|| PassShareError::ImportError("missing Title column".into()))?;

    let mut items = Vec::new();
    for result in reader.records() {
        let record = result.map_err(|e| PassShareError::ImportError(e.to_string()))?;
        let title = record
            .get(title_idx)
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }

        let password = column_map
            .get("password")
            .and_then(|i| record.get(*i))
            .unwrap_or("")
            .to_string();
        // Skip password-less rows instead of failing the whole import. Our own
        // export (#392) emits password-less categories (secure notes, …) with an
        // empty Password column; erroring here would break the export→import
        // roundtrip and reject otherwise-valid backups. Parity with the TS SSOT
        // `frontend/src/lib/csv-import.ts`, which likewise skips such rows.
        if password.is_empty() {
            continue;
        }

        let mut item = Item::new_login(vault.id.clone(), title, password)?;
        item.category = ItemCategory::Login;

        if let Some(idx) = column_map.get("username") {
            if let Some(username) = record.get(*idx).filter(|v| !v.is_empty()) {
                item = item.with_optional_fields(None, Some(username.to_string()), None)?;
            }
        }
        if let Some(idx) = column_map.get("url").or_else(|| column_map.get("website")) {
            if let Some(url) = record.get(*idx).filter(|v| !v.is_empty()) {
                item.urls.push(ItemUrl {
                    label: String::new(),
                    primary: true,
                    href: url.to_string(),
                });
            }
        }
        if let Some(idx) = column_map.get("notes") {
            if let Some(notes) = record.get(*idx).filter(|v| !v.is_empty()) {
                item = item.with_optional_fields(None, None, Some(notes.to_string()))?;
            }
        }
        if let Some(idx) = column_map.get("tags") {
            if let Some(tags) = record.get(*idx).filter(|v| !v.is_empty()) {
                item.tags = tags
                    .split(',')
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(String::from)
                    .collect();
            }
        }

        items.push(item);
    }

    Ok(items)
}

fn build_column_map(headers: &csv::StringRecord) -> HashMap<String, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(idx, h)| (normalize_header(h), idx))
        .collect()
}

fn normalize_header(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(' ', "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::field::FieldPurpose;

    #[test]
    fn imports_login_rows() {
        let vault = Vault::new("Imported").unwrap();
        let csv = "\
Title,Username,Password,URL,Notes,Tags
GitHub,dev@example.com,secret123,https://github.com,work account,dev
";
        let items = import_onepassword_csv(&vault, csv).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "GitHub");
        assert_eq!(
            items[0].field_value_by_purpose(FieldPurpose::Password),
            Some("secret123".into())
        );
        assert_eq!(items[0].urls[0].href, "https://github.com");
        assert_eq!(items[0].tags, vec!["dev"]);
    }

    #[test]
    fn skips_password_less_rows_instead_of_failing() {
        let vault = Vault::new("Imported").unwrap();
        let csv = "\
Title,Username,Password,URL,Notes,Tags
Recovery codes,,,,one two three,
GitHub,dev@example.com,secret123,https://github.com,,
";
        let items = import_onepassword_csv(&vault, csv).unwrap();
        // The password-less note row is skipped; the login is kept.
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "GitHub");
        assert_eq!(
            items[0].field_value_by_purpose(FieldPurpose::Password),
            Some("secret123".into())
        );
    }
}
