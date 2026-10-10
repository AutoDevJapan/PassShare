use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::Utc;
use passshare_core::domain::field::FieldPurpose;
use passshare_core::{
    domain::connect_id::ConnectId,
    domain::field::{Field, FieldType},
    domain::item::{ItemCategory, ItemUrl, VaultReference},
    generator::PasswordGeneratorOptions,
    Item, PassShareError, PasswordBox, PasswordBoxState, SavedChange,
};
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

#[path = "../../../../shared/native-lock.rs"]
mod native_lock;
use native_lock::NativeLock;

struct AppState {
    data: Mutex<BoxSession>,
    cancellation: AtomicU64,
    recovery_active: AtomicBool,
    recovery_session_ticket: AtomicU64,
    foreground: AtomicBool,
}

#[derive(Clone, Serialize)]
struct NativeStatus {
    epoch: u64,
    unlocked: bool,
}

#[derive(Default)]
struct BoxSession {
    password_box: Option<PasswordBox>,
    box_path: Option<PathBuf>,
    session: NativeLock,
}

impl Deref for BoxSession {
    type Target = Option<PasswordBox>;
    fn deref(&self) -> &Self::Target {
        &self.password_box
    }
}
impl DerefMut for BoxSession {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.password_box
    }
}

impl BoxSession {
    // Every deadline observation also erases the decrypted box in the same
    // critical section, including input racing the timer at the idle boundary.
    fn check_and_wipe(&mut self, now: Instant) -> bool {
        let open = self.session.is_unlocked(now);
        if !open {
            if let Some(pb) = self.password_box.as_mut() {
                pb.lock();
            }
        }
        open
    }
}

impl AppState {
    fn status(&self) -> Result<NativeStatus, String> {
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        let unlocked = data.check_and_wipe(Instant::now());
        Ok(NativeStatus {
            epoch: data.session.epoch(),
            unlocked,
        })
    }
    fn access(&self) -> Result<MutexGuard<'_, BoxSession>, String> {
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        if !data.check_and_wipe(Instant::now()) {
            return Err(PassShareError::BoxLocked.to_string());
        }
        Ok(data)
    }

    fn lock(&self) -> Result<(), String> {
        // Invalidate work before waiting for an atomic Core save's mutex.
        self.cancellation.fetch_add(1, Ordering::SeqCst);
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        data.session.lock();
        data.check_and_wipe(Instant::now());
        Ok(())
    }
    fn activity(&self, now: Instant) -> Result<bool, String> {
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        if !data.check_and_wipe(now) {
            return Ok(false);
        }
        Ok(data.session.activity(now))
    }

    fn expire(&self) -> Result<bool, String> {
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        let was_open = data
            .password_box
            .as_ref()
            .is_some_and(|pb| pb.state() == PasswordBoxState::Unlocked);
        Ok(!data.check_and_wipe(Instant::now()) && was_open)
    }

    fn begin_unlock(&self) -> Result<u64, String> {
        Ok(self
            .data
            .lock()
            .map_err(|_| "内部エラー")?
            .session
            .begin_unlock())
    }

    fn finish_unlock(&self, epoch: u64, mut pb: PasswordBox, path: PathBuf) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        if !data.session.unlock(epoch, Instant::now()) {
            pb.lock();
            return Err(PassShareError::BoxLocked.to_string());
        }
        data.password_box = Some(pb);
        data.box_path = Some(path);
        Ok(())
    }

    fn recover_and_save(
        &self,
        epoch: u64,
        ticket: u64,
        path: PathBuf,
        code: Zeroizing<String>,
        new_password: Zeroizing<String>,
        confirmation: Zeroizing<String>,
    ) -> Result<(), String> {
        if new_password.is_empty() {
            return Err(PassShareError::PasswordRequired.to_string());
        }
        if *new_password != *confirmation {
            return Err("recovery.passwordMismatch".into());
        }
        let cancellation = ticket;
        self.require_recovery_foreground()?;
        if self.cancellation.load(Ordering::SeqCst) != cancellation {
            return Err(PassShareError::BoxLocked.to_string());
        }
        let recovered = PasswordBox::recover(&path, &code).map_err(map_error)?;
        self.commit_recovery(epoch, cancellation, path, recovered, &new_password)
    }

    fn commit_recovery(
        &self,
        epoch: u64,
        cancellation: u64,
        path: PathBuf,
        mut recovered: PasswordBox,
        new_password: &str,
    ) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|_| "内部エラー")?;
        data.check_and_wipe(Instant::now());
        if data.session.epoch() != epoch || self.cancellation.load(Ordering::SeqCst) != cancellation
        {
            return Err(PassShareError::BoxLocked.to_string());
        }
        // Read-only recovery never becomes visible. Core publishes its rekey
        // only after its fingerprint check and atomic replacement succeed.
        recovered.rekey_recovered(new_password).map_err(map_error)?;
        data.check_and_wipe(Instant::now());
        if self.cancellation.load(Ordering::SeqCst) != cancellation
            || !data.session.unlock(epoch, Instant::now())
        {
            recovered.lock();
            return Err(PassShareError::BoxLocked.to_string());
        }
        data.password_box = Some(recovered);
        data.box_path = Some(path);
        Ok(())
    }

    fn enable_local_recovery(
        &self,
        epoch: u64,
        ticket: u64,
        password: Zeroizing<String>,
    ) -> Result<String, String> {
        let cancellation = ticket;
        self.require_recovery_foreground()?;
        let mut data = self.access()?;
        if data.session.epoch() != epoch || self.cancellation.load(Ordering::SeqCst) != cancellation
        {
            return Err(PassShareError::BoxLocked.to_string());
        }
        let pb = data
            .password_box
            .as_mut()
            .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
        let code = pb.enable_recovery(&password).map_err(map_error)?;
        if !data.check_and_wipe(Instant::now())
            || self.cancellation.load(Ordering::SeqCst) != cancellation
        {
            return Err(PassShareError::BoxLocked.to_string());
        }
        Ok(code.to_string())
    }

    fn require_recovery_foreground(&self) -> Result<(), String> {
        if !self.recovery_active.load(Ordering::SeqCst) || !self.foreground.load(Ordering::SeqCst) {
            return Err(PassShareError::BoxLocked.to_string());
        }
        Ok(())
    }

    fn recovery_background(&self) -> Result<(), String> {
        self.foreground.store(false, Ordering::SeqCst);
        if self.recovery_active.load(Ordering::SeqCst) {
            self.lock()?;
        }
        Ok(())
    }

    fn begin_recovery_session(&self) -> Result<LocalRecoverySession, String> {
        let ticket = self
            .cancellation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        self.recovery_session_ticket.store(ticket, Ordering::SeqCst);
        self.recovery_active.store(true, Ordering::SeqCst);
        if !self.foreground.load(Ordering::SeqCst) {
            self.recovery_active.store(false, Ordering::SeqCst);
            self.lock()?;
            return Err(PassShareError::BoxLocked.to_string());
        }
        Ok(LocalRecoverySession {
            epoch: self.status()?.epoch,
            ticket,
        })
    }

    fn end_recovery_session(
        &self,
        ticket: Option<u64>,
        lock_on_cancel: bool,
    ) -> Result<bool, String> {
        if !self.recovery_active.load(Ordering::SeqCst)
            || ticket != Some(self.recovery_session_ticket.load(Ordering::SeqCst))
        {
            return Ok(false);
        }
        self.recovery_active.store(false, Ordering::SeqCst);
        self.cancellation.fetch_add(1, Ordering::SeqCst);
        if lock_on_cancel {
            self.lock()?;
        }
        Ok(lock_on_cancel)
    }
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

