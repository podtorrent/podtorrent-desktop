#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
struct Engine(Mutex<Option<Child>>);
/// Tray menu's status line, updated from the UI.
struct TrayStatus(MenuItem<Wry>);

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

/// Start this Mac's peer (`podtorrent peer`). Output goes to ~/.podtorrent/engine.log.
/// `mode` is "peer"; "host" is accepted from older UI builds. There is no address: peers find
/// each other through the rendezvous. `name` (from onboarding) is what other peers see.
#[tauri::command]
fn start_engine(app: AppHandle, state: State<Engine>, mode: String, name: Option<String>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap();
    if let Some(mut old) = slot.take() {
        kill_group(&mut old);
    }
    let args: Vec<String> = match mode.as_str() {
        "peer" | "host" => vec!["peer".into()],
        _ => return Err("invalid mode".into()),
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
    let name: String = name.unwrap_or_default().chars().filter(|c| !c.is_control()).take(40).collect();
    if !name.trim().is_empty() {
        cmd.env("PODTORRENT_NAME", name.trim());
    }
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

/// Read-only: the last `lines` lines of engine.log (or an older download.log), for the Activity view.
#[tauri::command]
fn engine_log_tail(name: Option<String>, lines: Option<usize>) -> Result<String, String> {
    let name = name.unwrap_or_else(|| "engine.log".into());
    if name != "engine.log" && name != "download.log" {
        return Err("unknown log".into());
    }
    let t = std::fs::read_to_string(data_dir().join(&name)).unwrap_or_default();
    let all: Vec<&str> = t.lines().collect();
    let n = lines.unwrap_or(500).min(5000);
    Ok(all[all.len().saturating_sub(n)..].join("\n"))
}

#[tauri::command]
fn engine_running(state: State<Engine>) -> bool {
    let mut slot = state.0.lock().unwrap();
    match slot.as_mut() {
        Some(c) => c.try_wait().ok().flatten().is_none(),
        None => false,
    }
}

#[tauri::command]
fn stop_engine(state: State<Engine>) {
    if let Some(mut c) = state.0.lock().unwrap().take() {
        kill_group(&mut c);
    }
}

/// Stop the engine, then quit. Called from the dashboard's Stop button.
#[tauri::command]
fn quit_app(app: AppHandle) {
    stop_children(&app);
    app.exit(0);
}

fn stop_children(app: &AppHandle) {
    if let Some(mut c) = app.state::<Engine>().0.lock().unwrap().take() {
        kill_group(&mut c);
    }
}

// ---- read-only system telemetry ----

fn sh(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

struct Static { chip: String, mem_bytes: u64, os: String }
fn statics() -> &'static Static {
    static S: OnceLock<Static> = OnceLock::new();
    S.get_or_init(|| Static {
        chip: sh("sysctl", &["-n", "machdep.cpu.brand_string"]),
        mem_bytes: sh("sysctl", &["-n", "hw.memsize"]).parse().unwrap_or(0),
        os: sh("sw_vers", &["-productVersion"]),
    })
}

/// Chip, memory, power source, thermal state and memory pressure. Used to show health
/// and to throttle the UI's own animation; never affects the engine.
#[tauri::command]
fn system_health() -> serde_json::Value {
    use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};
    let s = statics();
    let pi = NSProcessInfo::processInfo();
    let t = pi.thermalState();
    let thermal = if t == NSProcessInfoThermalState::Nominal { "nominal" }
        else if t == NSProcessInfoThermalState::Fair { "fair" }
        else if t == NSProcessInfoThermalState::Serious { "serious" }
        else if t == NSProcessInfoThermalState::Critical { "critical" }
        else { "unknown" };
    let batt = sh("pmset", &["-g", "batt"]);
    let power = if batt.contains("'AC Power'") { "ac" } else if batt.contains("'Battery Power'") { "battery" } else { "unknown" };
    let battery_pct: Option<u32> = batt.split('\t').nth(1)
        .and_then(|r| r.split('%').next()).and_then(|p| p.trim().parse().ok());
    let pressure = match sh("sysctl", &["-n", "kern.memorystatus_vm_pressure_level"]).as_str() {
        "1" => "normal", "2" => "warn", "4" => "critical", _ => "unknown",
    };
    serde_json::json!({
        "chip": s.chip, "mem_total_gb": s.mem_bytes as f64 / (1u64 << 30) as f64, "os": s.os,
        "thermal": thermal, "low_power": pi.isLowPowerModeEnabled(),
        "power": power, "battery_pct": battery_pct, "mem_pressure": pressure,
    })
}

// ---- tray ----

/// Menu-bar icon: a status dot (filled = contributing) and a throughput sparkline,
/// rendered as a template image so macOS tints it for light and dark menu bars.
fn tray_image(samples: &[f32], online: bool) -> Image<'static> {
    let (w, h) = (64u32, 36u32);
    let mut px = vec![0u8; (w * h * 4) as usize];
    let mut plot = |x: u32, y: u32, a: f32| {
        if x < w && y < h {
            let i = ((y * w + x) * 4) as usize;
            let v = (a.clamp(0.0, 1.0) * 255.0) as u8;
            px[i + 3] = px[i + 3].max(v);
        }
    };
    // dot
    let (cx, cy, r) = (8.0f32, 18.0f32, 6.0f32);
    for y in 0..h { for x in 0..20 {
        let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
        let a = if online { r + 0.5 - d } else { 1.0 - ((d - (r - 1.0)).abs() - 0.6) };
        plot(x, y, a);
    }}
    // sparkline
    let pts: Vec<f32> = samples.iter().rev().take(24).rev().cloned().collect();
    let max = pts.iter().cloned().fold(0.0f32, f32::max);
    let (x0, x1, y0, y1) = (20.0f32, 62.0f32, 31.0f32, 5.0f32);
    let n = pts.len().max(2);
    let coord = |i: usize, v: f32| {
        let x = x0 + (x1 - x0) * i as f32 / (n - 1) as f32;
        let y = if max > 0.0 { y0 + (y1 - y0) * (v / max) } else { y0 };
        (x, y)
    };
    let segs: Vec<((f32, f32), (f32, f32))> = if pts.len() >= 2 {
        (0..pts.len() - 1).map(|i| (coord(i, pts[i]), coord(i + 1, pts[i + 1]))).collect()
    } else {
        vec![((x0, y0), (x1, y0))]
    };
    for y in 0..h { for x in 20..w {
        let (qx, qy) = (x as f32 + 0.5, y as f32 + 0.5);
        let mut best = f32::MAX;
        for &((ax, ay), (bx, by)) in &segs {
            let (dx, dy) = (bx - ax, by - ay);
            let t = (((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy).max(1e-6)).clamp(0.0, 1.0);
            let d = ((qx - ax - t * dx).powi(2) + (qy - ay - t * dy).powi(2)).sqrt();
            best = best.min(d);
        }
        plot(x, y, 2.0 - best);
    }}
    Image::new_owned(px, w, h)
}

/// Update the menu-bar extra: throughput samples (tokens/s), online dot, status text.
#[tauri::command]
fn tray_update(app: AppHandle, samples: Vec<f32>, online: bool, status: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(tray_image(&samples, online))).map_err(|e| e.to_string())?;
        let _ = tray.set_icon_as_template(true);
        let _ = tray.set_tooltip(Some(format!("PodTorrent: {status}")));
    }
    if let Some(s) = app.try_state::<TrayStatus>() {
        let _ = s.0.set_text(status);
    }
    Ok(())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, acc: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, text);
        match acc { Some(a) => b.accelerator(a), None => b }.build(app)
    };
    let app_menu = SubmenuBuilder::new(app, "PodTorrent")
        .about(None)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide().hide_others().show_all()
        .separator()
        .item(&item("quit", "Quit PodTorrent", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("nav:swarm", "Swarm", Some("CmdOrCtrl+1"))?)
        .item(&item("nav:models", "Models", Some("CmdOrCtrl+2"))?)
        .item(&item("nav:playground", "Playground", Some("CmdOrCtrl+3"))?)
        .item(&item("nav:node", "My Node", Some("CmdOrCtrl+4"))?)
        .item(&item("nav:peers", "Peers", Some("CmdOrCtrl+5"))?)
        .item(&item("nav:activity", "Activity", Some("CmdOrCtrl+6"))?)
        .separator()
        .item(&item("palette", "Command Palette…", Some("CmdOrCtrl+K"))?)
        .item(&item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\"))?)
        .item(&item("inspector", "Toggle Inspector", Some("CmdOrCtrl+I"))?)
        .item(&item("swarm-layout", "Toggle Graph / Grid", Some("CmdOrCtrl+G"))?)
        .separator()
        .item(&item("demo", "Demo Mode", Some("Alt+CmdOrCtrl+D"))?)
        .separator()
        .fullscreen()
        .build()?;
    let node = SubmenuBuilder::new(app, "Node")
        .item(&item("node:start-host", "Start My Node", Some("Shift+CmdOrCtrl+H"))?)
        .item(&item("node:load", "Load Model", Some("Shift+CmdOrCtrl+L"))?)
        .separator()
        .item(&item("node:stop", "Stop Node", Some("Shift+CmdOrCtrl+."))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize().maximize().separator().close_window().build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?)
        .item(&item("onboarding", "Show Welcome Tour", None)?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &view, &node, &window, &help]).build()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            engine_log, engine_log_tail, engine_running, start_engine,
            stop_engine, quit_app, system_health, tray_update, notify
        ])
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(build_menu(handle)?)?;
            let status = MenuItemBuilder::with_id("tray:status", "Not running").enabled(false).build(handle)?;
            let tray_menu = MenuBuilder::new(handle)
                .item(&status)
                .separator()
                .item(&MenuItemBuilder::with_id("tray:open", "Open PodTorrent").build(handle)?)
                .item(&MenuItemBuilder::with_id("node:stop", "Stop Node").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("quit", "Quit PodTorrent").build(handle)?)
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(tray_image(&[], false))
                .icon_as_template(true)
                .tooltip("PodTorrent")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .build(handle)?;
            app.manage(TrayStatus(status));
            Ok(())
        })
        .on_menu_event(|app, e| {
            let id = e.id().as_ref();
            match id {
                "quit" => {
                    stop_children(app);
                    app.exit(0);
                }
                "tray:open" => show_main(app),
                _ => {
                    if id == "node:stop" || id == "settings" { show_main(app); }
                    let _ = app.emit("menu", id.to_string());
                }
            }
        })
        .on_window_event(|w, e| {
            // Closing the window keeps the node contributing in the menu bar; ⌘Q quits.
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
                let _ = w.emit("window-hidden", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error building app")
        .run(|app, event| match event {
            RunEvent::Exit => stop_children(app),
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
