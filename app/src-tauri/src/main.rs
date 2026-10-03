#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State};

#[derive(Default)]
struct Engine(Mutex<Option<Child>>);

fn kill_group(child: &mut Child) {
    let pgid = child.id();
    let _ = Command::new("kill").args(["-TERM", &format!("-{pgid}")]).status();
    let _ = child.wait();
}

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".podtorrent")
}

/// Bundled backend (uv + Python sources) if present, else the repo this app was built from (dev).
fn backend_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let b = res.join("resources/backend");
        if b.join("uv").exists() {
            return b;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Start the Python engine: `host` or `join <addr>`. Output goes to ~/.podtorrent/engine.log.
#[tauri::command]
fn start_engine(app: AppHandle, state: State<Engine>, mode: String, addr: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap();
    if let Some(mut old) = slot.take() {
        kill_group(&mut old);
    }
    let args: Vec<String> = match (mode.as_str(), addr) {
        ("host", _) => vec!["host".into(), "--no-open".into()],
        ("join", Some(a)) if !a.trim().is_empty() && !a.contains(char::is_whitespace) && !a.starts_with('-') => {
            vec!["join".into(), a.trim().into()]
        }
        _ => return Err("invalid mode or address".into()),
    };
    let dir = backend_dir(&app);
    let data = data_dir();
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(data.join("engine.log")).map_err(|e| e.to_string())?;
    let uv = if dir.join("uv").exists() { dir.join("uv") } else { PathBuf::from("uv") };
    let mut cmd = Command::new(uv);
    cmd.args(["run", "--project"]).arg(&dir).args(["podtorrent"]).args(&args)
        .env("UV_PROJECT_ENVIRONMENT", data.join("venv"))
        .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()))
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .process_group(0);
    let child = cmd.spawn().map_err(|e| format!("failed to start engine: {e}"))?;
    *slot = Some(child);
    Ok(())
}

#[tauri::command]
fn engine_log() -> String {
    let t = std::fs::read_to_string(data_dir().join("engine.log")).unwrap_or_default();
    let lines: Vec<&str> = t.lines().collect();
    lines[lines.len().saturating_sub(3)..].join("\n")
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
        .invoke_handler(tauri::generate_handler![engine_log, start_engine, stop_engine])
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
