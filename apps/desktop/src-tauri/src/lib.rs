use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;

use chrono::Utc;
use passshare_core::domain::field::FieldPurpose;
use passshare_core::{
    domain::connect_id::ConnectId,
    domain::field::{Field, FieldType},
    domain::item::{ItemCategory, ItemUrl, VaultReference},
    generator::PasswordGeneratorOptions,
    Item, PassShareError, PasswordBox, PasswordBoxState,
};
use serde::Serialize;
use tauri::State;

struct AppState {
    box_path: Mutex<Option<PathBuf>>,
    password_box: Mutex<Option<PasswordBox>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemDto {
    id: String,
    title: String,
    category: String,
    tags: Vec<String>,
    favorite: bool,
    url: Option<String>,
    username: Option<String>,
    password: Option<String>,
    body: Option<String>,
    notes: Option<String>,
}

impl From<&Item> for ItemDto {
    fn from(item: &Item) -> Self {
        let url = item
            .urls
            .iter()
            .find(|u| u.primary)
            .map(|u| u.href.clone())
            .or_else(|| item.urls.first().map(|u| u.href.clone()));

        let body = match item.category {
            ItemCategory::SecureNote
            | ItemCategory::CreditCard
            | ItemCategory::Identity
            | ItemCategory::SshKey
            | ItemCategory::Custom => item
                .field_value_by_label("notesPlain")
                .or_else(|| item.field_value_by_purpose(FieldPurpose::Notes)),
            _ => None,
        };

        Self {
            id: item.id.to_string(),
            title: item.title.clone(),
            category: category_to_api(&item.category),
            tags: item.tags.clone(),
            favorite: item.favorite,
            url,
            username: item.field_value_by_purpose(FieldPurpose::Username),
            password: item.field_value_by_purpose(FieldPurpose::Password),
            body,
            notes: item.field_value_by_label("notes"),
        }
    }
}

fn category_to_api(category: &ItemCategory) -> String {
    match category {
        ItemCategory::Login => "LOGIN".into(),
        ItemCategory::Password => "PASSWORD".into(),
        ItemCategory::SecureNote => "SECURE_NOTE".into(),
        ItemCategory::CreditCard => "CREDIT_CARD".into(),
        ItemCategory::Identity => "IDENTITY".into(),
        ItemCategory::SshKey => "SSH_KEY".into(),
        ItemCategory::Custom => "CUSTOM".into(),
    }
}

fn parse_category(category: &str) -> Result<ItemCategory, PassShareError> {
    match category.to_ascii_uppercase().as_str() {
        "LOGIN" => Ok(ItemCategory::Login),
        "PASSWORD" => Ok(ItemCategory::Password),
        "SECURE_NOTE" => Ok(ItemCategory::SecureNote),
        "CREDIT_CARD" => Ok(ItemCategory::CreditCard),
        "IDENTITY" => Ok(ItemCategory::Identity),
        "SSH_KEY" => Ok(ItemCategory::SshKey),
        "CUSTOM" => Ok(ItemCategory::Custom),
        _ => Err(PassShareError::Internal(format!(
            "unsupported category: {category}"
        ))),
    }
}

fn new_body_item(
    vault_id: ConnectId,
    category: ItemCategory,
    title: String,
    body: String,
) -> Result<Item, PassShareError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(PassShareError::TitleRequired);
    }
    let now = Utc::now();
    Ok(Item {
        id: ConnectId::generate()?,
        title: title.to_string(),
        category,
        vault: VaultReference { id: vault_id },
        fields: vec![Field::new("notesPlain", FieldType::String, body)?],
        sections: vec![],
        urls: vec![],
        tags: vec![],
        favorite: false,
        created_at: now,
        updated_at: now,
        last_edited_by: None,
    })
}

fn map_error(err: PassShareError) -> String {
    err.to_string()
}