struct ItemFields {
    title: String,
    password: Option<String>,
    url: Option<String>,
    username: Option<String>,
    notes: Option<String>,
    body: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
}

fn build_item_from_fields(
    id: ConnectId,
    vault_id: ConnectId,
    category: ItemCategory,
    fields: ItemFields,
) -> Result<Item, PassShareError> {
    let ItemFields {
        title,
        password,
        url,
        username,
        notes,
        body,
        tags,
        favorite,
    } = fields;
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
    let Ok(pb) = state.access() else {
        return Ok("locked".into());
    };
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
    let master_password = Zeroizing::new(master_password);
    let epoch = state.begin_unlock()?;
    let path = PathBuf::from(path);
    let pb = PasswordBox::create(&path, &master_password).map_err(map_error)?;
    let recovery = pb
        .recovery_secret()
        .map_err(map_error)?
        .map(|code| Zeroizing::new(code.to_string()));
    state.finish_unlock(epoch, pb, path)?;
    Ok(recovery.map(|code| code.to_string()))
}

#[tauri::command]
fn open_password_box(
    path: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let master_password = Zeroizing::new(master_password);
    let epoch = state.begin_unlock()?;
    let path = PathBuf::from(path);
    let pb = PasswordBox::open(&path, &master_password).map_err(map_error)?;
    state.finish_unlock(epoch, pb, path)?;
    Ok(())
}

#[tauri::command]
async fn recover_password_box(
    path: String,
    code: String,
    new_password: String,
    confirmation: String,
    epoch: u64,
    ticket: u64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let code = Zeroizing::new(code);
    let new_password = Zeroizing::new(new_password);
    let confirmation = Zeroizing::new(confirmation);
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().recover_and_save(
            epoch,
            ticket,
            PathBuf::from(path),
            code,
            new_password,
            confirmation,
        )
    })
    .await
    .map_err(|_| "内部エラー".to_string())?
}

