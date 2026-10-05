// Собственные команды требуют разрешения в ACL Tauri: без объявления здесь такого разрешения
// не существует. Список совпадает с apps/windows — команды те же.

const COMMANDS: &[&str] = &[
    "animori_reload",
    "animori_restart",
    "animori_toggle_fullscreen",
    "animori_open_external",
    "animori_cast_panel",
    "animori_devtools",
    "animori_auth_start",
    "animori_auth_submit",
    "animori_auth_status",
    "animori_auth_logout",
    "animori_anilist_query",
    "animori_file_read",
    "animori_file_write",
    "animori_export_pick_dir",
    "animori_export_write",
    "animori_track_pick_dir",
    "animori_track_write",
    "animori_storage_read",
    "animori_storage_write",
    "animori_proxy_status",
    "animori_proxy_probe",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}