fn build_item_from_fields(
    id: ConnectId,
    vault_id: ConnectId,
    category: ItemCategory,
    title: String,
    password: Option<String>,
    url: Option<String>,
    username: Option<String>,
    notes: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
) -> Result<Item, PassShareError> {
    let mut item = match category {
        ItemCategory::Login => {
            let password = password.ok_or(PassShareError::PasswordRequired)?;
            Item::new_login(vault_id, title, password)?
                .with_optional_fields(url, username, notes)?
        }
        ItemCategory::Password => {
            let password = password.ok_or(PassShareError::PasswordRequired)?;
            let mut created = Item::new_password(vault_id, title, password)?;
            if let Some(notes) = notes {
                created.set_field_by_purpose(FieldPurpose::Notes, &notes)?;
            }
            created
        }
        ItemCategory::SecureNote => {
            Item::new_secure_note(vault_id, title, body.unwrap_or_default())?
        }
        ItemCategory::CreditCard
        | ItemCategory::Identity
        | ItemCategory::SshKey
        | ItemCategory::Custom => {
            new_body_item(vault_id, category, title, body.unwrap_or_default())?
        }
    };

    item.id = id;

    if let Some(tags) = tags {
        item.set_tags(tags);
    }
    if let Some(favorite) = favorite {
        item.set_favorite(favorite);
    }

    Ok(item)
}

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> Result<String, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    Ok(match pb.as_ref().map(|b| b.state()) {
        Some(PasswordBoxState::Unlocked) => "unlocked".into(),
        Some(PasswordBoxState::Locked) | None => "locked".into(),
    })
}

#[tauri::command]
fn create_password_box(
    path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let path = PathBuf::from(path);
    let pb = PasswordBox::create(&path, &master_password).map_err(map_error)?;
    let recovery = pb.recovery_secret().map_err(map_error)?.map(String::from);
    *state.box_path.lock().map_err(|_| "内部エラー")? = Some(path);
    *state.password_box.lock().map_err(|_| "内部エラー")? = Some(pb);
    Ok(recovery)
}

#[tauri::command]
fn open_password_box(
    path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let pb = PasswordBox::open(&path, &master_password).map_err(map_error)?;
    *state.box_path.lock().map_err(|_| "内部エラー")? = Some(path);
    *state.password_box.lock().map_err(|_| "内部エラー")? = Some(pb);
    Ok(())
}

#[tauri::command]
fn list_items(state: State<'_, AppState>) -> Result<Vec<ItemDto>, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = pb
        .as_ref()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    Ok(pb
        .list_connect_items()
        .map_err(map_error)?
        .iter()
        .map(ItemDto::from)
        .collect())
}

#[tauri::command]
fn search_items(query: String, state: State<'_, AppState>) -> Result<Vec<ItemDto>, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = pb
        .as_ref()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    Ok(pb
        .search_connect_items(&query)
        .map_err(map_error)?
        .iter()
        .map(ItemDto::from)
        .collect())
}

#[tauri::command]
fn add_item(
    category: String,
    title: String,
    password: Option<String>,
    url: Option<String>,
    username: Option<String>,
    notes: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ItemDto, String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let vault_id = pb.vault().map_err(map_error)?.id.clone();
    let parsed = parse_category(&category).map_err(map_error)?;

    let mut item = match parsed {
        ItemCategory::Login => {
            let password = password.ok_or_else(|| PassShareError::PasswordRequired.to_string())?;
            Item::new_login(vault_id, title, password)
                .map_err(map_error)?
                .with_optional_fields(url, username, notes)
                .map_err(map_error)?
        }
        ItemCategory::Password => {
            let password = password.ok_or_else(|| PassShareError::PasswordRequired.to_string())?;
            let mut created = Item::new_password(vault_id, title, password).map_err(map_error)?;
            if let Some(notes) = notes {
                created
                    .set_field_by_purpose(FieldPurpose::Notes, &notes)
                    .map_err(map_error)?;
            }
            created
        }
        ItemCategory::SecureNote => {
            Item::new_secure_note(vault_id, title, body.unwrap_or_default()).map_err(map_error)?
        }
        ItemCategory::CreditCard
        | ItemCategory::Identity
        | ItemCategory::SshKey
        | ItemCategory::Custom => {
            new_body_item(vault_id, parsed, title, body.unwrap_or_default()).map_err(map_error)?
        }
    };

    if let Some(tags) = tags {
        item.set_tags(tags);
    }
    if let Some(favorite) = favorite {
        item.set_favorite(favorite);
    }

    pb.add_item(item.clone()).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(ItemDto::from(&item))
}

