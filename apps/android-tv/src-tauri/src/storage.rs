// Настройки окна: прямого доступа к файлу у разметки нет, всё идёт этими двумя командами.

use std::collections::HashMap;

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// Тот же файл, что у auth.rs и proxy.rs: второе хранилище разошлось бы с первым.
const STORE_FILE: &str = "animori-settings.json";

/// Пропуск и срок его жизни: читает и пишет их только Rust.
const CLOSED_KEYS: &[&str] = &["auth_token", "auth_expires_at"];

/// Снимок файла настроек без закрытых ключей одним вызовом.
#[tauri::command]
pub fn animori_storage_read(app: AppHandle) -> Result<HashMap<String, serde_json::Value>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    Ok(store
        .entries()
        .into_iter()
        .filter(|(key, _)| !CLOSED_KEYS.contains(&key.as_str()))
        .collect())
}

/// Пишет значение и сразу выгружает файл на диск.
#[tauri::command]
pub fn animori_storage_write(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    if CLOSED_KEYS.contains(&key.as_str()) {
        return Err(format!("Ключ закрыт для окна: {key}"));
    }

    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(key, value);
    store.save().map_err(|e| e.to_string())
}