#[tauri::command]
async fn enable_password_box_recovery(
    current_password: String,
    epoch: u64,
    ticket: u64,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let password = Zeroizing::new(current_password);
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .enable_local_recovery(epoch, ticket, password)
    })
    .await
    .map_err(|_| "内部エラー".to_string())?
}

#[derive(Serialize)]
struct LocalRecoveryInfo {
    name: String,
    path: String,
    epoch: u64,
}

#[tauri::command]
fn local_recovery_info(state: State<'_, AppState>) -> Result<LocalRecoveryInfo, String> {
    let data = state.access()?;
    let pb = data
        .password_box
        .as_ref()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    Ok(LocalRecoveryInfo {
        name: pb.vault().map_err(map_error)?.name.clone(),
        path: data
            .box_path
            .as_ref()
            .ok_or("内部エラー")?
            .to_string_lossy()
            .into_owned(),
        epoch: data.session.epoch(),
    })
}

#[derive(Serialize)]
struct LocalRecoverySession {
    epoch: u64,
    ticket: u64,
}

#[tauri::command]
fn local_recovery_session(
    active: bool,
    ticket: Option<u64>,
    lock_on_cancel: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<LocalRecoverySession, String> {
    if active {
        return state.begin_recovery_session();
    }
    if state.end_recovery_session(ticket, lock_on_cancel)? {
        if let Ok(status) = state.status() {
            let _ = app.emit("passshare-locked", status);
        }
    }
    Ok(LocalRecoverySession {
        epoch: state.status()?.epoch,
        ticket: state.cancellation.load(Ordering::SeqCst),
    })
}

#[derive(Serialize)]
struct BoxDirectory {
    directory: String,
    parent: Option<String>,
    entries: Vec<BoxDirectoryEntry>,
}
#[derive(Serialize)]
struct BoxDirectoryEntry {
    name: String,
    path: String,
    directory: bool,
}

#[tauri::command]
fn browse_password_box_directory(directory: Option<String>) -> Result<BoxDirectory, String> {
    let directory = match directory {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().map_err(|_| "recovery.browseFailed")?,
    }
    .canonicalize()
    .map_err(|_| "recovery.browseFailed")?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|_| "recovery.browseFailed")? {
        let entry = entry.map_err(|_| "recovery.browseFailed")?;
        let kind = entry.file_type().map_err(|_| "recovery.browseFailed")?;
        let path = entry.path();
        if kind.is_dir()
            || (kind.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pbox")))
        {
            entries.push(BoxDirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                directory: kind.is_dir(),
            });
        }
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(BoxDirectory {
        directory: directory.to_string_lossy().into_owned(),
        parent: directory
            .parent()
            .map(|path| path.to_string_lossy().into_owned()),
        entries,
    })
}

#[tauri::command]
fn list_items(state: State<'_, AppState>) -> Result<Vec<ItemDto>, String> {
    let pb = state.access()?;
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
    let pb = state.access()?;
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
#[allow(
    clippy::too_many_arguments,
    reason = "Preserve the existing flat named Tauri IPC payload"
)]
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
    let mut guard = state.access()?;
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

    pb.apply_and_save(SavedChange::Add(&item), &master_password)
        .map_err(map_error)?;
    Ok(ItemDto::from(&item))
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Preserve the existing flat named Tauri IPC payload"
)]
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
    let mut guard = state.access()?;
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

    pb.apply_and_save(SavedChange::Update(&item), &master_password)
        .map_err(map_error)?;
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
            extensions: Default::default(),
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
    let mut guard = state.access()?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    pb.apply_and_save(SavedChange::Delete(&id), &master_password)
        .map_err(map_error)?;
    Ok(())
}

#[tauri::command]
fn import_onepassword_csv(
    csv_data: String,
    master_password: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut guard = state.access()?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let count = pb
        .apply_and_save(SavedChange::ImportCsv(&csv_data), &master_password)
        .map_err(map_error)?;
    Ok(count)
}

#[tauri::command]
fn export_onepassword_csv(state: State<'_, AppState>) -> Result<String, String> {
    let pb = state.access()?;
    let pb = pb
        .as_ref()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    pb.export_onepassword_csv().map_err(map_error)
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Preserve the existing flat named Tauri IPC payload"
)]
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
    let mut guard = state.access()?;
    let pb = guard
        .as_mut()
        .ok_or_else(|| PassShareError::BoxLocked.to_string())?;
    let vault_id = pb.vault().map_err(map_error)?.id.clone();
    let connect_id = ConnectId::from_str(&id).map_err(map_error)?;
    let parsed = parse_category(&category).map_err(map_error)?;
    let item = build_item_from_fields(
        connect_id,
        vault_id,
        parsed,
        ItemFields {
            title,
            password,
            url,
            username,
            notes,
            body,
            tags,
            favorite,
        },
    )
    .map_err(map_error)?;

    pb.apply_and_save(SavedChange::Upsert(&item), &master_password)
        .map_err(map_error)?;
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
fn lock_password_box(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.lock()?;
    if let Ok(status) = state.status() {
        let _ = app.emit("passshare-locked", status);
    }
    Ok(())
}