#[tauri::command]
fn update_item(
    id: String,
    title: String,
    password: Option<String>,
    url: Option<String>,
    username: Option<String>,
    notes: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ItemDto, String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let existing = pb.get_item(&id).map_err(map_error)?.clone();

    let mut item = existing;
    item.set_title(title).map_err(map_error)?;

    match item.category {
        ItemCategory::Login => {
            if let Some(password) = password {
                item.set_field_by_purpose(FieldPurpose::Password, &password)
                    .map_err(map_error)?;
            }
            if let Some(username) = username {
                item.set_field_by_purpose(FieldPurpose::Username, &username)
                    .map_err(map_error)?;
            }
            if let Some(notes) = notes {
                item.set_field_by_label("notes", &notes)
                    .map_err(map_error)?;
            }
            update_primary_url(&mut item.urls, url);
        }
        ItemCategory::Password => {
            if let Some(password) = password {
                item.set_field_by_purpose(FieldPurpose::Password, &password)
                    .map_err(map_error)?;
            }
            if let Some(notes) = notes {
                item.set_field_by_purpose(FieldPurpose::Notes, &notes)
                    .map_err(map_error)?;
            }
        }
        ItemCategory::SecureNote
        | ItemCategory::CreditCard
        | ItemCategory::Identity
        | ItemCategory::SshKey
        | ItemCategory::Custom => {
            if let Some(body) = body {
                item.set_field_by_label("notesPlain", &body)
                    .map_err(map_error)?;
            }
        }
    }

    if let Some(tags) = tags {
        item.set_tags(tags);
    }
    if let Some(favorite) = favorite {
        item.set_favorite(favorite);
    }

    pb.update_item(item.clone()).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(ItemDto::from(&item))
}

// Use the same primary-or-first selection as ItemDto. None is an omitted edit;
// an explicit empty string removes only the selected URL, never the whole list.
fn update_primary_url(urls: &mut Vec<ItemUrl>, url: Option<String>) {
    let Some(href) = url else {
        return;
    };
    let selected = urls
        .iter()
        .position(|entry| entry.primary)
        .or_else(|| (!urls.is_empty()).then_some(0));
    match selected {
        Some(index) if href.is_empty() => {
            urls.remove(index);
        }
        Some(index) => {
            urls[index].href = href;
        }
        None if !href.is_empty() => urls.push(ItemUrl {
            label: String::new(),
            primary: true,
            href,
        }),
        None => {}
    }
}

#[tauri::command]
fn delete_item(
    id: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    pb.delete_item(&id).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(())
}

#[tauri::command]
fn import_onepassword_csv(
    csv_data: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let count = pb.import_onepassword_csv(&csv_data).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(count)
}

#[tauri::command]
fn export_onepassword_csv(state: State<'_, AppState>) -> Result<String, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = pb
        .as_ref()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    pb.export_onepassword_csv().map_err(map_error)
}

#[tauri::command]
fn upsert_sync_item(
    id: String,
    category: String,
    title: String,
    password: Option<String>,
    url: Option<String>,
    username: Option<String>,
    notes: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<ItemDto, String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let vault_id = pb.vault().map_err(map_error)?.id.clone();
    let connect_id = ConnectId::from_str(&id).map_err(map_error)?;
    let parsed = parse_category(&category).map_err(map_error)?;
    let item = build_item_from_fields(
        connect_id, vault_id, parsed, title, password, url, username, notes, body, tags, favorite,
    )
    .map_err(map_error)?;

    pb.upsert_sync_item(item.clone()).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(ItemDto::from(&item))
}

#[tauri::command]
fn generate_password(length: Option<usize>) -> String {
    PasswordBox::generate_password(PasswordGeneratorOptions {
        length: length.unwrap_or(16),
        ..Default::default()
    })
}

