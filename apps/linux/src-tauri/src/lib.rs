// Оболочка приложения под Linux. Единственный наш файл: всё платформенное — здесь.
//
// Модули автора не скопированы, а подключены через #[path] из apps/windows/src-tauri/src —
// так его правки в них доезжают к нам сами. Расхождение заводится только здесь.
//
// proxy_auth не подключаем: модуль целиком WebView2, и все три его вызова стоят под
// #[cfg(windows)]. Путь отсчитывается от src/: src-tauri → linux → apps → windows.

use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[path = "../../../windows/src-tauri/src/auth.rs"]
mod auth;

#[path = "../../../windows/src-tauri/src/anilist.rs"]
mod anilist;

#[path = "../../../windows/src-tauri/src/files.rs"]
mod files;

#[path = "../../../windows/src-tauri/src/export.rs"]
mod export;

#[path = "../../../windows/src-tauri/src/storage.rs"]
mod storage;

#[path = "../../../windows/src-tauri/src/secrets.rs"]
mod secrets;

#[path = "../../../windows/src-tauri/src/updater.rs"]
mod updater;

#[path = "../../../windows/src-tauri/src/proxy.rs"]
mod proxy;

// Не StateFlags::all(): сохранённый VISIBLE даёт запуск без единого окна, а из FULLSCREEN
// в окне без меню нечем выйти.
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

#[tauri::command]
fn animori_reload(window: WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

#[tauri::command]
fn animori_restart(app: AppHandle) -> Result<(), String> {
    log::info!("Перезапуск приложения по просьбе окна");
    app.restart()
}

#[tauri::command]
fn animori_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
fn animori_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(format!("Схема адреса не разрешена: {trimmed}"));
    }

    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| e.to_string())
}

// Обе команды остаются на всех платформах: список команд один, а разные подписи сломали бы
// generate_handler! под cfg. Под Linux обе отвечают отказом — интерфейс их не показывает.

#[tauri::command]
fn animori_cast_panel(_app: AppHandle) -> Result<(), String> {
    Err("Панель трансляции экрана есть только в Windows".to_string())
}

#[tauri::command]
fn animori_devtools(_window: WebviewWindow) -> Result<(), String> {
    Err("Консоль разработчика пока не реализована для Linux".to_string())
}

pub fn run() {
    // Обход WebKit bug 324551: на NVIDIA EGL коммитит буфер без acquire point, и композитор
    // убивает клиента (Error 71). Лечится отключением explicit sync в драйвере, переменная
    // no-op на mesa. До создания окна: EGL поднимается вместе с WebView.
    std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");

    // GTK3 на Wayland-сессии без этого уходит в XWayland. X11-сессии не трогаем.
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "wayland");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(anilist::AniListClientState::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        // opener нужен только со стороны Rust: выданное окну opener:allow-open-url открыло бы
        // что угодно любому коду в нём.
        .plugin(tauri_plugin_opener::init())
        // window_state регистрируется в Builder, а не в setup(): плагины оттуда поднимаются
        // ДО setup, а окно создаётся внутри него.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Список команд дублируется в build.rs и в capabilities: разрешено ровно то, что там.
        .invoke_handler(tauri::generate_handler![
            animori_reload,
            animori_restart,
            animori_toggle_fullscreen,
            animori_open_external,
            animori_cast_panel,
            animori_devtools,
            auth::animori_auth_start,
            auth::animori_auth_submit,
            auth::animori_auth_status,
            auth::animori_auth_logout,
            anilist::animori_anilist_query,
            files::animori_file_read,
            files::animori_file_write,
            export::animori_export_pick_dir,
            export::animori_export_write,
            export::animori_track_pick_dir,
            export::animori_track_write,
            storage::animori_storage_read,
            storage::animori_storage_write,
            proxy::animori_proxy_status,
            proxy::animori_proxy_probe
        ])
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .rotation_strategy(RotationStrategy::KeepOne)
                    .timezone_strategy(TimezoneStrategy::UseLocal)
                    .max_file_size(2_000_000)
                    .targets([Target::new(TargetKind::LogDir { file_name: None })])
                    .build(),
            )?;

            // Прокси строго до первого окна: движок читает аргументы один раз.
            proxy::apply_to_webview(app.handle());

            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::default())
                .title("AniMori")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 600.0)
                .resizable(true)
                .center()
                .devtools(false)
                .build()?;

            // Фоновой задачей: запрос здесь задержал бы окно на ответ GitHub.
            updater::spawn_check(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}