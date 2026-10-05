//! Lossless edits of Connect API item originals, not display projections or create bodies.
//!
//! The shared Web/Mobile form reads credentials by purpose only and body as
//! nonempty `notes`, then `body`. Purpose-less credential labels and `notesPlain`
//! are hidden data here: the native Desktop DTO uses a different body contract
//! (`notesPlain`, then NOTES purpose). Its local update path remains separate.

/// Apply a complete shared form to an existing API item, retaining its identity and version.
/// No field, URL or optional top-level property is materialized for an unchanged form.
pub fn edit_item(
    original: &serde_json::Value,
    values: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let source = original
        .as_object()
        .ok_or("Original item must be an object")?;
    let form = values.as_object().ok_or("Form values must be an object")?;
    // A complete shared form is required, including fields hidden for a category.
    const TEXT_KEYS: [&str; 8] = [
        "title", "category", "username", "password", "url", "body", "notes", "tags",
    ];
    for key in form.keys() {
        if key != "favorite" && !TEXT_KEYS.contains(&key.as_str()) {
            return Err("Unexpected form property; item identity and version are immutable".into());
        }
    }
    for key in TEXT_KEYS {
        if form.get(key).and_then(serde_json::Value::as_str).is_none() {
            return Err("All text form values must be strings".into());
        }
    }
    let favorite = form
        .get("favorite")
        .and_then(serde_json::Value::as_bool)
        .ok_or("Form favorite must be a boolean")?;
    if source
        .get("id")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err("Original item must have an identity".into());
    }
    if source
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_none_or(|version| version == 0)
    {
        return Err("Original item version must be a positive integer".into());
    }
    let original_title = source
        .get("title")
        .and_then(serde_json::Value::as_str)
        .ok_or("Original title must be a string")?;
    let title = form["title"]
        .as_str()
        .ok_or("Form title must be a string")?;
    if title.trim().is_empty() || original_title.trim().is_empty() {
        return Err("Item title is required".into());
    }
    let category = source
        .get("category")
        .and_then(serde_json::Value::as_str)
        .ok_or("Original category must be a string")?;
    if !matches!(
        category,
        "LOGIN" | "PASSWORD" | "SECURE_NOTE" | "CREDIT_CARD" | "IDENTITY" | "SSH_KEY" | "CUSTOM"
    ) {
        return Err("Unsupported item category".into());
    }
    if form["category"].as_str() != Some(category) {
        return Err("Item category is immutable".into());
    }

    let fields = optional_array(original, "fields")?;
    for field in fields {
        if !field.is_object() {
            return Err("Original fields must be objects".into());
        }
    }
    let tags = optional_array(original, "tags")?;
    let tag_strings: Vec<&str> = tags
        .iter()
        .map(|tag| tag.as_str().ok_or("Original tags must be strings"))
        .collect::<Result<_, _>>()?;
    let original_favorite = match source.get("favorite") {
        None | Some(serde_json::Value::Null) => false,
        Some(value) => value
            .as_bool()
            .ok_or("Original favorite must be a boolean")?,
    };
    let urls = optional_array(original, "urls")?;
    for url in urls {
        if !url.is_object()
            || url
                .get("href")
                .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            return Err("Original URLs must have string href values".into());
        }
    }

    let mut edited = original.clone();
    if title != original_title {
        edited["title"] = serde_json::Value::String(title.into());
    }
    if favorite != original_favorite {
        edited["favorite"] = serde_json::Value::Bool(favorite);
    }
    let tags_input = form["tags"].as_str().ok_or("Form tags must be a string")?;
    if tags_input != tag_strings.join(", ") {
        edited["tags"] = serde_json::Value::Array(
            tags_input
                .split(',')
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(|tag| serde_json::Value::String(tag.into()))
                .collect(),
        );
    }

    let mut edited_fields = fields.to_vec();
    if category == "LOGIN" || category == "PASSWORD" {
        if category == "LOGIN" {
            update_field(
                &mut edited_fields,
                purpose_index(fields, "USERNAME"),
                "username",
                Some("USERNAME"),
                form["username"].as_str().unwrap(),
            )?;
        }
        update_field(
            &mut edited_fields,
            purpose_index(fields, "PASSWORD"),
            "password",
            Some("PASSWORD"),
            form["password"].as_str().unwrap(),
        )?;
        update_field(
            &mut edited_fields,
            label_index(fields, "notes"),
            "notes",
            None,
            form["notes"].as_str().unwrap(),
        )?;
    } else {
        let notes = label_index(fields, "notes");
        let body = label_index(fields, "body");
        // Match fieldValue(notes) || fieldValue(body), including empty notes + body.
        let notes_nonempty = match notes {
            Some(index) => !field_value(&fields[index])?.is_empty(),
            None => false,
        };
        let selected = notes.filter(|_| notes_nonempty).or(body).or(notes);
        update_field(
            &mut edited_fields,
            selected,
            if selected == body && body.is_some() {
                "body"
            } else {
                "notes"
            },
            None,
            form["body"].as_str().unwrap(),
        )?;
    }
    if edited_fields != fields {
        edited["fields"] = serde_json::Value::Array(edited_fields);
    }

    if category == "LOGIN" {
        let selected = urls
            .iter()
            .position(|url| url["primary"].as_bool() == Some(true))
            .or_else(|| (!urls.is_empty()).then_some(0));
        let displayed = selected
            .and_then(|index| urls[index]["href"].as_str())
            .unwrap_or("");
        let url_input = form["url"].as_str().unwrap();
        // Compare the displayed string before trimming so untouched URLs stay byte-for-byte.
        if url_input != displayed {
            let mut edited_urls = urls.to_vec();
            let href = url_input.trim();
            match selected {
                Some(index) if href.is_empty() => {
                    edited_urls.remove(index);
                }
                Some(index) => {
                    edited_urls[index]["href"] = serde_json::Value::String(href.into());
                }
                None if !href.is_empty() => edited_urls.push(serde_json::json!({
                    "href": href, "primary": true, "label": ""
                })),
                None => {}
            }
            if edited_urls != urls {
                edited["urls"] = serde_json::Value::Array(edited_urls);
            }
        }
    }
    Ok(edited)
}