#[tauri::command]
fn lock_password_box(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    if let Some(pb) = guard.as_mut() {
        pb.lock();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            box_path: Mutex::new(None),
            password_box: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            create_password_box,
            open_password_box,
            list_items,
            search_items,
            add_item,
            update_item,
            delete_item,
            import_onepassword_csv,
            export_onepassword_csv,
            upsert_sync_item,
            generate_password,
            lock_password_box,
        ])
        .run(tauri::generate_context!())
        .expect("PassShare desktop failed to start");
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use passshare_core::domain::item::ItemCategory;
    use std::path::PathBuf;

    const MASTER_PASSWORD: &str = "TestPass123!";

    fn temp_box(name: &str) -> (PathBuf, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("passshare-desktop-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("smoke.pbox");
        (dir, path)
    }

    fn add_login(
        pb: &mut PasswordBox,
        title: &str,
        password: &str,
        url: Option<&str>,
        username: Option<&str>,
        tags: &[&str],
    ) -> Item {
        let vault_id = pb.vault().expect("vault").id.clone();
        let mut item = Item::new_login(vault_id, title, password)
            .expect("login item")
            .with_optional_fields(url.map(String::from), username.map(String::from), None)
            .expect("optional fields");
        if !tags.is_empty() {
            item.set_tags(tags.iter().map(|t| t.to_string()).collect());
        }
        pb.add_item(item.clone()).expect("add");
        item
    }

    #[test]
    fn smoke_create_open_add_list_lock() {
        let (dir, path) = temp_box("smoke");

        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        add_login(&mut pb, "Smoke Login", "secret", None, None, &[]);
        pb.save(MASTER_PASSWORD).expect("save");

        let pb = PasswordBox::open(&path, MASTER_PASSWORD).expect("open");
        let items = pb.list_connect_items().expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Smoke Login");
        assert_eq!(items[0].category, ItemCategory::Login);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parse_all_connect_categories() {
        for category in [
            "LOGIN",
            "PASSWORD",
            "SECURE_NOTE",
            "CREDIT_CARD",
            "IDENTITY",
            "SSH_KEY",
            "CUSTOM",
        ] {
            parse_category(category).expect(category);
        }
    }

    #[test]
    fn smoke_edit_primary_url_preserves_other_urls_labels_and_item_data() {
        let id = ConnectId::generate().expect("box id");
        let mut original =
            Item::new_login(id, "Imported login", "fixture-password").expect("login item");
        original.fields.push(
            Field::new("Imported extra", FieldType::String, "keep field").expect("extra field"),
        );
        original.urls = vec![
            ItemUrl {
                label: "Secondary".into(),
                primary: false,
                href: "https://secondary.example/".into(),
            },
            ItemUrl {
                label: "Primary".into(),
                primary: true,
                href: "https://primary.example/".into(),
            },
            ItemUrl {
                label: "Other primary".into(),
                primary: true,
                href: "https://third.example/".into(),
            },
        ];
        assert_eq!(
            ItemDto::from(&original).url.as_deref(),
            Some("https://primary.example/")
        );

        for omitted_or_same in [None, Some("https://primary.example/".into())] {
            let mut edited = original.clone();
            update_primary_url(&mut edited.urls, omitted_or_same);
            assert_eq!(
                edited, original,
                "an untouched URL must preserve the entire item"
            );
        }
        let mut edited = original.clone();
        update_primary_url(&mut edited.urls, Some("https://changed.example/".into()));
        let mut expected = original.clone();
        expected.urls[1].href = "https://changed.example/".into();
        assert_eq!(edited, expected);

        let mut cleared = original.clone();
        update_primary_url(&mut cleared.urls, Some(String::new()));
        let mut expected = original.clone();
        expected.urls.remove(1);
        assert_eq!(cleared, expected);

        let mut no_primary = original.clone();
        for url in &mut no_primary.urls {
            url.primary = false;
        }
        assert_eq!(
            ItemDto::from(&no_primary).url.as_deref(),
            Some("https://secondary.example/")
        );
        let mut first_edited = no_primary.clone();
        update_primary_url(
            &mut first_edited.urls,
            Some("https://first.example/".into()),
        );
        let mut expected = no_primary.clone();
        expected.urls[0].href = "https://first.example/".into();
        assert_eq!(first_edited, expected);
        let mut first_cleared = no_primary.clone();
        update_primary_url(&mut first_cleared.urls, Some(String::new()));
        no_primary.urls.remove(0);
        assert_eq!(first_cleared, no_primary);

        let mut empty = Vec::new();
        update_primary_url(&mut empty, None);
        update_primary_url(&mut empty, Some(String::new()));
        assert!(empty.is_empty());
        update_primary_url(&mut empty, Some("https://new.example/".into()));
        assert_eq!(
            empty,
            vec![ItemUrl {
                label: String::new(),
                primary: true,
                href: "https://new.example/".into()
            }]
        );
    }

    #[test]
    fn smoke_edited_primary_url_and_untouched_data_survive_save_reopen() {
        let (dir, path) = temp_box("edit-primary-url");
        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        let mut original = Item::new_login(
            pb.vault().expect("box").id.clone(),
            "Imported login",
            "fixture-password",
        )
        .expect("login item");
        let section_id = ConnectId::generate().expect("section id");
        original
            .sections
            .push(passshare_core::domain::field::Section {
                id: section_id.clone(),
                label: "Imported section".into(),
            });
        let mut extra = Field::new("Extra", FieldType::String, "keep field").expect("extra field");
        extra.section = Some(passshare_core::domain::field::SectionReference { id: section_id });
        original.fields.push(extra);
        original.urls = vec![
            ItemUrl {
                label: "Secondary".into(),
                primary: false,
                href: "https://secondary.example/".into(),
            },
            ItemUrl {
                label: "Primary".into(),
                primary: true,
                href: "https://primary.example/".into(),
            },
        ];
        original.tags = vec!["imported".into()];
        original.favorite = true;
        pb.add_item(original.clone()).expect("add");
        let mut edited = original.clone();
        // This helper is the URL mutation used by the native update_item command.
        update_primary_url(&mut edited.urls, Some("https://changed.example/".into()));
        pb.update_item(edited).expect("update");
        pb.save(MASTER_PASSWORD).expect("save");
        drop(pb);

        let pb = PasswordBox::open(&path, MASTER_PASSWORD).expect("reopen");
        let mut expected = original;
        expected.urls[1].href = "https://changed.example/".into();
        assert_eq!(
            pb.get_item(&expected.id.to_string()).expect("read edited"),
            &expected
        );
        drop(pb);
        std::fs::remove_dir_all(dir).expect("remove test files");
    }

    // MVP ATDD: タイトルで検索すると一致するログイン情報のみ返る
    // （タイトル / URL / ユーザー名 / タグの各軸をカバー）
    #[test]
    fn smoke_search_by_title_url_username_and_tag() {
        let (dir, path) = temp_box("search");

        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        add_login(
            &mut pb,
            "GitHub",
            "gh-pass-1",
            Some("https://github.com"),
            Some("alice"),
            &[],
        );
        add_login(
            &mut pb,
            "メールサービス",
            "mail-pass-2",
            Some("https://mail.example.jp"),
            Some("bob"),
            &["work"],
        );
        pb.save(MASTER_PASSWORD).expect("save");

        let by_title = pb.search_connect_items("github").expect("title search");
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].title, "GitHub");

        let by_url = pb.search_connect_items("mail.example").expect("url search");
        assert_eq!(by_url.len(), 1);
        assert_eq!(by_url[0].title, "メールサービス");

        let by_username = pb.search_connect_items("alice").expect("username search");
        assert_eq!(by_username.len(), 1);
        assert_eq!(by_username[0].title, "GitHub");

        let by_tag = pb.search_connect_items("work").expect("tag search");
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].title, "メールサービス");

        assert!(pb
            .search_connect_items("存在しない")
            .expect("no hit")
            .is_empty());
        assert_eq!(pb.search_connect_items("  ").expect("empty query").len(), 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    // MVP ATDD: 16文字・記号込みのパスワードを生成すると推測困難な文字列が返る
    #[test]
    fn smoke_generate_password_16_chars_with_symbols() {
        let options = || PasswordGeneratorOptions {
            length: 16,
            ..Default::default()
        };
        let generated = PasswordBox::generate_password(options());
        assert_eq!(generated.chars().count(), 16);
        assert!(generated.chars().any(|c| c.is_ascii_lowercase()));
        assert!(generated.chars().any(|c| c.is_ascii_uppercase()));
        assert!(generated.chars().any(|c| c.is_ascii_digit()));
        assert!(generated.chars().any(|c| "!@#$%^&*()-_=+[]{}".contains(c)));

        let another = PasswordBox::generate_password(options());
        assert_ne!(generated, another, "同一パスワードが連続生成された");
    }

    // MVP ATDD: 削除した項目は保存後・再オープン後も存在しない
    #[test]
    fn smoke_delete_item_persists_after_reopen() {
        let (dir, path) = temp_box("delete");

        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        let keep = add_login(&mut pb, "Keep", "keep-pass", None, None, &[]);
        let remove = add_login(&mut pb, "Remove", "remove-pass", None, None, &[]);
        pb.save(MASTER_PASSWORD).expect("save");

        pb.delete_item(&remove.id.to_string()).expect("delete");
        pb.save(MASTER_PASSWORD).expect("save after delete");

        assert_eq!(
            pb.delete_item(&remove.id.to_string()),
            Err(PassShareError::ItemNotFound),
            "削除済み ID の再削除は ItemNotFound"
        );

        let pb = PasswordBox::open(&path, MASTER_PASSWORD).expect("reopen");
        let items = pb.list_connect_items().expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, keep.id);

        let _ = std::fs::remove_dir_all(dir);
    }

    // MVP ATDD: 間違ったマスターパスワードではエラーが返り、中身は読めない
    #[test]
    fn smoke_open_with_wrong_master_password_fails() {
        let (dir, path) = temp_box("wrongpass");

        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        add_login(&mut pb, "Secret Login", "top-secret", None, None, &[]);
        pb.save(MASTER_PASSWORD).expect("save");

        let err = match PasswordBox::open(&path, "WrongPass456?") {
            Ok(_) => panic!("間違ったマスターパスワードで開けてしまった"),
            Err(err) => err,
        };
        assert_eq!(err, PassShareError::InvalidMasterPassword);
        assert!(
            map_error(err).starts_with("PS001"),
            "UI へは PS001 エラーコードで返る"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    // MVP ATDD: 初回作成時に緊急キット（リカバリ用シークレットキー）が表示でき、
    // 再オープン後も同じ値が保持される。閉じた状態では読めない
    #[test]
    fn smoke_recovery_kit_available_and_persisted() {
        let (dir, path) = temp_box("recovery");

        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        let secret = pb
            .recovery_secret()
            .expect("recovery accessible")
            .expect("recovery generated on create")
            .to_string();
        assert!(!secret.is_empty());

        pb.lock();
        assert_eq!(
            pb.recovery_secret(),
            Err(PassShareError::BoxLocked),
            "閉じた状態では緊急キットを読めない"
        );

        let pb = PasswordBox::open(&path, MASTER_PASSWORD).expect("reopen");
        assert_eq!(
            pb.recovery_secret().expect("recovery accessible"),
            Some(secret.as_str()),
            "再オープン後も同じシークレットが保持される"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    // 主要 category（CREDIT_CARD 等 7 種）が parse / CRUD をエラーなく通過する
    #[test]
    fn smoke_all_categories_crud_roundtrip() {
        let (dir, path) = temp_box("categories");
        let categories = [
            "LOGIN",
            "PASSWORD",
            "SECURE_NOTE",
            "CREDIT_CARD",
            "IDENTITY",
            "SSH_KEY",
            "CUSTOM",
        ];

        let mut pb = PasswordBox::create(&path, MASTER_PASSWORD).expect("create");
        let vault_id = pb.vault().expect("vault").id.clone();

        for name in categories {
            let category = parse_category(name).expect(name);
            let needs_password = matches!(category, ItemCategory::Login | ItemCategory::Password);
            let item = build_item_from_fields(
                ConnectId::generate().expect("id"),
                vault_id.clone(),
                category,
                format!("{name} item"),
                needs_password.then(|| format!("{name}-pass")),
                None,
                None,
                None,
                (!needs_password).then(|| format!("{name} body")),
                Some(vec![name.to_ascii_lowercase()]),
                Some(false),
            )
            .expect(name);
            pb.add_item(item).expect(name);
        }
        pb.save(MASTER_PASSWORD).expect("save");

        // Read: 全 category が API 文字列へ round-trip する
        let mut pb = PasswordBox::open(&path, MASTER_PASSWORD).expect("reopen");
        let items = pb.list_connect_items().expect("list");
        assert_eq!(items.len(), categories.len());
        for name in categories {
            let item = items
                .iter()
                .find(|i| category_to_api(&i.category) == name)
                .unwrap_or_else(|| panic!("{name} が一覧に存在しない"));
            assert_eq!(item.title, format!("{name} item"));
        }

        // Update: CREDIT_CARD の body を更新して永続化を確認
        let mut card = items
            .iter()
            .find(|i| i.category == ItemCategory::CreditCard)
            .expect("credit card")
            .clone();
        card.set_field_by_label("notesPlain", "4111 1111 1111 1111")
            .expect("set body");
        pb.update_item(card.clone()).expect("update");
        pb.save(MASTER_PASSWORD).expect("save update");

        let pb2 = PasswordBox::open(&path, MASTER_PASSWORD).expect("reopen after update");
        let updated = pb2.get_item(&card.id.to_string()).expect("get updated");
        assert_eq!(
            ItemDto::from(updated).body.as_deref(),
            Some("4111 1111 1111 1111")
        );

        // Delete: 全件削除できる
        let mut pb = pb2;
        for item in pb.list_connect_items().expect("list before delete") {
            pb.delete_item(&item.id.to_string()).expect("delete");
        }
        pb.save(MASTER_PASSWORD).expect("save deletes");
        assert!(pb.list_connect_items().expect("final list").is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }
}
