// Пункт 3.3: выгрузка списка файлом, который человек найдёт руками.
//
// Почему не files.rs. Там имя из списка трёх и приватный каталог приложения:
// команда сознательно не умеет писать куда попало. Склад снимка и выгрузка
// для человека — разные права, и сводить их в одну команду нельзя.
//
// Диалог выбора папки живёт здесь, в Rust, а не в разметке. Так уже решено
// в Cargo.toml про dialog и updater: разрешение окну выдать легко, отобрать
// обратно нельзя. Разметка получает ровно четыре умения — спросить папку
// у человека (двумя заголовками, см. ниже) и положить в уже выбранную папку
// текст выгрузки либо байты трека.
//
// Путь приходит из разметки: папка хранится в настройках (ключ set_export_dir),
// и это осознанный размен. Держать её на стороне Rust значило бы завести
// второй склад настроек ради одной строки. Отсюда строгие проверки ниже:
// имя — только имя, папка — только существующий полный путь.
//
// ТРЕК ТЕМЫ РЯДОМ С ВЫГРУЗКОЙ, НО СВОИМИ КОМАНДАМИ
//
// Музыка карточки (TuneBox) даёт скачать тему файлом, и подошло тут ровно
// две вещи: окно выбора папки и запись в чужую папку. Всё остальное разное.
// Выгрузка — текст в .xml, трек — байты в .ogg и родне, и складывать их
// в одну команду значило бы ослабить проверку расширения до «чего угодно»:
// именно она не даёт превратить запись в способ положить рядом с выгрузкой
// исполняемый файл. Поэтому у трека свои имена, свой список расширений
// и свой потолок размера — песня весит больше списка на десять тысяч записей.
//
// Папка трека в настройках НЕ остаётся: её спрашивают на каждое нажатие.
// Это не забытая возможность, а просьба — сохранённая папка означала бы,
// что второй трек молча уедет туда, куда уехал первый месяц назад.
//
// Байты приходят строкой base64: тело файла читает разметка через
// Bridge.http.requestBytes, а другого безпотерьного вида у канала IPC нет —
// то же решение, что у загрузки датасета названий.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Потолок записи в байтах. Тот же, что у files.rs: выгрузка списка на десять
/// тысяч записей весит около мегабайта, восемь закрывают живые случаи с запасом.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Потолок трека. Тема в ogg тянет от двух до десяти мегабайт, полная версия
/// песни — до сорока; шестьдесят четыре закрывают их все и по-прежнему ловят
/// случай, когда вместо песни приехало что-то не то.
const MAX_TRACK_BYTES: usize = 64 * 1024 * 1024;

/// Разрешённое окончание имени. Выгрузка у нас одна — список в XML, и проверка
/// расширения не даёт превратить команду в способ положить рядом что угодно.
const ALLOWED_SUFFIX: &str = ".xml";

/// Расширения трека. Список закрытый по той же причине, что и у выгрузки:
/// запись в чужую папку не должна уметь класть туда исполняемый файл.
/// AnimeThemes раздаёт ogg, остальные — на случай смены раздачи.
const ALLOWED_TRACK_SUFFIXES: [&str; 6] = [".ogg", ".oga", ".opus", ".mp3", ".m4a", ".webm"];

/// Проверяет, что пришло именно имя файла, а не путь.
///
/// Path::file_name отсекает всё, что похоже на путь, поэтому сравнение
/// с исходной строкой ловит разом и разделители, и «..», и имя диска.
fn check_shape(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 200 {
        return Err(format!("Имя файла не годится: {name}"));
    }

    if Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name) {
        return Err(format!("Имя файла не разрешено: {name}"));
    }

    Ok(())
}

/// Имя файла выгрузки: общая проверка вида плюс единственное расширение.
fn check_name(name: &str) -> Result<(), String> {
    if !name.to_ascii_lowercase().ends_with(ALLOWED_SUFFIX) {
        return Err(format!("Выгрузка бывает только {ALLOWED_SUFFIX}: {name}"));
    }

    check_shape(name)
}

/// Имя файла трека: общая проверка вида плюс расширение из закрытого списка.
fn check_track_name(name: &str) -> Result<(), String> {
    let lowered = name.to_ascii_lowercase();

    if !ALLOWED_TRACK_SUFFIXES
        .iter()
        .any(|suffix| lowered.ends_with(suffix))
    {
        return Err(format!("Такое расширение трека не разрешено: {name}"));
    }

    check_shape(name)
}

