use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

#[path = "../../../../shared/mobile-lock.rs"]
mod mobile_lock;
#[path = "../../../../shared/native-lock.rs"]
mod native_lock;
use mobile_lock::MobileLock;

#[derive(Default)]
struct AppState {
    lock: Mutex<MobileLock>,
}

#[derive(Clone, Serialize)]
struct NativeStatus {
    epoch: u64,
    unlocked: bool,
}

#[derive(Serialize)]
struct AccountStatus {
    epoch: u64,
    unlocked: bool,
    changed: bool,
    accepted: bool,
}

impl AppState {
    fn with<T>(&self, f: impl FnOnce(&mut MobileLock) -> T) -> Result<T, String> {
        let mut lock = self.lock.lock().map_err(|_| "internal error")?;
        Ok(f(&mut lock))
    }

    fn status(&self, now: Instant) -> Result<NativeStatus, String> {
        self.with(|lock| {
            let unlocked = lock.is_unlocked(now);
            NativeStatus {
                epoch: lock.epoch(),
                unlocked,
            }
        })
    }
}

fn emit_locked(app: &tauri::AppHandle, state: &AppState) {
    if let Ok(status) = state.status(Instant::now()) {
        let _ = app.emit("passshare-locked", status);
    }
}

#[tauri::command]
fn native_begin_unlock(state: State<'_, AppState>) -> Result<u64, String> {
    state.with(|lock| lock.begin_unlock())
}

// Called only after PIN / biometric verification succeeded in the WebView.
// This does not attest the PIN natively; it only commits the unlock when no
// lock transition happened since `native_begin_unlock`.
#[tauri::command]
fn native_complete_unlock(epoch: u64, state: State<'_, AppState>) -> Result<NativeStatus, String> {
    let now = Instant::now();
    state.with(|lock| {
        let accepted = lock.unlock(epoch, now);
        NativeStatus {
            epoch: lock.epoch(),
            unlocked: accepted && lock.is_unlocked(now),
        }
    })
}

#[tauri::command]
fn native_activity(state: State<'_, AppState>) -> Result<bool, String> {
    state.with(|lock| lock.activity(Instant::now()))
}

#[tauri::command]
fn native_session_status(state: State<'_, AppState>) -> Result<NativeStatus, String> {
    state.status(Instant::now())
}

#[tauri::command]
fn native_background(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.with(|lock| lock.background())?;
    emit_locked(&app, &state);
    Ok(())
}

#[tauri::command]
fn native_foreground(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.with(|lock| lock.resume())?;
    emit_locked(&app, &state);
    Ok(())
}

#[tauri::command]
fn native_lock(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<NativeStatus, String> {
    state.with(|lock| lock.lock())?;
    emit_locked(&app, &state);
    state.status(Instant::now())
}

// The caller applies the returned status itself, so no event is emitted here.
#[tauri::command]
fn native_account(
    id: Option<String>,
    epoch: u64,
    state: State<'_, AppState>,
) -> Result<AccountStatus, String> {
    let now = Instant::now();
    state.with(|lock| {
        let before = lock.epoch();
        let accepted = lock.adopt_account(epoch, id.as_deref(), now);
        let unlocked = lock.is_unlocked(now);
        AccountStatus {
            epoch: lock.epoch(),
            unlocked,
            accepted,
            changed: accepted && lock.epoch() != before,
        }
    })
}

// Clearing the current account is an unconditional logout boundary. A later
// sign-in must start after this command and capture the new epoch.
#[tauri::command]
fn native_logout(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.with(|lock| {
        lock.logout();
    })?;
    emit_locked(&app, &state);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let state = handle.state::<AppState>();
                if state
                    .with(|lock| lock.expire(Instant::now()))
                    .unwrap_or(false)
                {
                    emit_locked(&handle, &state);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_begin_unlock,
            native_complete_unlock,
            native_activity,
            native_session_status,
            native_background,
            native_foreground,
            native_lock,
            native_account,
            native_logout,
        ])
        .build(tauri::generate_context!())
        .expect("PassShare mobile failed to start")
        .run(|app, event| {
            #[cfg(mobile)]
            if matches!(event, tauri::RunEvent::Resumed) {
                let state = app.state::<AppState>();
                let _ = state.with(|lock| lock.resume());
                emit_locked(app, &state);
            }
            #[cfg(not(mobile))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod smoke_tests {
    use super::*;

    #[test]
    fn smoke_mobile_entry_point_symbol_exists() {
        // Ensures the mobile crate links against tauri + biometry plugin.
        let _ = std::any::type_name::<tauri::Builder<tauri::Wry>>();
    }

    #[test]
    fn smoke_mobile_background_rejects_inflight_unlock_and_reports_epoch() {
        let state = AppState::default();
        let now = Instant::now();
        state.with(|l| l.set_account(Some("u"))).unwrap();
        let epoch = state.with(|l| l.begin_unlock()).unwrap();
        state.with(|l| l.background()).unwrap();
        assert!(!state.with(|l| l.unlock(epoch, now)).unwrap());
        let status = state.status(now).unwrap();
        assert!(!status.unlocked);
        assert!(status.epoch > epoch);
    }
}
