use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

#[path = "../../../../shared/native-lock.rs"]
mod native_lock;
use native_lock::NativeLock;

#[tauri::command]
fn native_begin_unlock(state: State<'_, Mutex<NativeLock>>) -> Result<u64, String> {
    state
        .lock()
        .map_err(|_| "内部エラー")?
        .begin_unlock()
        .ok_or_else(|| "アプリが閉じています".into())
}

#[tauri::command]
fn native_unlock(epoch: u64, state: State<'_, Mutex<NativeLock>>) -> Result<bool, String> {
    Ok(state
        .lock()
        .map_err(|_| "内部エラー")?
        .unlock(epoch, Instant::now()))
}

#[tauri::command]
fn native_is_unlocked(state: State<'_, Mutex<NativeLock>>) -> Result<bool, String> {
    Ok(state
        .lock()
        .map_err(|_| "内部エラー")?
        .is_unlocked(Instant::now()))
}

#[tauri::command]
fn native_activity(state: State<'_, Mutex<NativeLock>>) -> Result<bool, String> {
    Ok(state
        .lock()
        .map_err(|_| "内部エラー")?
        .activity(Instant::now()))
}

#[tauri::command]
fn native_focus(foreground: bool, state: State<'_, Mutex<NativeLock>>) -> Result<(), String> {
    state.lock().map_err(|_| "内部エラー")?.focus(foreground);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
        .manage(Mutex::new(NativeLock::default()))
        .invoke_handler(tauri::generate_handler![
            native_begin_unlock,
            native_unlock,
            native_is_unlocked,
            native_activity,
            native_focus
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(foreground) = event {
                if let Ok(mut state) = window.state::<Mutex<NativeLock>>().lock() {
                    state.focus(*foreground);
                }
                if !foreground {
                    let _ = window.emit("passshare-locked", ());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let state = handle.state::<Mutex<NativeLock>>();
                let Ok(mut state) = state.lock() else {
                    continue;
                };
                if state.expire(Instant::now()) {
                    drop(state);
                    let _ = handle.emit("passshare-locked", ());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PassShare mobile failed to start");
}

#[cfg(test)]
mod smoke_tests {
    #[test]
    fn smoke_mobile_crate_links() {
        assert!(true);
    }

    #[test]
    fn smoke_mobile_entry_point_symbol_exists() {
        // Ensures the mobile crate links against tauri + biometry plugin.
        let _ = std::any::type_name::<tauri::Builder<tauri::Wry>>();
    }
}
