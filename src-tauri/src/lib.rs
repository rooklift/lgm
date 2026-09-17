//! Native side of the Tauri build of LGM. This is a port of the Electron
//! main process (src/main.js): the menu, the file dialogs, reading and
//! writing map files, the persistent settings, and the dirty-close prompt.
//! The renderer talks to it through window.api, which src/api.js builds on
//! top of Tauri's invoke/listen when the app is not running under Electron.

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Mutex,
};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{
	menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
	AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/* Sanity ceiling for files we handle as maps; comfortably above the ~113 KB
 * a maximal legal map serializes to, but small enough to refuse a huge
 * unrelated file that ended up under a .map name. */
const MAX_MAP_BYTES: u64 = 1 << 20;

const MAP_EXTENSIONS: &[&str] = &["map", "rsrc"];

/* Menu checkboxes that mirror a settings key: (menu id, settings key, default). */
const TOGGLES: &[(&str, &str, bool)] = &[
	("toggle-legacy-phase", "detectLegacyPhase", true),
	("toggle-strict-symmetry-checks", "strict_symmetry_checks", false),
	("toggle-sprites", "showSprites", true),
	("toggle-pill-range", "showPillRange", true),
	("toggle-base-circles", "basesAsCircles", true),
];

struct AppState {
	dirty: Mutex<bool>,
	settings: Mutex<Map<String, Value>>,
	settings_path: Option<PathBuf>,
	/* A map to open once the page is up: from the command line, or (macOS)
	 * from a file opened via the Finder before the window existed. */
	startup_map: Mutex<Option<PathBuf>>,
	/* whether the page has asked for startup_map yet, i.e. is listening */
	page_ready: Mutex<bool>,
	toggles: Mutex<Vec<(String, CheckMenuItem<tauri::Wry>)>>,
}

impl AppState {
	fn setting_on(&self, key: &str, default: bool) -> bool {
		let settings = self.settings.lock().unwrap();
		match settings.get(key) {
			Some(Value::Bool(b)) => *b,
			_ => default,
		}
	}

	fn set_setting(&self, key: &str, value: Value) {
		self.settings.lock().unwrap().insert(key.to_owned(), value);
		self.save_settings();
	}

	fn last_open_dir(&self) -> Option<PathBuf> {
		let settings = self.settings.lock().unwrap();
		match settings.get("lastOpenDir") {
			Some(Value::String(s)) => Some(PathBuf::from(s)),
			_ => None,
		}
	}

	/* Persistent UI settings live in <config dir>/<identifier>/settings.json,
	 * the same shape as the Electron build's file. A missing or corrupt file
	 * just means defaults; a failed save is non-fatal. */
	fn save_settings(&self) {
		let Some(path) = &self.settings_path else { return };
		let settings = self.settings.lock().unwrap();
		let mut text = serde_json::to_string_pretty(&*settings).unwrap_or_else(|_| "{}".into());
		text.push('\n');
		if let Some(dir) = path.parent() {
			let _ = fs::create_dir_all(dir);
		}
		let _ = fs::write(path, text);
	}
}

fn load_settings(path: Option<&Path>) -> Map<String, Value> {
	let Some(path) = path else { return Map::new() };
	match fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) {
		Some(Value::Object(m)) => m,
		_ => Map::new(),
	}
}

#[derive(Serialize)]
struct MapResult {
	canceled: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	error: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	path: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	data: Option<Vec<u8>>,
}

impl MapResult {
	fn canceled() -> Self {
		MapResult { canceled: true, error: None, path: None, data: None }
	}
	fn error(msg: impl Into<String>) -> Self {
		MapResult { canceled: true, error: Some(msg.into()), path: None, data: None }
	}
}

fn read_map_file(p: &Path) -> MapResult {
	let attempt = || -> Result<Vec<u8>, String> {
		let size = fs::metadata(p).map_err(|e| e.to_string())?.len();
		if size > MAX_MAP_BYTES {
			return Err(format!("{} is {} bytes, far larger than any Bolo map.", p.display(), size));
		}
		fs::read(p).map_err(|e| e.to_string())
	};
	match attempt() {
		Ok(data) => MapResult { canceled: false, error: None, path: Some(p.to_string_lossy().into_owned()), data: Some(data) },
		Err(e) => MapResult::error(e),
	}
}

/* ---------- commands ---------- */

#[tauri::command]
fn get_settings(state: State<AppState>) -> Value {
	Value::Object(state.settings.lock().unwrap().clone())
}

#[tauri::command]
fn set_dirty(state: State<AppState>, dirty: bool) {
	*state.dirty.lock().unwrap() = dirty;
}