/// Проверяет папку. Только существующий полный путь, и никакого создания:
/// files.rs свой служебный каталог создаёт сам, а здесь папку выбирал человек.
/// Нет её — значит настройка устарела, и плодить каталоги молча нельзя.
fn check_dir(dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dir);

    if !path.is_absolute() {
        return Err(format!("Путь папки не полный: {dir}"));
    }

    if !path.is_dir() {
        return Err(format!("Папка не найдена: {dir}"));
    }

    Ok(path)
}

/// Спрашивает папку родным окном и отдаёт её полный путь. None — человек
/// закрыл окно выбора: отмена не ошибка и красной надписи нигде не заслуживает.
///
/// Диалог отвечает обратным вызовом, а не значением, поэтому ответ ждём
/// через обычный канал на отдельном потоке: blocking_pick_folder звать нельзя,
/// он запрещён на главном потоке, где живёт окно.
///
/// Родительское окно указано намеренно: без него окно выбора на Windows умеет
/// всплыть ЗА приложением, и человек решит, что кнопка не работает.
///
/// Заголовок параметром: окна выбора у выгрузки и у трека разные по смыслу,
/// и подпись «Куда сохранять выгрузки AniMori» над выбором папки для песни
/// была бы прямой ложью.
async fn ask_folder(
    app: AppHandle,
    window: WebviewWindow,
    title: &'static str,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .pick_folder(move |picked| {
            // Отправка не дойдёт, если ждущая сторона уже ушла: это не беда.
            let _ = tx.send(picked);
        });

    // Ожидание уводится с потока среды: обратный вызов придёт неизвестно когда,
    // а человек вправе смотреть на окно выбора сколько ему угодно.
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| format!("Выбор папки не завершился: {e}"))?;

    let Some(found) = picked else {
        return Ok(None);
    };

    let path = found
        .into_path()
        .map_err(|e| format!("Папку не разобрать: {e}"))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Папка под выгрузки списка: спрашивается один раз и живёт в настройках.
#[tauri::command]
pub async fn animori_export_pick_dir(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    ask_folder(app, window, "Куда сохранять выгрузки AniMori").await
}

/// Папка под трек: спрашивается на КАЖДОЕ скачивание и нигде не запоминается.
#[tauri::command]
pub async fn animori_track_pick_dir(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    ask_folder(app, window, "Куда сохранить трек").await
}

/// Пишет выгрузку в выбранную папку и возвращает полный путь: настройки
/// показывают его человеку, чтобы файл не приходилось искать по диску.
///
/// Сначала во временный соседний файл, потом переименованием — тем же приёмом,
/// что и снимок: гибель процесса на середине не оставит обрезанный список.
#[tauri::command]
pub async fn animori_export_write(
    dir: String,
    name: String,
    text: String,
) -> Result<String, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("Выгрузка слишком большая: {} байт", text.len()));
    }

    check_name(&name)?;

    tauri::async_runtime::spawn_blocking(move || {
        let path = check_dir(&dir)?.join(&name);
        let temp = path.with_extension("xml.tmp");

        fs::write(&temp, text.as_bytes()).map_err(|e| format!("Не записать файл: {e}"))?;
        fs::rename(&temp, &path).map_err(|e| format!("Не заменить файл: {e}"))?;

        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Запись выгрузки не завершилась: {e}"))?
}

/// Пишет трек в выбранную папку и возвращает полный путь: карточка показывает
/// его человеку, иначе от нажатия не остаётся никакого следа.
///
/// Имя параметра одно слово намеренно: Tauri переводит имена аргументов из
/// camelCase, и bytes_base64 против bytesBase64 — лишний повод для тихого
/// «invalid args». Раскодировка идёт на рабочем потоке вместе с записью:
/// сорок мегабайт base64 на потоке среды заметно подвесили бы окно.
///
/// Через временный файл, как и выгрузка. Расширение временного — .part,
/// потому что оборванная песня с настоящим расширением попадёт в фонотеку
/// человека и будет там молча не играть.
#[tauri::command]
pub async fn animori_track_write(
    dir: String,
    name: String,
    bytes: String,
) -> Result<String, String> {
    check_track_name(&name)?;

    tauri::async_runtime::spawn_blocking(move || {
        let body = BASE64
            .decode(bytes.as_bytes())
            .map_err(|e| format!("Тело трека не разобрать: {e}"))?;

        if body.len() > MAX_TRACK_BYTES {
            return Err(format!("Трек слишком большой: {} байт", body.len()));
        }

        if body.is_empty() {
            return Err("Тело трека пустое".to_string());
        }

        let path = check_dir(&dir)?.join(&name);
        let temp = path.with_extension("part");

        fs::write(&temp, &body).map_err(|e| format!("Не записать файл: {e}"))?;
        fs::rename(&temp, &path).map_err(|e| format!("Не заменить файл: {e}"))?;

        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Запись трека не завершилась: {e}"))?
}
