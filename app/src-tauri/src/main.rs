#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

#[derive(Default)]
struct Engine(Mutex<Option<Child>>);

/// Project folder holding pyproject.toml; defaults to the repo this app was built from.
fn default_dir() -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

fn kill_group(child: &mut Child) {
    let pgid = child.id();
    let _ = Command::new("kill").args(["-TERM", &format!("-{pgid}")]).status();
    let _ = child.wait();
}

#[tauri::command]
fn project_dir() -> String {
    default_dir()
}

/// Start the Python engine: `host` or `join <addr>`. Runs through a login shell so uv is on PATH.
#[tauri::command]
fn start_engine(state: State<Engine>, dir: String, mode: String, addr: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap();
    if let Some(mut old) = slot.take() {
        kill_group(&mut old);
    }
    let args = match (mode.as_str(), addr) {
        ("host", _) => "host --no-open".to_string(),
        ("join", Some(a)) if !a.trim().is_empty() && !a.contains(|c: char| c.is_whitespace() || c == ';' || c == '&' || c == '|' || c == '$' || c == '`') => {
            format!("join {}", a.trim())
        }
        _ => return Err("invalid mode or address".into()),
    };
    let child = Command::new("/bin/zsh")
        .args(["-lc", &format!("exec uv run podtorrent {args}")])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("failed to start engine: {e}"))?;
    *slot = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_engine(state: State<Engine>) {
    if let Some(mut c) = state.0.lock().unwrap().take() {
        kill_group(&mut c);
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![project_dir, start_engine, stop_engine])
        .build(tauri::generate_context!())
        .expect("error building app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut c) = app.state::<Engine>().0.lock().unwrap().take() {
                    kill_group(&mut c);
                }
            }
        });
}