/* The map given on the command line, handed over once the page asks for it. */
#[tauri::command]
fn startup_map(state: State<AppState>) -> Option<MapResult> {
	*state.page_ready.lock().unwrap() = true;
	let p = state.startup_map.lock().unwrap().take()?;
	Some(read_map_file(&p))
}

/* A file dropped onto the window arrives as a path, not a File object. */
#[tauri::command]
fn read_map(path: String) -> MapResult {
	read_map_file(Path::new(&path))
}

#[tauri::command]
async fn open_map(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> Result<MapResult, ()> {
	let mut dialog = app
		.dialog()
		.file()
		.set_parent(&window)
		.add_filter("Bolo maps", MAP_EXTENSIONS)
		.add_filter("All files", &["*"]);
	if let Some(dir) = state.last_open_dir() {
		dialog = dialog.set_directory(dir);
	}
	let Some(p) = dialog.blocking_pick_file().and_then(|f| f.into_path().ok()) else {
		return Ok(MapResult::canceled());
	};
	if let Some(dir) = p.parent() {
		state.set_setting("lastOpenDir", Value::String(dir.to_string_lossy().into_owned()));
	}
	Ok(read_map_file(&p))
}

/* Overwrite in place, so the destination keeps its file identity (icon
 * position, creation date, ACLs). The old content is copied to a backup
 * first, so a failed write still can't destroy it; the backup is removed
 * once the write lands. create_new refuses a name that already exists, so
 * a stray pre-existing backup is never clobbered — we just try another. */
fn write_map(p: &Path, data: &[u8]) -> Result<(), String> {
	let existing = match fs::metadata(p) {
		Ok(m) => Some(m),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
		Err(e) => return Err(e.to_string()),
	};
	let mut bak: Option<PathBuf> = None;
	if let Some(m) = existing {
		/* Anything wildly bigger than a map is not a map we wrote — the user
		 * may have dropped some other file onto this name — so refuse to
		 * touch it rather than back it up. */
		if m.len() > MAX_MAP_BYTES {
			return Err(format!("The copy of {} on disk is now {} bytes. Not overwriting it; use Save As.", p.display(), m.len()));
		}
		let pid = std::process::id();
		for i in 0..=32 {
			let name = if i == 0 { format!("{}.bak{}", p.display(), pid) } else { format!("{}.bak{}.{}", p.display(), pid, i) };
			let name = PathBuf::from(name);
			match fs::OpenOptions::new().write(true).create_new(true).open(&name) {
				Ok(_) => {
					fs::copy(p, &name).map_err(|e| e.to_string())?;
					bak = Some(name);
					break;
				}
				Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && i < 32 => continue,
				Err(e) => return Err(e.to_string()),
			}
		}
	}
	if let Err(err) = fs::write(p, data) {
		let Some(bak) = bak else { return Err(err.to_string()) }; /* nothing was at p, so nothing was lost */
		/* p may be truncated or partial: put the original back */
		if fs::copy(&bak, p).is_ok() && fs::remove_file(&bak).is_ok() {
			return Err(format!("{err} — the original file is unchanged."));
		}
		return Err(format!("{err} — the original content is preserved in {}", bak.display()));
	}
	/* The save itself succeeded past this point, whatever the cleanup does. */
	if let Some(bak) = bak {
		let _ = fs::remove_file(bak);
	}
	Ok(())
}

#[tauri::command]
async fn save_map(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, path: Option<String>, data: Vec<u8>) -> Result<MapResult, ()> {
	let p = match path {
		Some(p) => PathBuf::from(p),
		None => {
			let mut dialog = app
				.dialog()
				.file()
				.set_parent(&window)
				.add_filter("Bolo maps", MAP_EXTENSIONS)
				.add_filter("All files", &["*"])
				.set_file_name("untitled.map");
			if let Some(dir) = state.last_open_dir() {
				dialog = dialog.set_directory(dir);
			}
			let Some(p) = dialog.blocking_save_file().and_then(|f| f.into_path().ok()) else {
				return Ok(MapResult::canceled());
			};
			if let Some(dir) = p.parent() {
				state.set_setting("lastOpenDir", Value::String(dir.to_string_lossy().into_owned()));
			}
			p
		}
	};
	Ok(match write_map(&p, &data) {
		Ok(()) => MapResult { canceled: false, error: None, path: Some(p.to_string_lossy().into_owned()), data: None },
		Err(e) => MapResult::error(e),
	})
}

/* Native dialogs, never window.confirm()/alert(): see renderer.js. */
#[tauri::command]
async fn confirm_discard(app: AppHandle, window: WebviewWindow) -> Result<bool, ()> {
	Ok(app
		.dialog()
		.message("Discard unsaved changes?")
		.title("LGM")
		.kind(MessageDialogKind::Warning)
		.parent(&window)
		/* Cancel is the default button: a destructive action must not be
		 * the reflex default. */
		.buttons(MessageDialogButtons::OkCancelCustom("Discard".into(), "Cancel".into()))
		.blocking_show())
}

#[tauri::command]
fn show_error(app: AppHandle, title: String, message: String) {
	app.dialog().message(message).title(title).kind(MessageDialogKind::Error).show(|_| {});
}

/* destroy() skips the close-requested event, so the dirty check can't re-fire */
#[tauri::command]
fn close_confirmed(window: WebviewWindow) {
	let _ = window.destroy();
}

/* ---------- menu ---------- */

fn build_menu(app: &AppHandle, state: &AppState) -> tauri::Result<Menu<tauri::Wry>> {
	let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
	let sep = || PredefinedMenuItem::separator(app);
	let mut toggles = Vec::new();
	let mut check = |id: &str| -> tauri::Result<CheckMenuItem<tauri::Wry>> {
		let (_, key, default) = TOGGLES.iter().find(|t| t.0 == id).expect("known toggle");
		let text = match id {
			"toggle-legacy-phase" => "Auto-detect shifted legacy maps",
			"toggle-strict-symmetry-checks" => "Strict symmetry checks",
			"toggle-sprites" => "Terrain sprites when zoomed in",
			"toggle-pill-range" => "Show pillbox range",
			"toggle-base-circles" => "Draw bases as circles",
			_ => unreachable!(),
		};
		let item = CheckMenuItem::with_id(app, id, text, true, state.setting_on(key, *default), None::<&str>)?;
		toggles.push((id.to_owned(), item.clone()));
		Ok(item)
	};

	let file = Submenu::with_items(app, "&File", true, &[
		&item("new", "New", Some("CmdOrCtrl+N"))?,
		&item("open", "Open…", Some("CmdOrCtrl+O"))?,
		&sep()?,
		&check("toggle-legacy-phase")?,
		&check("toggle-strict-symmetry-checks")?,
		&sep()?,
		&item("save", "Save", Some("CmdOrCtrl+S"))?,
		&item("save-as", "Save as…", Some("CmdOrCtrl+Shift+S"))?,
		&sep()?,
		/* Not the predefined Quit: that exits the process directly, skipping
		 * the close-requested event and with it the unsaved-changes prompt.
		 * Closing the window instead goes through the same path as the X. */
		&item("quit", "Quit", Some("CmdOrCtrl+Q"))?,
	])?;
	let edit = Submenu::with_items(app, "&Edit", true, &[
		&item("undo", "Undo", Some("CmdOrCtrl+Z"))?,
		&item("redo", "Redo", Some("CmdOrCtrl+Y"))?,
	])?;
	let fixes = Submenu::with_items(app, "Fi&xes", true, &[
		&item("fix-base-order", "Fix base order", None)?,
		&item("fix-pill-order", "Fix pillbox order", None)?,
		&item("fix-start-order", "Fix spawn order", None)?,
		&sep()?,
		&item("reset-bases", "Reset bases", None)?,
		&sep()?,
		&item("reset-pills-fast", "Reset pillboxes (wait 50)", None)?,
		&item("reset-pills-slow", "Reset pillboxes (wait 100)", None)?,
		&sep()?,
		&item("apply-all-fixes-fast", "Apply all fixes above (wait 50)", None)?,
		&item("apply-all-fixes-slow", "Apply all fixes above (wait 100)", None)?,
		&sep()?,
		&item("fix-start-dirs", "Fix spawn directions", None)?,
		&item("buffer-sea", "Buffer the sea", None)?,
	])?;
	let queries = Submenu::with_items(app, "&Queries", true, &[
		&item("count-flaws", "Count symmetry flaws", None)?,
		&item("find-flaw", "Find a flaw (best symmetry)", None)?,
		&item("find-flaw-selected", "Find a flaw (selected symmetry)", None)?,
		&sep()?,
		&item("pill-speeds", "Pillbox speeds", None)?,
		&item("count-nonstandard", "Count non-standard objects", None)?,
		&sep()?,
		&item("count-trees", "Count trees", None)?,
		&item("count-mines", "Count mines", None)?,
	])?;
	let view = Submenu::with_items(app, "&View", true, &[
		&item("zoom-in", "Zoom in", Some("CmdOrCtrl+="))?,
		&item("zoom-out", "Zoom out", Some("CmdOrCtrl+-"))?,
		&item("zoom-fit", "Fit map", Some("CmdOrCtrl+0"))?,
		&sep()?,
		&check("toggle-sprites")?,
		&check("toggle-pill-range")?,
		&check("toggle-base-circles")?,
		&sep()?,
		&item("toggle-devtools", "Toggle dev tools", None)?,
	])?;

	*state.toggles.lock().unwrap() = toggles;

	/* macOS shows the first submenu as the application menu, so give it one. */
	#[cfg(target_os = "macos")]
	{
		let app_menu = Submenu::with_items(app, "LGM", true, &[
			&PredefinedMenuItem::about(app, None, None)?,
			&sep()?,
			&PredefinedMenuItem::hide(app, None)?,
			&PredefinedMenuItem::hide_others(app, None)?,
			&PredefinedMenuItem::show_all(app, None)?,
			&sep()?,
			&item("quit", "Quit LGM", Some("Cmd+Q"))?,
		])?;
		return Menu::with_items(app, &[&app_menu, &file, &edit, &fixes, &queries, &view]);
	}
	#[allow(unreachable_code)]
	Menu::with_items(app, &[&file, &edit, &fixes, &queries, &view])
}

fn on_menu(app: &AppHandle, id: &str) {
	let state = app.state::<AppState>();
	if id == "quit" {
		if let Some(w) = app.get_webview_window("main") {
			let _ = w.close();
		}
		return;
	}
	if id == "toggle-devtools" {
		if let Some(w) = app.get_webview_window("main") {
			if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
		}
		return;
	}
	if let Some((_, key, _)) = TOGGLES.iter().find(|t| t.0 == id) {
		/* the checkbox has already flipped itself; mirror it into settings */
		let checked = state
			.toggles
			.lock()
			.unwrap()
			.iter()
			.find(|(tid, _)| tid == id)
			.and_then(|(_, item)| item.is_checked().ok());
		if let Some(checked) = checked {
			state.set_setting(key, Value::Bool(checked));
		}
	}
	let _ = app.emit("menu-cmd", id);
}

/* A map file given on the command line (e.g. a file dropped onto the exe,
 * which arrives as an argument). Maps in the wild don't reliably have a
 * .map extension, so any existing regular file counts. */
fn find_cli_map() -> Option<PathBuf> {
	std::env::args_os()
		.skip(1)
		.map(PathBuf::from)
		.filter(|p| !p.to_string_lossy().starts_with('-'))
		.find(|p| p.is_file())
		.map(|p| fs::canonicalize(&p).unwrap_or(p))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.setup(|app| {
			let settings_path = app.path().app_config_dir().ok().map(|d| d.join("settings.json"));
			let state = AppState {
				dirty: Mutex::new(false),
				settings: Mutex::new(load_settings(settings_path.as_deref())),
				settings_path,
				startup_map: Mutex::new(find_cli_map()),
				page_ready: Mutex::new(false),
				toggles: Mutex::new(Vec::new()),
			};
			let menu = build_menu(app.handle(), &state)?;
			app.manage(state);
			app.set_menu(menu)?;
			app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
			Ok(())
		})
		.on_window_event(|window, event| {
			/* Closing a dirty window defers to the renderer, which asks with
			 * the same discard prompt used by New/Open, then requests a real
			 * close. */
			if let WindowEvent::CloseRequested { api, .. } = event {
				let dirty = *window.state::<AppState>().dirty.lock().unwrap();
				if dirty {
					api.prevent_close();
					let _ = window.emit("confirm-close", ());
				}
			}
		})
		.invoke_handler(tauri::generate_handler![
			get_settings,
			set_dirty,
			startup_map,
			read_map,
			open_map,
			save_map,
			confirm_discard,
			show_error,
			close_confirmed,
		])
		.build(tauri::generate_context!())
		.expect("error while building the application")
		.run(|_app, _event| {
			/* macOS delivers a file opened from the Finder as an event rather
			 * than an argument; before the page is listening it is queued
			 * for startup_map instead. */
			#[cfg(target_os = "macos")]
			if let tauri::RunEvent::Opened { urls } = _event {
				if let Some(p) = urls.iter().find_map(|u| u.to_file_path().ok()).filter(|p| p.is_file()) {
					let state = _app.state::<AppState>();
					if *state.page_ready.lock().unwrap() {
						let _ = _app.emit("open-file", p.to_string_lossy().into_owned());
					} else {
						*state.startup_map.lock().unwrap() = Some(p);
					}
				}
			}
		});
}
