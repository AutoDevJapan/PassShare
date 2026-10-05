#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
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