#[tauri::command]
fn native_activity(state: State<'_, AppState>) -> Result<bool, String> {
    state.activity(Instant::now())
}

#[tauri::command]
fn native_is_unlocked(state: State<'_, AppState>) -> bool {
    state.access().is_ok()
}

#[tauri::command]
fn native_session_status(state: State<'_, AppState>) -> Result<NativeStatus, String> {
    state.status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            data: Mutex::new(BoxSession::default()),
            cancellation: AtomicU64::new(0),
            recovery_active: AtomicBool::new(false),
            recovery_session_ticket: AtomicU64::new(0),
            foreground: AtomicBool::new(true),
        })
        .on_window_event(|window, event| {
            let state = window.state::<AppState>();
            match event {
                tauri::WindowEvent::Focused(true) => state.foreground.store(true, Ordering::SeqCst),
                tauri::WindowEvent::Focused(false) => {
                    let _ = state.recovery_background();
                    if state.recovery_active.load(Ordering::SeqCst) {
                        if let Ok(status) = state.status() {
                            let _ = window.emit("passshare-locked", status);
                        }
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let state = handle.state::<AppState>();
                if state.expire().unwrap_or(false) {
                    if let Ok(status) = state.status() {
                        let _ = handle.emit("passshare-locked", status);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            create_password_box,
            open_password_box,
            recover_password_box,
            enable_password_box_recovery,
            local_recovery_info,
            local_recovery_session,
            browse_password_box_directory,
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
            native_activity,
            native_is_unlocked,
            native_session_status,
        ])
        .run(tauri::generate_context!())
        .expect("PassShare desktop failed to start");
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use passshare_core::domain::item::ItemCategory;
    use std::path::PathBuf;

    fn recovery_state() -> AppState {
        AppState {
            data: Mutex::new(BoxSession::default()),
            cancellation: AtomicU64::new(0),
            recovery_active: AtomicBool::new(true),
            recovery_session_ticket: AtomicU64::new(0),
            foreground: AtomicBool::new(true),
        }
    }

    // Synthetic v1 containing complete DTOs, future JSON, attachment and URL
    // reference metadata. Only public Core constructors and crypto are used.
    fn legacy_recovery_fixture(path: &std::path::Path, password: &str) -> serde_json::Value {
        use passshare_core::crypto::{
            derive_master_key, encrypt, KDF_MEMORY_KIB, KDF_PARALLELISM, KDF_TIME_COST,
        };
        use passshare_core::domain::payload::PasswordBoxPayload;
        use passshare_core::storage::file_format::{KdfParams, PasswordBoxFile, StoredCipher};
        let box_info = passshare_core::Vault::new("Synthetic recovery fixture").unwrap();
        let mut payload = PasswordBoxPayload::new(box_info, None);
        let mut item = Item::new_login(
            payload.vault.id.clone(),
            "Synthetic login",
            "synthetic-only",
        )
        .unwrap();
        item = item
            .with_optional_fields(
                Some("https://example.test/".into()),
                Some("synthetic-user".into()),
                Some("notes".into()),
            )
            .unwrap();
        item.tags = vec!["日本語".into(), "keep,comma".into()];
        item.favorite = true;
        item.last_edited_by = Some("synthetic-editor".into());
        item.urls.push(ItemUrl {
            href: "https://example.test/second".into(),
            label: "second".into(),
            primary: false,
            extensions: Default::default(),
        });
        payload.items.push(item);
        payload.sync_vault_item_count();
        let mut value = serde_json::to_value(payload).unwrap();
        value["items"][0]["urls"][0]["futureUrl"] = serde_json::json!({"keep": "synthetic-url"});
        value["items"][0]["fields"][0]["futureField"] = serde_json::json!("synthetic-field");
        value["items"][0]["files"] = serde_json::json!([{"id": "synthetic-file", "contentPath": "attachments/ref", "size": 42}]);
        value["items"][0]["vault"]["extraReference"] = serde_json::json!("synthetic-reference");
        value["futureRoot"] = serde_json::json!({"nested": ["synthetic-future"]});
        let salt = [1; 16];
        let key = derive_master_key(password, &salt).unwrap();
        let bytes = Zeroizing::new(serde_json::to_vec(&value).unwrap());
        let (ciphertext, nonce) = encrypt(&bytes, &key).unwrap();
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let nonce: String = nonce
            .chunks_exact(3)
            .flat_map(|chunk| {
                [
                    alphabet[(chunk[0] >> 2) as usize] as char,
                    alphabet[(((chunk[0] & 3) << 4) | (chunk[1] >> 4)) as usize] as char,
                    alphabet[(((chunk[1] & 15) << 2) | (chunk[2] >> 6)) as usize] as char,
                    alphabet[(chunk[2] & 63) as usize] as char,
                ]
            })
            .collect();
        PasswordBoxFile {
            version: 1,
            kdf: KdfParams {
                algorithm: "argon2id".into(),
                salt: "AQEBAQEBAQEBAQEBAQEBAQ==".into(),
                memory_kib: KDF_MEMORY_KIB,
                time_cost: KDF_TIME_COST,
                parallelism: KDF_PARALLELISM,
            },
            cipher: StoredCipher {
                algorithm: "xchacha20poly1305".into(),
                nonce,
            },
            ciphertext,
            recovery: None,
        }
        .save_to_path(path)
        .unwrap();
        value
    }

    fn full_recovery_payload(path: &std::path::Path, password: &str) -> serde_json::Value {
        use passshare_core::crypto::{decrypt, derive_master_key_with_params};
        use passshare_core::storage::file_format::PasswordBoxFile;
        let file = PasswordBoxFile::load_from_path(path).unwrap();
        let key = derive_master_key_with_params(
            password,
            &file.kdf.salt_bytes().unwrap(),
            file.kdf.memory_kib,
            file.kdf.time_cost,
            file.kdf.parallelism,
        )
        .unwrap();
        let bytes = Zeroizing::new(
            decrypt(&file.ciphertext, &key, &file.cipher.nonce_bytes().unwrap()).unwrap(),
        );
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn smoke_native_recovery_enable_lost_password_rekey_full_dto_roundtrip() {
        let (dir, path) = temp_box("native-recovery-roundtrip");
        let old_password = "synthetic-old-only";
        let new_password = "synthetic-new-only";
        let original = legacy_recovery_fixture(&path, old_password);
        let state = recovery_state();
        state
            .finish_unlock(
                0,
                PasswordBox::open(&path, old_password).unwrap(),
                path.clone(),
            )
            .unwrap();
        let epoch = state.status().unwrap().epoch;
        let code = Zeroizing::new(
            state
                .enable_local_recovery(epoch, 0, old_password.to_string().into())
                .unwrap(),
        );
        let before = serde_json::to_value(
            state
                .access()
                .unwrap()
                .as_ref()
                .unwrap()
                .list_connect_items()
                .unwrap(),
        )
        .unwrap();
        state.lock().unwrap();
        let epoch = state.begin_unlock().unwrap();
        let ticket = state.cancellation.load(Ordering::SeqCst);
        state
            .recover_and_save(
                epoch,
                ticket,
                path.clone(),
                code.clone(),
                new_password.to_string().into(),
                new_password.to_string().into(),
            )
            .unwrap();
        assert!(state.status().unwrap().unlocked);
        assert_eq!(state.status().unwrap().epoch, epoch + 1);
        let reopened = PasswordBox::open(&path, new_password).unwrap();
        assert_eq!(
            serde_json::to_value(reopened.list_connect_items().unwrap()).unwrap(),
            before
        );
        assert!(PasswordBox::open(&path, old_password).is_err());
        let mut after = full_recovery_payload(&path, new_password);
        after
            .as_object_mut()
            .unwrap()
            .remove("localKeyRecoveryVersion");
        after.as_object_mut().unwrap().remove("recoverySecret");
        assert_eq!(after, original);
        state.lock().unwrap();
        assert!(state.access().is_err());
        drop(reopened);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn smoke_native_recovery_invalid_inputs_preserve_original_and_current_state() {
        let (dir, path) = temp_box("native-recovery-invalid");
        legacy_recovery_fixture(&path, "synthetic-original-only");
        let state = recovery_state();
        state
            .finish_unlock(
                0,
                PasswordBox::open(&path, "synthetic-original-only").unwrap(),
                path.clone(),
            )
            .unwrap();
        let epoch = state.status().unwrap().epoch;
        let original = std::fs::read(&path).unwrap();
        let items = state
            .access()
            .unwrap()
            .as_ref()
            .unwrap()
            .list_connect_items()
            .unwrap();
        assert!(state
            .enable_local_recovery(epoch, 0, "synthetic-wrong-only".to_string().into())
            .is_err());
        assert!(state
            .recover_and_save(
                epoch,
                0,
                path.clone(),
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
                    .to_string()
                    .into(),
                "synthetic-new".to_string().into(),
                "synthetic-new".to_string().into()
            )
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original); // v1 not enabled
        let code = Zeroizing::new(
            state
                .enable_local_recovery(epoch, 0, "synthetic-original-only".to_string().into())
                .unwrap(),
        );
        let original = std::fs::read(&path).unwrap();
        for (test_code, password, confirmation) in [
            (
                "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
                "synthetic-new",
                "synthetic-new",
            ),
            ("invalid-code-format", "synthetic-new", "synthetic-new"),
            (code.as_str(), "synthetic-new", "synthetic-mismatch"),
            (code.as_str(), "", ""),
        ] {
            assert!(state
                .recover_and_save(
                    epoch,
                    0,
                    path.clone(),
                    test_code.to_string().into(),
                    password.to_string().into(),
                    confirmation.to_string().into()
                )
                .is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(state.status().unwrap().epoch, epoch);
            assert!(state.status().unwrap().unlocked);
            assert_eq!(
                state
                    .access()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .list_connect_items()
                    .unwrap(),
                items
            );
        }
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn smoke_native_recovery_stale_manual_background_and_cancel_never_publish() {
        let (dir, path) = temp_box("native-recovery-stale");
        let pb = PasswordBox::create(&path, "synthetic-old-only").unwrap();
        let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_string());
        let original = std::fs::read(&path).unwrap();
        drop(pb);
        for background in [false, true] {
            let state = recovery_state();
            let epoch = state.begin_unlock().unwrap();
            let recovered = PasswordBox::recover(&path, &code).unwrap();
            if background {
                state.recovery_background().unwrap();
            } else {
                state.lock().unwrap();
            }
            assert!(state
                .commit_recovery(epoch, 0, path.clone(), recovered, "synthetic-new-only")
                .is_err());
            assert!(state.access().is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        let state = recovery_state();
        // An old queued worker must not borrow a later form's cancellation ticket.
        state.cancellation.store(2, Ordering::SeqCst);
        assert!(state
            .recover_and_save(
                0,
                0,
                path.clone(),
                code,
                "synthetic-new-only".to_string().into(),
                "synthetic-new-only".to_string().into()
            )
            .is_err());
        assert!(state.access().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn smoke_native_recovery_save_failure_preserves_bytes_epoch_and_open_box() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, path) = temp_box("native-recovery-save-failure");
        let pb = PasswordBox::create(&path, "synthetic-old-only").unwrap();
        let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_string());
        let state = recovery_state();
        state.finish_unlock(0, pb, path.clone()).unwrap();
        let epoch = state.status().unwrap().epoch;
        let original = std::fs::read(&path).unwrap();
        // Keep reading allowed while denying atomic replacement of this fixture.
        let pin = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(state
            .recover_and_save(
                epoch,
                0,
                path.clone(),
                code,
                "synthetic-new-only".to_string().into(),
                "synthetic-new-only".to_string().into()
            )
            .is_err());
        assert!(state
            .enable_local_recovery(epoch, 0, "synthetic-old-only".to_string().into())
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(state.status().unwrap().epoch, epoch);
        assert!(state.status().unwrap().unlocked);
        assert!(state
            .access()
            .unwrap()
            .as_ref()
            .unwrap()
            .list_connect_items()
            .is_ok());
        drop(pin);
        assert!(PasswordBox::open(&path, "synthetic-old-only").is_ok());
        assert!(PasswordBox::open(&path, "synthetic-new-only").is_err());
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn smoke_native_enable_stale_source_preserves_current_app_and_external_file() {
        let (dir, path) = temp_box("native-enable-stale-source");
        legacy_recovery_fixture(&path, "synthetic-old-only");
        let state = recovery_state();
        state
            .finish_unlock(
                0,
                PasswordBox::open(&path, "synthetic-old-only").unwrap(),
                path.clone(),
            )
            .unwrap();
        let epoch = state.status().unwrap().epoch;
        let before = state
            .access()
            .unwrap()
            .as_ref()
            .unwrap()
            .list_connect_items()
            .unwrap();
        let mut external = PasswordBox::open(&path, "synthetic-old-only").unwrap();
        add_login(
            &mut external,
            "Synthetic external change",
            "synthetic-only",
            None,
            None,
            &[],
        );
        external.save("synthetic-old-only").unwrap();
        let current_bytes = std::fs::read(&path).unwrap();
        assert!(state
            .enable_local_recovery(epoch, 0, "synthetic-old-only".to_string().into())
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), current_bytes);
        assert_eq!(state.status().unwrap().epoch, epoch);
        assert_eq!(
            state
                .access()
                .unwrap()
                .as_ref()
                .unwrap()
                .list_connect_items()
                .unwrap(),
            before
        );
        drop(external);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn smoke_readonly_recovery_never_saves_and_lock_rejects_secret_reads() {
        let (dir, path) = temp_box("native-readonly-recovery");
        let pb = PasswordBox::create(&path, "synthetic-old-only").unwrap();
        let code = Zeroizing::new(pb.recovery_secret().unwrap().unwrap().to_string());
        let original = std::fs::read(&path).unwrap();
        let mut recovered = PasswordBox::recover(&path, &code).unwrap();
        assert!(recovered.list_connect_items().is_ok());
        assert!(recovered.save("synthetic-new-only").is_err());
        assert!(recovered
            .apply_and_save(
                SavedChange::ImportCsv("Title,Password\nsynthetic,synthetic-only"),
                "synthetic-new-only"
            )
            .is_err());
        recovered.lock();
        assert!(recovered.list_connect_items().is_err());
        assert!(recovered.recovery_secret().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        drop(recovered);
        drop(pb);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn smoke_native_recovery_old_form_cleanup_cannot_cancel_new_form() {
        let state = recovery_state();
        let old = state.begin_recovery_session().unwrap();
        let current = state.begin_recovery_session().unwrap();
        assert!(!state.end_recovery_session(Some(old.ticket), true).unwrap());
        assert!(state.recovery_active.load(Ordering::SeqCst));
        assert_eq!(state.cancellation.load(Ordering::SeqCst), current.ticket);
        assert_eq!(state.status().unwrap().epoch, current.epoch);
        assert!(state
            .end_recovery_session(Some(current.ticket), true)
            .unwrap());
        assert!(!state.recovery_active.load(Ordering::SeqCst));
        assert!(state.status().unwrap().epoch > current.epoch);
        state.foreground.store(false, Ordering::SeqCst);
        assert!(state.begin_recovery_session().is_err());
        assert!(!state.recovery_active.load(Ordering::SeqCst));
    }

    #[test]
    fn smoke_native_enable_saved_code_can_be_reobtained_after_background() {
        let (dir, path) = temp_box("native-enable-code-retry");
        legacy_recovery_fixture(&path, "synthetic-old-only");
        let state = recovery_state();
        state
            .finish_unlock(
                0,
                PasswordBox::open(&path, "synthetic-old-only").unwrap(),
                path.clone(),
            )
            .unwrap();
        let first = state.begin_recovery_session().unwrap();
        let code = Zeroizing::new(
            state
                .enable_local_recovery(
                    first.epoch,
                    first.ticket,
                    "synthetic-old-only".to_string().into(),
                )
                .unwrap(),
        );
        // The save completed, but the first code never reaches a visible UI.
        state.recovery_background().unwrap();
        assert!(state.access().is_err());
        assert!(!state
            .end_recovery_session(Some(first.ticket), false)
            .unwrap());
        state.foreground.store(true, Ordering::SeqCst);
        state
            .finish_unlock(
                state.begin_unlock().unwrap(),
                PasswordBox::open(&path, "synthetic-old-only").unwrap(),
                path.clone(),
            )
            .unwrap();
        let retry = state.begin_recovery_session().unwrap();
        let same_code = Zeroizing::new(
            state
                .enable_local_recovery(
                    retry.epoch,
                    retry.ticket,
                    "synthetic-old-only".to_string().into(),
                )
                .unwrap(),
        );
        assert_eq!(*same_code, *code);
        assert!(PasswordBox::recover(&path, &same_code).is_ok());
        state
            .end_recovery_session(Some(retry.ticket), false)
            .unwrap();
        assert!(state.status().unwrap().unlocked);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn fresh_master_password() -> String {
        PasswordBox::generate_password(PasswordGeneratorOptions {
            length: 32,
            ..Default::default()
        })
    }
    #[test]
    fn smoke_native_idle_input_erases_without_ui_poll() {
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("idle-input");
        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
        let item_password = fresh_master_password();
        add_login(&mut pb, "Idle fixture", &item_password, None, None, &[]);
        pb.save(&master_password).expect("save");
        let original = std::fs::read(&path).expect("ciphertext");
        let start = Instant::now();
        let mut session = NativeLock::default();
        assert!(session.unlock(session.begin_unlock(), start));
        let state = AppState {
            cancellation: AtomicU64::new(0),
            recovery_active: AtomicBool::new(false),
            recovery_session_ticket: AtomicU64::new(0),
            foreground: AtomicBool::new(true),
            data: Mutex::new(BoxSession {
                password_box: Some(pb),
                box_path: Some(path.clone()),
                session,
            }),
        };
        assert!(!state
            .activity(start + Duration::from_secs(300))
            .expect("activity"));
        {
            let data = state.data.lock().expect("state");
            let pb = data.password_box.as_ref().expect("box");
            assert_eq!(pb.state(), PasswordBoxState::Locked);
            assert!(pb.list_connect_items().is_err());
        }
        assert!(state.access().is_err());
        assert_eq!(
            std::fs::read(&path).expect("ciphertext after lock"),
            original
        );
        let reopened = PasswordBox::open(&path, &master_password).expect("reopen");
        assert_eq!(
            reopened.list_connect_items().expect("items")[0].title,
            "Idle fixture"
        );
        drop(reopened);
        drop(state);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn smoke_native_manual_lock_rejects_pending_open() {
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("pending-open");
        let pb = PasswordBox::create(&path, &master_password).expect("create");
        let state = AppState {
            cancellation: AtomicU64::new(0),
            recovery_active: AtomicBool::new(false),
            recovery_session_ticket: AtomicU64::new(0),
            foreground: AtomicBool::new(true),
            data: Mutex::new(BoxSession::default()),
        };
        let epoch = state.begin_unlock().expect("begin");
        state.lock().expect("manual lock");
        assert!(state.finish_unlock(epoch, pb, path.clone()).is_err());
        assert!(state.access().is_err());
        let reopened = PasswordBox::open(&path, &master_password).expect("reopen");
        state
            .finish_unlock(
                state.begin_unlock().expect("fresh begin"),
                reopened,
                path.clone(),
            )
            .expect("fresh open");
        assert!(state.access().is_ok());
        drop(state);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

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
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("smoke");

        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
        add_login(&mut pb, "Smoke Login", "secret", None, None, &[]);
        pb.save(&master_password).expect("save");

        let pb = PasswordBox::open(&path, &master_password).expect("open");
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
        let fixture_password = uuid::Uuid::new_v4().to_string();
        let mut original =
            Item::new_login(id, "Imported login", &fixture_password).expect("login item");
        original.fields.push(
            Field::new("Imported extra", FieldType::String, "keep field").expect("extra field"),
        );
        original.urls = vec![
            ItemUrl {
                extensions: Default::default(),
                label: "Secondary".into(),
                primary: false,
                href: "https://secondary.example/".into(),
            },
            ItemUrl {
                extensions: Default::default(),
                label: "Primary".into(),
                primary: true,
                href: "https://primary.example/".into(),
            },
            ItemUrl {
                extensions: Default::default(),
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
                extensions: Default::default(),
                label: String::new(),
                primary: true,
                href: "https://new.example/".into()
            }]
        );
    }

    #[test]
    fn smoke_edited_primary_url_and_untouched_data_survive_save_reopen() {
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("edit-primary-url");
        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
        let fixture_password = uuid::Uuid::new_v4().to_string();
        let mut original = Item::new_login(
            pb.vault().expect("box").id.clone(),
            "Imported login",
            &fixture_password,
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
                extensions: Default::default(),
                label: "Secondary".into(),
                primary: false,
                href: "https://secondary.example/".into(),
            },
            ItemUrl {
                extensions: Default::default(),
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
        pb.save(&master_password).expect("save");
        drop(pb);

        let pb = PasswordBox::open(&path, &master_password).expect("reopen");
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
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("search");

        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
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
        pb.save(&master_password).expect("save");

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
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("delete");

        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
        let keep = add_login(&mut pb, "Keep", "keep-pass", None, None, &[]);
        let remove = add_login(&mut pb, "Remove", "remove-pass", None, None, &[]);
        pb.save(&master_password).expect("save");

        pb.delete_item(&remove.id.to_string()).expect("delete");
        pb.save(&master_password).expect("save after delete");

        assert_eq!(
            pb.delete_item(&remove.id.to_string()),
            Err(PassShareError::ItemNotFound),
            "削除済み ID の再削除は ItemNotFound"
        );

        let pb = PasswordBox::open(&path, &master_password).expect("reopen");
        let items = pb.list_connect_items().expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, keep.id);

        let _ = std::fs::remove_dir_all(dir);
    }

    // MVP ATDD: 間違ったマスターパスワードではエラーが返り、中身は読めない
    #[test]
    fn smoke_open_with_wrong_master_password_fails() {
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("wrongpass");

        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
        add_login(&mut pb, "Secret Login", "top-secret", None, None, &[]);
        pb.save(&master_password).expect("save");

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
        let master_password = fresh_master_password();
        let (dir, path) = temp_box("recovery");

        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
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

        let pb = PasswordBox::open(&path, &master_password).expect("reopen");
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
        let master_password = fresh_master_password();
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

        let mut pb = PasswordBox::create(&path, &master_password).expect("create");
        let vault_id = pb.vault().expect("vault").id.clone();

        for name in categories {
            let category = parse_category(name).expect(name);
            let needs_password = matches!(category, ItemCategory::Login | ItemCategory::Password);
            let item = build_item_from_fields(
                ConnectId::generate().expect("id"),
                vault_id.clone(),
                category,
                ItemFields {
                    title: format!("{name} item"),
                    password: needs_password.then(|| format!("{name}-pass")),
                    url: None,
                    username: None,
                    notes: None,
                    body: (!needs_password).then(|| format!("{name} body")),
                    tags: Some(vec![name.to_ascii_lowercase()]),
                    favorite: Some(false),
                },
            )
            .expect(name);
            pb.add_item(item).expect(name);
        }
        pb.save(&master_password).expect("save");

        // Read: 全 category が API 文字列へ round-trip する
        let mut pb = PasswordBox::open(&path, &master_password).expect("reopen");
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
        pb.save(&master_password).expect("save update");

        let pb2 = PasswordBox::open(&path, &master_password).expect("reopen after update");
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
        pb.save(&master_password).expect("save deletes");
        assert!(pb.list_connect_items().expect("final list").is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }
}
