use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const PROJECT_DIR_NAME: &str = ".project";
const DATABASE_FILE_NAME: &str = "project.sqlite3";
const PROJECT_SETTINGS_FILE_NAME: &str = "settings.json";
const SESSION_FILE_NAME: &str = "session.json";
const IGNORED_FILE_LIST_NAMES: [&str; 1] = [".DS_Store"];
const DOCUMENT_TYPES: [&str; 8] = [
    "Наказ",
    "Розпорядження",
    "Протокол",
    "Доповідна записка",
    "Лист",
    "Договір",
    "Угода",
    "Меморандум",
];
const DOCUMENT_ORGANISATIONS: [&str; 6] = ["ДСНС", "НУЦЗУ", "МВС", "МОН", "ООН", "Черкаська ОДА"];
const DOCUMENT_SPANS: [&str; 3] = ["Внутрішній", "Вихідний", "Вхідний"];
const DOCUMENT_STATUSES: [&str; 3] = ["на виконанні", "виконано", "опрацювати"];

#[derive(Default)]
struct ProjectState(Mutex<Option<PathBuf>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    relative_path: String,
    depth: usize,
    child_count: usize,
    doc_name: Option<String>,
    doc_type: Option<String>,
    doc_organisation: Option<String>,
    doc_span: Option<String>,
    doc_status: Option<String>,
    doc_number: Option<String>,
    doc_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InnerFile {
    name: String,
    relative_path: String,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AscodCard {
    dir: String,
    path: String,
    doc_name: String,
    doc_type: String,
    doc_organisation: String,
    doc_span: String,
    doc_number: String,
    doc_date: String,
    doc_deadline: Vec<String>,
    doc_comments: String,
    brief_desc: String,
    doc_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AscodCardInput {
    doc_name: String,
    doc_type: String,
    doc_organisation: String,
    doc_span: String,
    doc_number: String,
    doc_date: String,
    doc_deadline: Vec<String>,
    doc_comments: String,
    brief_desc: String,
    doc_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEvent {
    id: String,
    path: String,
    title: String,
    start: String,
    color: String,
    text_color: String,
    urgent: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AscodOptions {
    doc_types: Vec<String>,
    organisations: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    name: String,
    path: String,
    directories: Vec<DirectoryEntry>,
    database_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSettings<'a> {
    schema_version: u8,
    project_path: &'a str,
    updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSettings {
    project_path: String,
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn normalized_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_ignored_file_list_entry(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    IGNORED_FILE_LIST_NAMES.contains(&file_name)
}

fn visible_subdirectories(path: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(path).map_err(|error| {
        format!(
            "Не вдалося прочитати каталог {}: {error}",
            display_path(path)
        )
    })?;

    let mut directories = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let is_directory = entry.file_type().ok()?.is_dir();
            let is_project_data = entry.file_name() == PROJECT_DIR_NAME;
            (is_directory && !is_project_data).then(|| entry.path())
        })
        .collect::<Vec<_>>();

    directories.sort_by_cached_key(|path| {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
    });
    Ok(directories)
}

fn collect_directories(
    root: &Path,
    current: &Path,
    depth: usize,
    output: &mut Vec<DirectoryEntry>,
) -> Result<(), String> {
    let children = visible_subdirectories(current)?;

    for child in children {
        let name = child
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let child_count = visible_subdirectories(&child).map_or(0, |items| items.len());

        output.push(DirectoryEntry {
            name,
            relative_path: normalized_relative_path(root, &child),
            depth,
            child_count,
            doc_name: None,
            doc_type: None,
            doc_organisation: None,
            doc_span: None,
            doc_status: None,
            doc_number: None,
            doc_date: None,
        });

        // An unreadable nested folder remains visible in the table, but does not
        // prevent the rest of the project from loading.
        let _ = collect_directories(root, &child, depth + 1, output);
    }

    Ok(())
}

fn collect_files(root: &Path, current: &Path, output: &mut Vec<InnerFile>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| {
        format!(
            "Не вдалося прочитати каталог {}: {error}",
            display_path(current)
        )
    })?;

    for entry in entries.filter_map(Result::ok) {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(root, &path, output)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if is_ignored_file_list_entry(&path) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        output.push(InnerFile {
            name,
            relative_path: normalized_relative_path(root, &path),
            size: metadata.len(),
        });
    }

    Ok(())
}

fn resolve_project_folder(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let folder_name = single_directory_name(relative_path, "Шлях до теки")?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Не вдалося визначити шлях до проєкту: {error}"))?;
    let folder = canonical_root
        .join(folder_name)
        .canonicalize()
        .map_err(|error| format!("Не вдалося знайти теку: {error}"))?;
    if !folder.starts_with(&canonical_root) || !folder.is_dir() {
        return Err("Теку не знайдено або вона розташована поза проєктом.".to_string());
    }
    Ok(folder)
}

fn resolve_folder_file(
    root: &Path,
    relative_path: &str,
    file_path: &str,
) -> Result<PathBuf, String> {
    let folder = resolve_project_folder(root, relative_path)?;
    let requested_path = Path::new(file_path);
    if requested_path.is_absolute() {
        return Err("Шлях до файлу має бути відносним.".to_string());
    }

    let file = folder
        .join(requested_path)
        .canonicalize()
        .map_err(|error| format!("Не вдалося знайти файл: {error}"))?;
    if !file.starts_with(&folder) || !file.is_file() {
        return Err("Файл розташований поза вибраною текою або більше не існує.".to_string());
    }
    Ok(file)
}

fn initialize_database(
    database_path: &Path,
    project_path: &str,
    directories: &[DirectoryEntry],
) -> Result<(), String> {
    let mut connection = Connection::open(database_path)
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;

    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS project_meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS directory_snapshot (
               relative_path TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               depth INTEGER NOT NULL,
               child_count INTEGER NOT NULL,
               scanned_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS AscodCard (
               dir TEXT NOT NULL,
               path TEXT PRIMARY KEY,
               doc_name TEXT NOT NULL,
               doc_type TEXT NOT NULL,
               doc_organisation TEXT NOT NULL,
               doc_span TEXT NOT NULL,
               doc_number TEXT NOT NULL DEFAULT '',
               doc_date TEXT NOT NULL DEFAULT '',
               doc_deadline TEXT NOT NULL DEFAULT '[]',
               doc_comments TEXT NOT NULL DEFAULT '',
               brief_desc TEXT NOT NULL DEFAULT '',
               doc_status TEXT NOT NULL DEFAULT 'опрацювати'
             );
             CREATE TABLE IF NOT EXISTS AscodMetadataOption (
               kind TEXT NOT NULL,
               value TEXT NOT NULL,
               PRIMARY KEY (kind, value)
             );",
        )
        .map_err(|error| format!("Не вдалося підготувати структуру SQLite: {error}"))?;

    let ascod_columns = connection
        .prepare("PRAGMA table_info(AscodCard)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("Не вдалося перевірити структуру AscodCard: {error}"))?;
    if !ascod_columns.iter().any(|column| column == "brief_desc") {
        connection
            .execute(
                "ALTER TABLE AscodCard ADD COLUMN brief_desc TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("Не вдалося додати brief_desc до AscodCard: {error}"))?;
    }
    if !ascod_columns.iter().any(|column| column == "doc_status") {
        connection
            .execute(
                "ALTER TABLE AscodCard ADD COLUMN doc_status TEXT NOT NULL DEFAULT 'опрацювати'",
                [],
            )
            .map_err(|error| format!("Не вдалося додати doc_status до AscodCard: {error}"))?;
    }

    for value in DOCUMENT_TYPES {
        connection
            .execute(
                "INSERT OR IGNORE INTO AscodMetadataOption (kind, value) VALUES ('doc_type', ?1)",
                params![value],
            )
            .map_err(|error| format!("Не вдалося підготувати типи документів: {error}"))?;
    }
    for value in DOCUMENT_ORGANISATIONS {
        connection
            .execute(
                "INSERT OR IGNORE INTO AscodMetadataOption (kind, value)
                 VALUES ('doc_organisation', ?1)",
                params![value],
            )
            .map_err(|error| format!("Не вдалося підготувати організації: {error}"))?;
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Не вдалося почати транзакцію SQLite: {error}"))?;
    transaction
        .execute(
            "INSERT INTO project_meta (key, value) VALUES ('project_path', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![project_path],
        )
        .map_err(|error| format!("Не вдалося зберегти метадані проєкту: {error}"))?;
    transaction
        .execute("DELETE FROM directory_snapshot", [])
        .map_err(|error| format!("Не вдалося оновити знімок каталогів: {error}"))?;

    let scanned_at = now_unix_seconds();
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO directory_snapshot
                 (relative_path, name, depth, child_count, scanned_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|error| format!("Не вдалося підготувати запис SQLite: {error}"))?;

        for directory in directories {
            statement
                .execute(params![
                    directory.relative_path,
                    directory.name,
                    directory.depth,
                    directory.child_count,
                    scanned_at,
                ])
                .map_err(|error| format!("Не вдалося записати каталог у SQLite: {error}"))?;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("Не вдалося завершити транзакцію SQLite: {error}"))?;
    Ok(())
}

fn attach_ascod_metadata(
    database_path: &Path,
    directories: &mut [DirectoryEntry],
) -> Result<(), String> {
    let connection = Connection::open(database_path)
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT path, doc_name, doc_type, doc_organisation, doc_span, doc_status, doc_number, doc_date
             FROM AscodCard",
        )
        .map_err(|error| format!("Не вдалося підготувати читання AscodCard: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ),
            ))
        })
        .map_err(|error| format!("Не вдалося прочитати AscodCard: {error}"))?;
    let metadata = rows
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("Не вдалося зібрати метадані AscodCard: {error}"))?;

    for directory in directories {
        if let Some((
            doc_name,
            doc_type,
            doc_organisation,
            doc_span,
            doc_status,
            doc_number,
            doc_date,
        )) = metadata.get(&directory.relative_path)
        {
            directory.doc_name = Some(doc_name.clone());
            directory.doc_type = Some(doc_type.clone());
            directory.doc_organisation = Some(doc_organisation.clone());
            directory.doc_span = Some(doc_span.clone());
            directory.doc_status = Some(doc_status.clone());
            directory.doc_number = Some(doc_number.clone());
            directory.doc_date = Some(doc_date.clone());
        }
    }
    Ok(())
}

fn write_project_settings(project_dir: &Path, project_path: &str) -> Result<(), String> {
    let settings = ProjectSettings {
        schema_version: 1,
        project_path,
        updated_at: now_unix_seconds(),
    };
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Не вдалося сформувати налаштування проєкту: {error}"))?;
    fs::write(project_dir.join(PROJECT_SETTINGS_FILE_NAME), contents)
        .map_err(|error| format!("Не вдалося записати налаштування проєкту: {error}"))
}

fn load_project(root: &Path) -> Result<ProjectInfo, String> {
    if !root.exists() {
        return Err(format!("Каталог {} більше не існує.", display_path(root)));
    }
    if !root.is_dir() {
        return Err("Вибраний шлях не є каталогом.".to_string());
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Не вдалося визначити шлях до каталогу: {error}"))?;
    let project_dir = canonical_root.join(PROJECT_DIR_NAME);
    fs::create_dir_all(&project_dir)
        .map_err(|error| format!("Не вдалося створити .project: {error}"))?;

    let mut directories = Vec::new();
    collect_directories(&canonical_root, &canonical_root, 0, &mut directories)?;

    let project_path = display_path(&canonical_root);
    let database_path = project_dir.join(DATABASE_FILE_NAME);
    initialize_database(&database_path, &project_path, &directories)?;
    attach_ascod_metadata(&database_path, &mut directories)?;
    write_project_settings(&project_dir, &project_path)?;

    let name = canonical_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| project_path.clone());

    Ok(ProjectInfo {
        name,
        path: project_path,
        directories,
        database_path: display_path(&database_path),
    })
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Не вдалося визначити каталог налаштувань: {error}"))?;
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Не вдалося створити каталог налаштувань: {error}"))?;
    Ok(config_dir.join(SESSION_FILE_NAME))
}

fn save_session(app: &AppHandle, root: &Path) -> Result<(), String> {
    let settings = SessionSettings {
        project_path: display_path(root),
    };
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Не вдалося сформувати дані сесії: {error}"))?;
    fs::write(session_path(app)?, contents)
        .map_err(|error| format!("Не вдалося зберегти робочу сесію: {error}"))
}

fn read_session(app: &AppHandle) -> Option<PathBuf> {
    let contents = fs::read_to_string(session_path(app).ok()?).ok()?;
    let settings = serde_json::from_str::<SessionSettings>(&contents).ok()?;
    let root = PathBuf::from(settings.project_path);
    root.is_dir().then_some(root)
}

fn state_root(state: &State<'_, ProjectState>) -> Result<Option<PathBuf>, String> {
    state
        .0
        .lock()
        .map(|root| root.clone())
        .map_err(|_| "Не вдалося отримати стан поточного проєкту.".to_string())
}

fn set_state_root(state: &State<'_, ProjectState>, root: Option<PathBuf>) -> Result<(), String> {
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Не вдалося оновити стан поточного проєкту.".to_string())?;
    *current = root;
    Ok(())
}

#[tauri::command]
fn open_project(
    path: String,
    app: AppHandle,
    state: State<'_, ProjectState>,
) -> Result<ProjectInfo, String> {
    let project = load_project(Path::new(&path))?;
    let canonical_root = PathBuf::from(&project.path);
    save_session(&app, &canonical_root)?;
    set_state_root(&state, Some(canonical_root))?;
    Ok(project)
}

#[tauri::command]
fn get_current_project(
    app: AppHandle,
    state: State<'_, ProjectState>,
) -> Result<Option<ProjectInfo>, String> {
    let root = match state_root(&state)? {
        Some(root) => Some(root),
        None => read_session(&app),
    };

    let Some(root) = root else {
        return Ok(None);
    };

    match load_project(&root) {
        Ok(project) => {
            set_state_root(&state, Some(root))?;
            Ok(Some(project))
        }
        Err(_) => {
            set_state_root(&state, None)?;
            Ok(None)
        }
    }
}

#[tauri::command]
fn refresh_project(state: State<'_, ProjectState>) -> Result<ProjectInfo, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    load_project(&root)
}

#[tauri::command]
fn get_folder_files(
    relative_path: String,
    state: State<'_, ProjectState>,
) -> Result<Vec<InnerFile>, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let folder = resolve_project_folder(&root, &relative_path)?;

    let mut files = Vec::new();
    collect_files(&folder, &folder, &mut files)?;
    files.sort_by_cached_key(|file| file.relative_path.to_lowercase());
    Ok(files)
}

#[tauri::command]
fn open_folder_file(
    relative_path: String,
    file_path: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let file = resolve_folder_file(&root, &relative_path, &file_path)?;
    tauri_plugin_opener::open_path(file, None::<&str>)
        .map_err(|error| format!("Не вдалося відкрити файл системною програмою: {error}"))
}

#[tauri::command]
fn open_folder_in_finder(
    relative_path: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let folder = resolve_project_folder(&root, &relative_path)?;
    tauri_plugin_opener::open_path(folder, None::<&str>)
        .map_err(|error| format!("Не вдалося відкрити теку у Finder: {error}"))
}

#[tauri::command]
fn move_folder_file_to_trash(
    relative_path: String,
    file_path: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let file = resolve_folder_file(&root, &relative_path, &file_path)?;
    trash::delete(&file).map_err(|error| {
        format!(
            "Не вдалося перемістити файл {} до кошика: {error}",
            display_path(&file)
        )
    })
}

fn project_database_path(root: &Path) -> PathBuf {
    root.join(PROJECT_DIR_NAME).join(DATABASE_FILE_NAME)
}

fn read_metadata_options(connection: &Connection, kind: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT value FROM AscodMetadataOption WHERE kind = ?1 ORDER BY value")
        .map_err(|error| format!("Не вдалося підготувати список метаданих: {error}"))?;
    let values = statement
        .query_map(params![kind], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Не вдалося прочитати список метаданих: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Не вдалося зібрати список метаданих: {error}"))?;
    Ok(values)
}

fn validate_metadata_option(
    connection: &Connection,
    kind: &str,
    value: &str,
    field_name: &str,
) -> Result<(), String> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM AscodMetadataOption WHERE kind = ?1 AND value = ?2)",
            params![kind, value],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Не вдалося перевірити поле «{field_name}»: {error}"))?;
    if exists {
        Ok(())
    } else {
        Err(format!(
            "Поле «{field_name}» містить неприпустиме значення."
        ))
    }
}

#[tauri::command]
fn get_ascod_options(state: State<'_, ProjectState>) -> Result<AscodOptions, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let connection = Connection::open(project_database_path(&root))
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;
    Ok(AscodOptions {
        doc_types: read_metadata_options(&connection, "doc_type")?,
        organisations: read_metadata_options(&connection, "doc_organisation")?,
    })
}

#[tauri::command]
fn add_ascod_option(
    kind: String,
    value: String,
    state: State<'_, ProjectState>,
) -> Result<String, String> {
    if kind != "doc_type" && kind != "doc_organisation" {
        return Err("Непідтримуваний тип додаткового значення.".to_string());
    }
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err("Нове значення не може бути порожнім.".to_string());
    }
    if value.chars().count() > 120 {
        return Err("Нове значення не може бути довшим за 120 символів.".to_string());
    }

    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let connection = Connection::open(project_database_path(&root))
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO AscodMetadataOption (kind, value) VALUES (?1, ?2)",
            params![kind, value],
        )
        .map_err(|error| format!("Не вдалося зберегти додаткове значення: {error}"))?;
    Ok(value)
}