fn optional_array<'a>(
    original: &'a serde_json::Value,
    key: &str,
) -> Result<&'a [serde_json::Value], String> {
    match original.get(key) {
        None | Some(serde_json::Value::Null) => Ok(&[]),
        Some(serde_json::Value::Array(values)) => Ok(values),
        _ => Err("Original item collections must be arrays".into()),
    }
}

fn field_value(field: &serde_json::Value) -> Result<&str, String> {
    match field.get("value") {
        None | Some(serde_json::Value::Null) => Ok(""),
        Some(value) => value
            .as_str()
            .ok_or_else(|| "Editable field value must be a string".into()),
    }
}

fn purpose_index(fields: &[serde_json::Value], purpose: &str) -> Option<usize> {
    // Do not fall back to a username/password label: the form does not display it.
    fields.iter().position(|field| {
        field["purpose"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(purpose))
    })
}

fn label_index(fields: &[serde_json::Value], label: &str) -> Option<usize> {
    fields.iter().position(|field| {
        field["label"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(label))
    })
}

fn update_field(
    fields: &mut Vec<serde_json::Value>,
    index: Option<usize>,
    label: &str,
    purpose: Option<&str>,
    value: &str,
) -> Result<(), String> {
    if let Some(index) = index {
        if value != field_value(&fields[index])? {
            fields[index]["value"] = serde_json::Value::String(value.into());
        }
    } else if !value.is_empty() {
        let mut field = serde_json::json!({
            "label": label, "type": if purpose == Some("PASSWORD") { "CONCEALED" } else { "STRING" },
            "value": value
        });
        if let Some(purpose) = purpose {
            field["purpose"] = serde_json::Value::String(purpose.into());
        }
        fields.push(field);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::edit_item;
    use serde_json::{json, Value};

    // These originals and displayed forms are independent fixtures. Do not derive
    // the expected form or item with the editor's field-selection helpers.
    fn login() -> Value {
        json!({
            "id": "item-original", "version": 17, "title": "Original login", "category": "LOGIN",
            "vault": {"id": "box-original", "metadata": {"keep": true}},
            "fields": [
                {"id": "username-id", "label": "Account", "type": "EMAIL", "purpose": "username",
                 "section": {"id": "section-id"}, "value": "alice", "metadata": {"keep": [1, 2]}},
                {"id": "password-id", "label": "Secret", "type": "CONCEALED", "purpose": "PASSWORD",
                 "value": "fixture-password", "section": {"id": "section-id"}, "future": {"keep": true}},
                {"id": "notes-id", "label": "NoTeS", "type": "STRING", "value": "login notes",
                 "purpose": "NOTES", "metadata": {"format": "markdown"}},
                {"id": "hidden-id", "label": "username", "type": "STRING", "value": "hidden account"},
                {"id": "otp-id", "label": "OTP", "type": "OTP", "value": "fixture-otp", "unknown": null},
                {"id": "other-password", "label": "Second", "type": "CONCEALED", "purpose": "PASSWORD",
                 "value": "second password"},
                {"id": "body-id", "label": "body", "type": "STRING", "value": "hidden body"}
            ],
            "sections": [{"id": "section-id", "label": "Imported", "unknown": [false, null]}],
            "files": [{"id": "file-id", "name": "fixture.txt", "size": 42, "metadata": {"keep": true}}],
            "urls": [
                {"href": "https://secondary.example/", "primary": false, "label": "Secondary", "id": "url-a"},
                {"href": " https://primary.example/ ", "primary": true, "label": "Primary", "id": "url-b",
                 "metadata": {"keep": ["url metadata"]}},
                {"href": "https://third.example/", "primary": true, "label": "Other", "id": "url-c"}
            ],
            "tags": [" work ", "comma,inside", "duplicate", "duplicate", ""], "favorite": true,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-02T00:00:00Z",
            "lastEditedBy": "actor-original", "metadata": {"unknown": {"deep": [1, null, true]}},
            "futureProperty": {"unchanged": "keep"}
        })
    }

    fn login_form() -> Value {
        json!({
            "title": "Original login", "category": "LOGIN", "username": "alice",
            "password": "fixture-password", "url": " https://primary.example/ ",
            "body": "login notes", "notes": "login notes",
            "tags": " work , comma,inside, duplicate, duplicate, ", "favorite": true
        })
    }

    fn card() -> Value {
        json!({
            "id": "card-original", "version": 9, "title": "Imported card", "category": "CREDIT_CARD",
            "vault": {"id": "box-original"},
            "fields": [
                {"id": "number-id", "label": "number", "type": "CONCEALED", "value": "4111111111111111",
                 "section": {"id": "billing"}, "validation": {"digits": 16}},
                {"id": "holder-id", "label": "cardholder", "type": "STRING", "value": "Fixture Holder"}
            ],
            "sections": [{"id": "billing", "label": "Billing"}],
            "files": [{"id": "card-file", "metadata": {"keep": "receipt"}}],
            "urls": [{"href": "https://card.example/", "label": "Issuer", "primary": true}],
            "tags": [], "favorite": false, "metadata": {"import": "fixture"}
        })
    }

    fn card_form() -> Value {
        json!({
            "title": "Imported card", "category": "CREDIT_CARD", "username": "", "password": "",
            "url": "https://card.example/", "body": "", "notes": "", "tags": "", "favorite": false
        })
    }

    #[test]
    fn unchanged_login_is_identical_including_urls_tags_metadata_and_version() {
        let original = login();
        let untouched = original.clone();
        let form = login_form();
        assert_eq!(edit_item(&original, &form).unwrap(), untouched);
        assert_eq!(original, untouched, "editing must not mutate the input");
        assert_eq!(form, login_form(), "editing must not mutate the form");
    }

    #[test]
    fn login_title_edit_changes_only_title() {
        let original = login();
        let mut form = login_form();
        form["title"] = json!("Renamed login");
        let mut expected = login();
        expected["title"] = json!("Renamed login");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        assert_eq!(original, login());
    }

    #[test]
    fn card_without_body_can_be_renamed_without_losing_number_or_adding_fields() {
        let original = card();
        assert_eq!(edit_item(&original, &card_form()).unwrap(), card());
        let mut form = card_form();
        form["title"] = json!("Renamed card");
        let mut expected = card();
        expected["title"] = json!("Renamed card");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn nonempty_card_body_edit_preserves_number_and_every_other_property() {
        let mut original = card();
        original["fields"].as_array_mut().unwrap().push(json!({
            "id": "card-body", "label": "BoDy", "type": "STRING", "value": "Original body",
            "section": {"id": "billing"}, "metadata": {"keep": true}
        }));
        let mut form = card_form();
        form["body"] = json!("Original body");
        assert_eq!(edit_item(&original, &form).unwrap(), original);
        form["title"] = json!("Body card renamed");
        let mut expected = original.clone();
        expected["title"] = json!("Body card renamed");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        form["body"] = json!("Changed body");
        expected["fields"][2]["value"] = json!("Changed body");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        form["body"] = json!("");
        expected["fields"][2]["value"] = json!("");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn notes_and_body_coexist_and_only_the_displayed_field_is_changed() {
        for (notes, displayed, selected) in [("Notes win", "Notes win", 2), ("", "Body wins", 3)] {
            let mut original = card();
            original["fields"].as_array_mut().unwrap().extend([
                json!({"id": "notes-id", "label": "NOTES", "type": "STRING", "value": notes,
                    "purpose": "NOTES", "metadata": {"keep": true}}),
                json!({"id": "body-id", "label": "body", "type": "STRING", "value": "Body wins",
                    "section": {"id": "billing"}}),
            ]);
            let mut form = card_form();
            form["notes"] = json!(notes);
            form["body"] = json!(displayed);
            assert_eq!(edit_item(&original, &form).unwrap(), original);
            form["body"] = json!("Edited visible body");
            let mut expected = original.clone();
            expected["fields"][selected]["value"] = json!("Edited visible body");
            assert_eq!(edit_item(&original, &form).unwrap(), expected);
        }
    }

    #[test]
    fn credential_and_notes_edits_change_only_selected_values() {
        let original = login();
        let mut form = login_form();
        form["username"] = json!("bob");
        form["password"] = json!("new fixture password");
        form["notes"] = json!("");
        let mut expected = login();
        expected["fields"][0]["value"] = json!("bob");
        expected["fields"][1]["value"] = json!("new fixture password");
        expected["fields"][2]["value"] = json!("");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn password_category_retains_hidden_username_urls_and_body() {
        let mut original = login();
        original["category"] = json!("PASSWORD");
        let mut form = login_form();
        form["category"] = json!("PASSWORD");
        assert_eq!(edit_item(&original, &form).unwrap(), original);
        form["password"] = json!("password category edit");
        form["notes"] = json!("password notes edit");
        let mut expected = original.clone();
        expected["fields"][1]["value"] = json!("password category edit");
        expected["fields"][2]["value"] = json!("password notes edit");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn purpose_less_labels_remain_hidden_and_are_not_overwritten_by_empty_form() {
        let mut original = login();
        original["fields"][0]
            .as_object_mut()
            .unwrap()
            .remove("purpose");
        original["fields"][0]["label"] = json!("username");
        original["fields"][1]
            .as_object_mut()
            .unwrap()
            .remove("purpose");
        original["fields"][1]["label"] = json!("password");
        original["fields"][5]
            .as_object_mut()
            .unwrap()
            .remove("purpose");
        let mut form = login_form();
        form["username"] = json!("");
        form["password"] = json!("");
        assert_eq!(edit_item(&original, &form).unwrap(), original);
        form["username"] = json!("visible username");
        form["password"] = json!("visible password");
        let mut expected = original.clone();
        expected["fields"].as_array_mut().unwrap().extend([
            json!({"label": "username", "type": "STRING", "purpose": "USERNAME", "value": "visible username"}),
            json!({"label": "password", "type": "CONCEALED", "purpose": "PASSWORD", "value": "visible password"}),
        ]);
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn all_body_categories_keep_desktop_notes_plain_hidden_in_api_json() {
        for category in [
            "SECURE_NOTE",
            "CREDIT_CARD",
            "IDENTITY",
            "SSH_KEY",
            "CUSTOM",
        ] {
            let mut original = card();
            original["category"] = json!(category);
            original["fields"].as_array_mut().unwrap().push(json!({
                "id": "desktop-body", "label": "notesPlain", "type": "STRING", "value": "Desktop body"
            }));
            let mut form = card_form();
            form["category"] = json!(category);
            assert_eq!(edit_item(&original, &form).unwrap(), original);
            form["body"] = json!("New API body");
            let mut expected = original.clone();
            expected["fields"].as_array_mut().unwrap().push(json!({
                "label": "notes", "type": "STRING", "value": "New API body"
            }));
            assert_eq!(edit_item(&original, &form).unwrap(), expected);
        }
    }

    #[test]
    fn only_primary_url_href_changes_and_clearing_removes_only_primary() {
        let original = login();
        let mut form = login_form();
        form["url"] = json!(" https://edited.example/ ");
        let mut expected = login();
        expected["urls"][1]["href"] = json!("https://edited.example/");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        form["url"] = json!("  ");
        expected = login();
        expected["urls"].as_array_mut().unwrap().remove(1);
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn first_url_is_selected_when_no_primary_and_empty_collection_stays_empty() {
        let mut original = login();
        original["urls"][1]["primary"] = json!(false);
        original["urls"][2]
            .as_object_mut()
            .unwrap()
            .remove("primary");
        let mut form = login_form();
        form["url"] = json!("https://secondary.example/");
        assert_eq!(edit_item(&original, &form).unwrap(), original);
        form["url"] = json!("https://first-edit.example/");
        let mut expected = original.clone();
        expected["urls"][0]["href"] = json!("https://first-edit.example/");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        form["url"] = json!("");
        expected = original.clone();
        expected["urls"].as_array_mut().unwrap().remove(0);
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        original["urls"] = json!([]);
        assert_eq!(edit_item(&original, &form).unwrap(), original);
        form["url"] = json!("https://added.example/");
        expected = original.clone();
        expected["urls"] =
            json!([{"href": "https://added.example/", "primary": true, "label": ""}]);
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn changed_tags_and_favorite_do_not_rewrite_other_data() {
        let original = login();
        let mut form = login_form();
        form["tags"] = json!(" new, ,tag, new, ");
        form["favorite"] = json!(false);
        let mut expected = login();
        expected["tags"] = json!(["new", "tag", "new"]);
        expected["favorite"] = json!(false);
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn unknown_field_types_and_structured_values_are_preserved() {
        let mut original = login();
        original["fields"].as_array_mut().unwrap().push(json!({
            "id": "future-field", "type": "UNKNOWN_FUTURE_TYPE", "label": "Imported future data",
            "value": {"structured": [1, false, null]}, "unknown": {"keep": true}
        }));
        assert_eq!(edit_item(&original, &login_form()).unwrap(), original);
        let mut form = login_form();
        form["password"] = json!("changed password");
        let mut expected = original.clone();
        expected["fields"][1]["value"] = json!("changed password");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
        original["fields"][1]["value"] = json!({"secret": "do not echo"});
        assert_eq!(
            edit_item(&original, &form).unwrap_err(),
            "Editable field value must be a string"
        );
    }

    #[test]
    fn absent_or_null_optional_data_is_not_materialized_on_noop_or_title_edit() {
        for null in [false, true] {
            let mut original = card();
            for key in ["fields", "urls", "tags", "favorite"] {
                if null {
                    original[key] = Value::Null;
                } else {
                    original.as_object_mut().unwrap().remove(key);
                }
            }
            let mut form = card_form();
            form["url"] = json!("");
            assert_eq!(edit_item(&original, &form).unwrap(), original);
            form["title"] = json!("Sparse renamed");
            let mut expected = original.clone();
            expected["title"] = json!("Sparse renamed");
            assert_eq!(edit_item(&original, &form).unwrap(), expected);
        }
    }

    #[test]
    fn sparse_login_does_not_create_empty_credentials_notes_tags_or_urls() {
        for null in [false, true] {
            let mut original = json!({
                "id": "sparse-login", "version": 1, "title": "Sparse login", "category": "LOGIN",
                "metadata": {"keep": true}
            });
            if null {
                for key in ["fields", "urls", "tags", "favorite"] {
                    original[key] = Value::Null;
                }
            }
            let mut form = json!({
                "title": "Sparse login", "category": "LOGIN", "username": "", "password": "",
                "url": "", "body": "", "notes": "", "tags": "", "favorite": false
            });
            assert_eq!(edit_item(&original, &form).unwrap(), original);
            form["title"] = json!("Renamed sparse login");
            let mut expected = original.clone();
            expected["title"] = json!("Renamed sparse login");
            assert_eq!(edit_item(&original, &form).unwrap(), expected);
            form["url"] = json!("https://added.example/");
            expected["urls"] =
                json!([{"href": "https://added.example/", "primary": true, "label": ""}]);
            assert_eq!(edit_item(&original, &form).unwrap(), expected);
        }
    }

    #[test]
    fn missing_and_null_field_values_stay_unchanged_when_the_form_displays_empty() {
        let mut original = login();
        original["fields"][0]
            .as_object_mut()
            .unwrap()
            .remove("value");
        original["fields"][1]["value"] = Value::Null;
        original["fields"][2]["value"] = Value::Null;
        let mut form = login_form();
        form["username"] = json!("");
        form["password"] = json!("");
        form["notes"] = json!("");
        form["body"] = json!("hidden body");
        assert_eq!(edit_item(&original, &form).unwrap(), original);
        form["password"] = json!("New password");
        let mut expected = original.clone();
        expected["fields"][1]["value"] = json!("New password");
        assert_eq!(edit_item(&original, &form).unwrap(), expected);
    }

    #[test]
    fn rejects_partial_forms_and_wrong_types_without_echoing_secrets() {
        let keys = [
            "title", "category", "username", "password", "url", "body", "notes", "tags", "favorite",
        ];
        let original = login();
        for key in keys {
            let mut partial = login_form();
            partial.as_object_mut().unwrap().remove(key);
            assert!(edit_item(&original, &partial).is_err(), "missing {key}");
            for invalid in [
                Value::Null,
                json!(123),
                json!([]),
                json!({"secret": "fixture-password"}),
            ] {
                let mut form = login_form();
                form[key] = invalid;
                let error = edit_item(&original, &form).unwrap_err();
                assert!(!error.contains("fixture-password"));
            }
            let mut wrong_scalar = login_form();
            wrong_scalar[key] = if key == "favorite" {
                json!("true")
            } else {
                json!(false)
            };
            assert!(edit_item(&original, &wrong_scalar).is_err());
        }
        for invalid in [Value::Null, json!([]), json!(true)] {
            assert!(edit_item(&original, &invalid).is_err());
        }
        for title in ["", " \n\t "] {
            let mut form = login_form();
            form["title"] = json!(title);
            assert!(edit_item(&original, &form).is_err());
        }
    }

    #[test]
    fn rejects_category_identity_version_changes_and_unversioned_create_payloads() {
        let original = login();
        for (key, invalid) in [
            ("category", json!("PASSWORD")),
            ("id", json!("new-id")),
            ("version", json!(18)),
            ("fields", json!([])),
        ] {
            let mut form = login_form();
            form[key] = invalid;
            assert!(edit_item(&original, &form).is_err());
        }
        for version in [
            Value::Null,
            json!(0),
            json!(-1),
            json!(1.5),
            json!(17.0),
            json!("17"),
            json!(true),
        ] {
            let mut invalid = login();
            invalid["version"] = version;
            assert!(edit_item(&invalid, &login_form()).is_err());
        }
        for key in ["id", "version", "category", "title"] {
            let mut invalid = login();
            invalid.as_object_mut().unwrap().remove(key);
            assert!(edit_item(&invalid, &login_form()).is_err());
        }
        assert!(
            edit_item(&login_form(), &login_form()).is_err(),
            "create form is not an original"
        );
        let create_body = json!({"title": "Create body", "category": "LOGIN", "fields": []});
        assert!(edit_item(&create_body, &login_form()).is_err());
        for (key, invalid) in [
            ("id", json!("  ")),
            ("title", json!(123)),
            ("category", json!("UNKNOWN")),
            ("fields", json!({})),
            ("tags", json!([1])),
            ("urls", json!([false])),
            ("favorite", json!("false")),
        ] {
            let mut item = login();
            item[key] = invalid;
            assert!(edit_item(&item, &login_form()).is_err());
        }
    }
}
