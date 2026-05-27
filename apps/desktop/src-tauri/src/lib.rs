use std::path::PathBuf;
use std::sync::Mutex;

use passshare_core::{
    generator::PasswordGeneratorOptions, LoginItem, PassShareError, PasswordBox, PasswordBoxState,
};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

struct AppState {
    box_path: Mutex<Option<PathBuf>>,
    password_box: Mutex<Option<PasswordBox>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginItemDto {
    id: String,
    title: String,
    url: String,
    username: String,
    password: String,
    notes: String,
}

impl From<&LoginItem> for LoginItemDto {
    fn from(item: &LoginItem) -> Self {
        Self {
            id: item.id.to_string(),
            title: item.title.clone(),
            url: item.url.clone(),
            username: item.username.clone(),
            password: item.password.clone(),
            notes: item.notes.clone(),
        }
    }
}

fn map_error(err: PassShareError) -> String {
    err.to_string()
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
fn list_items(state: State<'_, AppState>) -> Result<Vec<LoginItemDto>, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = pb.as_ref().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    Ok(pb.list_items().map_err(map_error)?.iter().map(Into::into).collect())
}

#[tauri::command]
fn search_items(query: String, state: State<'_, AppState>) -> Result<Vec<LoginItemDto>, String> {
    let pb = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = pb.as_ref().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    Ok(pb
        .search(&query)
        .map_err(map_error)?
        .iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
fn add_item(
    title: String,
    password: String,
    url: Option<String>,
    username: Option<String>,
    notes: Option<String>,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<LoginItemDto, String> {
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let item = LoginItem::new(title, password)
        .map_err(map_error)?
        .with_optional_fields(url, username, notes);
    pb.add_item(item.clone()).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok((&item).into())
}

#[tauri::command]
fn delete_item(id: String, master_password: String, state: State<'_, AppState>) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|_| PassShareError::ItemNotFound.to_string())?;
    let mut guard = state.password_box.lock().map_err(|_| "内部エラー")?;
    let pb = guard.as_mut().ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    pb.delete_item(uuid).map_err(map_error)?;
    pb.save(&master_password).map_err(map_error)?;
    Ok(())
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
            delete_item,
            generate_password,
            lock_password_box,
        ])
        .run(tauri::generate_context!())
        .expect("PassShare desktop failed to start");
}