fn validate_choice(value: &str, choices: &[&str], field_name: &str) -> Result<(), String> {
    if choices.contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "Поле «{field_name}» містить неприпустиме значення."
        ))
    }
}

fn validate_date(value: &str, field_name: &str, allow_empty: bool) -> Result<(), String> {
    if value.is_empty() && allow_empty {
        return Ok(());
    }
    let bytes = value.as_bytes();
    let valid_format = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !valid_format {
        return Err(format!(
            "Поле «{field_name}» має містити дату у форматі РРРР-ММ-ДД."
        ));
    }

    let year = value[0..4].parse::<u32>().unwrap_or_default();
    let month = value[5..7].parse::<u32>().unwrap_or_default();
    let day = value[8..10].parse::<u32>().unwrap_or_default();
    let leap_year =
        year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100));
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days_in_month {
        return Err(format!("Поле «{field_name}» містить неіснуючу дату."));
    }
    Ok(())
}

#[tauri::command]
fn get_ascod_card(
    relative_path: String,
    state: State<'_, ProjectState>,
) -> Result<Option<AscodCard>, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let path = single_directory_name(&relative_path, "Шлях до теки")?;
    let connection = Connection::open(project_database_path(&root))
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;

    let row = connection
        .query_row(
            "SELECT dir, path, doc_name, doc_type, doc_organisation, doc_span,
                    doc_number, doc_date, doc_deadline, doc_comments, brief_desc, doc_status
             FROM AscodCard WHERE path = ?1",
            params![path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Не вдалося прочитати метадані документа: {error}"))?;

    let Some((
        dir,
        path,
        doc_name,
        doc_type,
        doc_organisation,
        doc_span,
        doc_number,
        doc_date,
        deadlines,
        doc_comments,
        brief_desc,
        doc_status,
    )) = row
    else {
        return Ok(None);
    };
    let doc_deadline = serde_json::from_str::<Vec<String>>(&deadlines)
        .map_err(|error| format!("Не вдалося прочитати строки документа: {error}"))?;

    Ok(Some(AscodCard {
        dir,
        path,
        doc_name,
        doc_type,
        doc_organisation,
        doc_span,
        doc_number,
        doc_date,
        doc_deadline,
        doc_comments,
        brief_desc,
        doc_status,
    }))
}

fn calendar_colors(organisation: &str) -> (&'static str, &'static str) {
    match organisation {
        "ДСНС" => ("#dc3545", "#ffffff"),
        "НУЦЗУ" => ("#198754", "#ffffff"),
        "МОН" => ("#ffc107", "#212529"),
        _ => ("#0d6efd", "#ffffff"),
    }
}

fn read_calendar_events(connection: &Connection) -> Result<Vec<CalendarEvent>, String> {
    let mut statement = connection
        .prepare(
            "SELECT path, brief_desc, doc_organisation, doc_status, doc_deadline
             FROM AscodCard
             WHERE doc_deadline <> '[]' AND doc_deadline <> ''",
        )
        .map_err(|error| format!("Не вдалося підготувати події календаря: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| format!("Не вдалося прочитати події календаря: {error}"))?;

    let mut events = Vec::new();
    for row in rows {
        let (path, title, organisation, status, deadlines) =
            row.map_err(|error| format!("Не вдалося зібрати подію календаря: {error}"))?;
        let deadlines = serde_json::from_str::<Vec<String>>(&deadlines)
            .map_err(|error| format!("Не вдалося прочитати строки документа «{path}»: {error}"))?;
        let (color, text_color) = calendar_colors(&organisation);

        for (index, deadline) in deadlines.into_iter().enumerate() {
            if validate_date(&deadline, "Строк виконання", false).is_err() {
                continue;
            }
            events.push(CalendarEvent {
                id: format!("{path}:{index}"),
                path: path.clone(),
                title: title.clone(),
                start: deadline,
                color: color.to_string(),
                text_color: text_color.to_string(),
                urgent: status == "на виконанні",
            });
        }
    }

    Ok(events)
}

#[tauri::command]
fn get_calendar_events(state: State<'_, ProjectState>) -> Result<Vec<CalendarEvent>, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let connection = Connection::open(project_database_path(&root))
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;
    read_calendar_events(&connection)
}

#[tauri::command]
fn save_ascod_card(
    relative_path: String,
    metadata: AscodCardInput,
    state: State<'_, ProjectState>,
) -> Result<AscodCard, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    let path = single_directory_name(&relative_path, "Шлях до теки")?;
    if !root.join(&path).is_dir() {
        return Err("Теку документа не знайдено.".to_string());
    }
    let connection = Connection::open(project_database_path(&root))
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;

    let doc_name = metadata.doc_name.trim().to_string();
    if doc_name.is_empty() {
        return Err("Назва документа не може бути порожньою.".to_string());
    }
    validate_metadata_option(&connection, "doc_type", &metadata.doc_type, "Тип документа")?;
    validate_metadata_option(
        &connection,
        "doc_organisation",
        &metadata.doc_organisation,
        "Організація",
    )?;
    validate_choice(&metadata.doc_span, &DOCUMENT_SPANS, "Напрям")?;
    validate_choice(&metadata.doc_status, &DOCUMENT_STATUSES, "Статус документа")?;

    let doc_date = metadata.doc_date.trim().to_string();
    validate_date(&doc_date, "Дата документа", true)?;
    if !doc_date.is_empty() && doc_date[0..4].parse::<u32>().unwrap_or_default() < 2019 {
        return Err("Рік дати документа не може бути раніше 2019.".to_string());
    }
    let doc_deadline = metadata
        .doc_deadline
        .into_iter()
        .map(|date| date.trim().to_string())
        .filter(|date| !date.is_empty())
        .collect::<Vec<_>>();
    for deadline in &doc_deadline {
        validate_date(deadline, "Строк виконання", false)?;
    }

    let card = AscodCard {
        dir: path.clone(),
        path: path.clone(),
        doc_name,
        doc_type: metadata.doc_type,
        doc_organisation: metadata.doc_organisation,
        doc_span: metadata.doc_span,
        doc_number: metadata.doc_number.trim().to_string(),
        doc_date,
        doc_deadline,
        doc_comments: metadata.doc_comments.trim().to_string(),
        brief_desc: metadata.brief_desc.trim().to_string(),
        doc_status: metadata.doc_status,
    };
    let deadlines = serde_json::to_string(&card.doc_deadline)
        .map_err(|error| format!("Не вдалося підготувати строки документа: {error}"))?;
    connection
        .execute(
            "INSERT INTO AscodCard
             (dir, path, doc_name, doc_type, doc_organisation, doc_span,
              doc_number, doc_date, doc_deadline, doc_comments, brief_desc, doc_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(path) DO UPDATE SET
               dir = excluded.dir,
               doc_name = excluded.doc_name,
               doc_type = excluded.doc_type,
               doc_organisation = excluded.doc_organisation,
               doc_span = excluded.doc_span,
               doc_number = excluded.doc_number,
               doc_date = excluded.doc_date,
               doc_deadline = excluded.doc_deadline,
               doc_comments = excluded.doc_comments,
               brief_desc = excluded.brief_desc,
               doc_status = excluded.doc_status",
            params![
                card.dir,
                card.path,
                card.doc_name,
                card.doc_type,
                card.doc_organisation,
                card.doc_span,
                card.doc_number,
                card.doc_date,
                deadlines,
                card.doc_comments,
                card.brief_desc,
                card.doc_status,
            ],
        )
        .map_err(|error| format!("Не вдалося зберегти метадані документа: {error}"))?;

    Ok(card)
}

fn single_directory_name(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} не може бути порожнім."));
    }

    let components = Path::new(trimmed).components().collect::<Vec<_>>();
    if components.len() != 1 || !matches!(components[0], std::path::Component::Normal(_)) {
        return Err(format!(
            "{field_name} має містити лише назву одного каталогу."
        ));
    }
    if trimmed == PROJECT_DIR_NAME {
        return Err("Назва .project зарезервована для даних застосунку.".to_string());
    }

    Ok(trimmed.to_string())
}

fn rename_directory_at_root(
    root: &Path,
    relative_path: &str,
    new_name: &str,
) -> Result<(), String> {
    let source_name = single_directory_name(relative_path, "Поточний шлях")?;
    let target_name = single_directory_name(new_name, "Нова назва")?;
    let source = root.join(&source_name);
    let target = root.join(&target_name);

    if !source.is_dir() {
        return Err("Каталог для перейменування не знайдено.".to_string());
    }
    if target.exists() {
        return Err(format!("Каталог «{target_name}» уже існує."));
    }

    fs::rename(&source, &target)
        .map_err(|error| format!("Операційна система не дозволила перейменування: {error}"))
}

#[tauri::command]
fn rename_directory(
    relative_path: String,
    new_name: String,
    state: State<'_, ProjectState>,
) -> Result<ProjectInfo, String> {
    let root =
        state_root(&state)?.ok_or_else(|| "Спочатку відкрийте робочий каталог.".to_string())?;
    rename_directory_at_root(&root, &relative_path, &new_name)?;
    let connection = Connection::open(project_database_path(&root))
        .map_err(|error| format!("Не вдалося відкрити SQLite: {error}"))?;
    connection
        .execute(
            "UPDATE AscodCard SET dir = ?1, path = ?1 WHERE path = ?2",
            params![new_name.trim(), relative_path.trim()],
        )
        .map_err(|error| format!("Не вдалося оновити шлях метаданих документа: {error}"))?;
    load_project(&root)
}

#[tauri::command]
fn close_project(app: AppHandle, state: State<'_, ProjectState>) -> Result<(), String> {
    set_state_root(&state, None)?;
    let path = session_path(&app)?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Не вдалося очистити робочу сесію: {error}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProjectState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            get_current_project,
            refresh_project,
            get_folder_files,
            open_folder_file,
            open_folder_in_finder,
            move_folder_file_to_trash,
            get_ascod_options,
            add_ascod_option,
            get_ascod_card,
            get_calendar_events,
            save_ascod_card,
            rename_directory,
            close_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running ASCOD Project Manager");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let unique = format!(
                "ascod-project-manager-test-{}-{}-{}",
                process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_initialization_creates_workspace_and_snapshot() {
        let root = TestDirectory::create();
        fs::create_dir_all(root.0.join("alpha").join("nested"))
            .expect("nested test directory should be created");
        fs::create_dir_all(root.0.join("beta")).expect("test directory should be created");

        let project = load_project(&root.0).expect("project should load");

        assert_eq!(project.directories.len(), 3);
        assert_eq!(project.directories[0].relative_path, "alpha");
        assert_eq!(project.directories[0].child_count, 1);
        assert_eq!(project.directories[1].relative_path, "alpha/nested");
        assert_eq!(project.directories[1].depth, 1);
        assert_eq!(project.directories[2].relative_path, "beta");

        let project_dir = root.0.join(PROJECT_DIR_NAME);
        assert!(project_dir.join(PROJECT_SETTINGS_FILE_NAME).is_file());
        assert!(project_dir.join(DATABASE_FILE_NAME).is_file());

        let connection = Connection::open(project_dir.join(DATABASE_FILE_NAME))
            .expect("test database should open");
        let snapshot_count: usize = connection
            .query_row("SELECT COUNT(*) FROM directory_snapshot", [], |row| {
                row.get(0)
            })
            .expect("snapshot row count should be readable");
        assert_eq!(snapshot_count, 3);

        let ascod_card_exists: usize = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'AscodCard'",
                [],
                |row| row.get(0),
            )
            .expect("AscodCard table should be readable");
        assert_eq!(ascod_card_exists, 1);

        let mut columns = connection
            .prepare("PRAGMA table_info(AscodCard)")
            .expect("AscodCard schema should be readable");
        let column_names = columns
            .query_map([], |row| row.get::<_, String>(1))
            .expect("AscodCard columns should be queryable")
            .collect::<Result<Vec<_>, _>>()
            .expect("AscodCard columns should be collected");
        assert_eq!(
            column_names,
            vec![
                "dir",
                "path",
                "doc_name",
                "doc_type",
                "doc_organisation",
                "doc_span",
                "doc_number",
                "doc_date",
                "doc_deadline",
                "doc_comments",
                "brief_desc",
                "doc_status",
            ]
        );

        let document_types = read_metadata_options(&connection, "doc_type")
            .expect("default document types should be readable");
        assert_eq!(document_types.len(), DOCUMENT_TYPES.len());
        connection
            .execute(
                "INSERT INTO AscodMetadataOption (kind, value) VALUES ('doc_type', ?1)",
                params!["Спеціальний документ"],
            )
            .expect("custom document type should be stored");
        assert!(read_metadata_options(&connection, "doc_type")
            .expect("document types with custom value should be readable")
            .contains(&"Спеціальний документ".to_string()));
    }

    #[test]
    fn project_metadata_directory_is_not_listed() {
        let root = TestDirectory::create();
        fs::create_dir_all(root.0.join(PROJECT_DIR_NAME).join("internal"))
            .expect("project metadata directory should be created");

        let project = load_project(&root.0).expect("project should load");

        assert!(project.directories.is_empty());
    }

    #[test]
    fn existing_ascod_card_table_is_migrated() {
        let root = TestDirectory::create();
        let project_dir = root.0.join(PROJECT_DIR_NAME);
        fs::create_dir_all(&project_dir).expect("project directory should be created");
        let database_path = project_dir.join(DATABASE_FILE_NAME);
        let connection = Connection::open(&database_path).expect("test database should open");
        connection
            .execute_batch(
                "CREATE TABLE AscodCard (
                   dir TEXT NOT NULL,
                   path TEXT PRIMARY KEY,
                   doc_name TEXT NOT NULL,
                   doc_type TEXT NOT NULL,
                   doc_organisation TEXT NOT NULL,
                   doc_span TEXT NOT NULL,
                   doc_number TEXT NOT NULL DEFAULT '',
                   doc_date TEXT NOT NULL DEFAULT '',
                   doc_deadline TEXT NOT NULL DEFAULT '[]',
                   doc_comments TEXT NOT NULL DEFAULT ''
                 );
                 INSERT INTO AscodCard
                   (dir, path, doc_name, doc_type, doc_organisation, doc_span)
                 VALUES
                   ('existing', 'existing', 'Документ', 'Наказ', 'ДСНС', 'Внутрішній');",
            )
            .expect("legacy AscodCard table should be created");
        drop(connection);

        initialize_database(&database_path, &display_path(&root.0), &[])
            .expect("database should be migrated");

        let connection = Connection::open(database_path).expect("migrated database should open");
        let migrated: (String, String) = connection
            .query_row(
                "SELECT brief_desc, doc_status FROM AscodCard WHERE path = 'existing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("new fields should exist on legacy records");
        assert_eq!(migrated, (String::new(), "опрацювати".to_string()));
    }

    #[test]
    fn calendar_events_use_deadlines_descriptions_statuses_and_organisation_colors() {
        let root = TestDirectory::create();
        let project = load_project(&root.0).expect("project should initialize");
        let connection = Connection::open(project.database_path).expect("database should open");
        let records = [
            ("fire", "Пожежна безпека", "ДСНС", "на виконанні"),
            ("university", "Навчання", "НУЦЗУ", "виконано"),
            ("ministry", "Звіт", "МОН", "опрацювати"),
            ("other", "Інша подія", "МВС", "виконано"),
        ];
        for (path, description, organisation, status) in records {
            connection
                .execute(
                    "INSERT INTO AscodCard
                     (dir, path, doc_name, doc_type, doc_organisation, doc_span,
                      doc_deadline, brief_desc, doc_status)
                     VALUES (?1, ?1, 'Документ', 'Наказ', ?2, 'Внутрішній',
                             '[\"2026-08-12\"]', ?3, ?4)",
                    params![path, organisation, description, status],
                )
                .expect("calendar metadata should be inserted");
        }

        let events = read_calendar_events(&connection).expect("calendar events should load");
        assert_eq!(events.len(), 4);
        let event = |title: &str| {
            events
                .iter()
                .find(|event| event.title == title)
                .expect("calendar event should exist")
        };
        assert_eq!(event("Пожежна безпека").color, "#dc3545");
        assert!(event("Пожежна безпека").urgent);
        assert_eq!(event("Навчання").color, "#198754");
        assert_eq!(event("Звіт").color, "#ffc107");
        assert_eq!(event("Звіт").text_color, "#212529");
        assert_eq!(event("Інша подія").color, "#0d6efd");
        assert!(!event("Інша подія").urgent);
    }

    #[test]
    fn first_level_directory_can_be_renamed() {
        let root = TestDirectory::create();
        fs::create_dir(root.0.join("before")).expect("source directory should be created");

        rename_directory_at_root(&root.0, "before", "after")
            .expect("first-level directory should be renamed");

        assert!(!root.0.join("before").exists());
        assert!(root.0.join("after").is_dir());
    }

    #[test]
    fn inner_files_are_collected_recursively() {
        let root = TestDirectory::create();
        let folder = root.0.join("documents");
        fs::create_dir_all(folder.join("nested")).expect("nested directory should be created");
        fs::write(folder.join("readme.txt"), "hello").expect("file should be created");
        fs::write(folder.join("nested").join("notes.md"), "notes")
            .expect("nested file should be created");

        let mut files = Vec::new();
        collect_files(&folder, &folder, &mut files).expect("files should be collected");
        files.sort_by_cached_key(|file| file.relative_path.to_lowercase());

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].relative_path, "nested/notes.md");
        assert_eq!(files[1].relative_path, "readme.txt");

        let resolved = resolve_folder_file(&root.0, "documents", "nested/notes.md")
            .expect("listed file should resolve safely");
        assert!(resolved.ends_with(Path::new("documents/nested/notes.md")));

        fs::write(root.0.join("outside.txt"), "outside").expect("outside file should be created");
        assert!(resolve_folder_file(&root.0, "documents", "../outside.txt").is_err());
    }

    #[test]
    fn project_folder_resolution_stays_inside_root() {
        let root = TestDirectory::create();
        fs::create_dir(root.0.join("documents")).expect("document folder should be created");

        let folder = resolve_project_folder(&root.0, "documents")
            .expect("first-level folder should resolve safely");
        assert!(folder.ends_with("documents"));

        assert!(resolve_project_folder(&root.0, "../outside").is_err());
        assert!(resolve_project_folder(&root.0, "documents/nested").is_err());
        assert!(resolve_project_folder(&root.0, PROJECT_DIR_NAME).is_err());
    }

    #[test]
    fn catalogue_directory_includes_ascod_card_metadata() {
        let root = TestDirectory::create();
        fs::create_dir(root.0.join("document-folder")).expect("document folder should be created");
        let project = load_project(&root.0).expect("project should initialize");
        let connection = Connection::open(project.database_path).expect("database should open");
        connection
            .execute(
                "INSERT INTO AscodCard
                 (dir, path, doc_name, doc_type, doc_organisation, doc_span,
                  doc_status, doc_number, doc_date, doc_deadline, doc_comments)
                 VALUES (?1, ?1, 'Документ', 'Наказ', 'ДСНС', 'Внутрішній',
                         'на виконанні', '42', '2026-08-11', '[]', '')",
                params!["document-folder"],
            )
            .expect("metadata should be inserted");
        drop(connection);

        let refreshed = load_project(&root.0).expect("project should refresh");
        let directory = refreshed
            .directories
            .iter()
            .find(|directory| directory.relative_path == "document-folder")
            .expect("document directory should exist");

        assert_eq!(directory.doc_type.as_deref(), Some("Наказ"));
        assert_eq!(directory.doc_organisation.as_deref(), Some("ДСНС"));
        assert_eq!(directory.doc_span.as_deref(), Some("Внутрішній"));
        assert_eq!(directory.doc_status.as_deref(), Some("на виконанні"));
        assert_eq!(directory.doc_number.as_deref(), Some("42"));
        assert_eq!(directory.doc_date.as_deref(), Some("2026-08-11"));
    }
}
