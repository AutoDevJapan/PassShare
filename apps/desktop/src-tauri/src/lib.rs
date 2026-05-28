use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;

use passshare_core::{
    domain::connect_id::ConnectId,
    domain::field::{Field, FieldType},
    domain::item::{ItemCategory, ItemUrl, VaultReference},
    generator::PasswordGeneratorOptions,
    Item,
    PassShareError,
    PasswordBox,
    PasswordBoxState,
};
use passshare_core::domain::field::FieldPurpose;
use chrono::Utc;
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
        _ => Err(PassShareError::Internal(format!("unsupported category: {category}"))),
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
        ItemCategory::SecureNote => Item::new_secure_note(vault_id, title, body.unwrap_or_default())?,
        ItemCategory::CreditCard | ItemCategory::Identity | ItemCategory::SshKey | ItemCategory::Custom => {
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
    let pb = pb.as_ref().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
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
    let pb = pb.as_ref().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
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
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
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
                created.set_field_by_purpose(FieldPurpose::Notes, &notes).map_err(map_error)?;
            }
            created
        }
        ItemCategory::SecureNote => {
            Item::new_secure_note(vault_id, title, body.unwrap_or_default()).map_err(map_error)?
        }
        ItemCategory::CreditCard | ItemCategory::Identity | ItemCategory::SshKey | ItemCategory::Custom => {
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
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
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
                item.set_field_by_label("notes", &notes).map_err(map_error)?;
            }
            item.urls.clear();
            if let Some(url) = url.filter(|value| !value.is_empty()) {
                item.urls.push(ItemUrl {
                    label: String::new(),
                    primary: true,
                    href: url,
                });
            }
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
        ItemCategory::SecureNote | ItemCategory::CreditCard | ItemCategory::Identity | ItemCategory::SshKey | ItemCategory::Custom => {
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

#[tauri::command]
fn delete_item(id: String, master_password: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    pb.delete_item(&id).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(())
}

#[tauri::command]
fn import_onepassword_csv(csv_data: String, master_password: String, state: State<'_, AppState>) -> Result<usize, String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let count = pb.import_onepassword_csv(&csv_data).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(count)
}

#[tauri::command]
fn export_onepassword_csv(state: State<'_, AppState>) -> Result<String, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = pb.as_ref().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
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
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let vault_id = pb.vault().map_err(map_error)?.id.clone();
    let connect_id = ConnectId::from_str(&id).map_err(map_error)?;
    let parsed = parse_category(&category).map_err(map_error)?;
    let item = build_item_from_fields(
        connect_id,
        vault_id,
        parsed,
        title,
        password,
        url,
        username,
        notes,
        body,
        tags,
        favorite,
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

    #[test]
    fn smoke_create_open_add_list_lock() {
        let dir = std::env::temp_dir().join(format!("passshare-desktop-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path: PathBuf = dir.join("smoke.pbox");
        let password = "TestPass123!";

        let mut pb = PasswordBox::create(&path, password).expect("create");
        let vault_id = pb.vault().expect("vault").id.clone();
        let item = Item::new_login(vault_id, "Smoke Login", "secret").expect("item");
        pb.add_item(item).expect("add");
        pb.save(password).expect("save");

        let pb = PasswordBox::open(&path, password).expect("open");
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
}
