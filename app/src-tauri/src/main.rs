#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
struct Engine(Mutex<Option<Child>>);
/// Tray menu's status line, updated from the UI.
struct TrayStatus(MenuItem<Wry>);

/// Windows: start without a console window (the engine is a console program).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Stop the engine and everything it started (uv -> python).
fn kill_group(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW).status();
    let _ = child.wait();
}

/// ~/.podtorrent (Python's Path.home(): HOME, else USERPROFILE on Windows). Always holds the
/// `location` pointer file, even when the data itself lives elsewhere.
fn default_dir() -> PathBuf {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".podtorrent")
}

/// Where models, the venv and logs live: the folder the user chose (default_dir()/location), else
/// default_dir(). The engine gets it as PODTORRENT_HOME.
fn data_dir() -> PathBuf {
    std::fs::read_to_string(default_dir().join("location")).ok()
        .map(|s| PathBuf::from(s.trim())).filter(|p| p.is_absolute())
        .unwrap_or_else(default_dir)
}

/// Free bytes on the disk holding `p` (the mount point that is its longest prefix).
fn free_bytes(p: &std::path::Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks.list().iter().filter(|d| p.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len()).map(|d| d.available_space())
}

fn location_info(p: PathBuf) -> serde_json::Value {
    serde_json::json!({
        "path": p.to_string_lossy(), "default": p == default_dir(),
        "free_gb": free_bytes(&p).map(|b| b as f64 / (1u64 << 30) as f64),
    })
}

/// The data folder in use, and free space on its disk.
#[tauri::command]
fn data_location() -> serde_json::Value { location_info(data_dir()) }

/// Native folder picker; None if cancelled. Runs off the main thread (async command).
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().set_title("Choose where PodTorrent keeps models").set_directory(data_dir())
        .blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// Use `path` for data from the next engine start. Existing data is not moved (it can be many GB);
/// only this machine's identity and settings are copied so it stays the same peer.
#[tauri::command]
fn set_data_location(state: State<Engine>, path: Option<String>) -> Result<serde_json::Value, String> {
    if state.0.lock().unwrap().is_some() {
        return Err("Stop your node before changing where data is stored.".into());
    }
    let new = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_dir(),
    };
    if !new.is_absolute() {
        return Err("Choose a full folder path.".into());
    }
    // A chosen drive root or existing folder gets its own subfolder, so data never mixes with other files.
    let new = if new != default_dir() && new.file_name().is_none_or(|n| n != "PodTorrent") { new.join("PodTorrent") } else { new };
    std::fs::create_dir_all(&new).map_err(|e| format!("Can't create {}: {e}", new.display()))?;
    let probe = new.join(".write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("Can't write to {}: {e}", new.display()))?;
    let _ = std::fs::remove_file(probe);
    let old = data_dir();
    if old != new {
        for f in ["identity", "config.json"] {
            if old.join(f).exists() && !new.join(f).exists() {
                let _ = std::fs::copy(old.join(f), new.join(f));
            }
        }
    }
    let base = default_dir();
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    if new == base {
        let _ = std::fs::remove_file(base.join("location"));
    } else {
        std::fs::write(base.join("location"), new.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(location_info(new))
}

const UV: &str = if cfg!(windows) { "uv.exe" } else { "uv" };

/// Bundled backend (uv + Python sources) if present, else the repo this app was built from (dev).
fn backend_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let b = res.join("resources/backend");
        if b.join(UV).exists() {
            return b;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Start this machine's peer (`podtorrent peer`). Output goes to ~/.podtorrent/engine.log.
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
    let uv = if dir.join(UV).exists() { dir.join(UV) } else { PathBuf::from(UV) };
    let mut cmd = Command::new(uv);
    cmd.args(["run", "--project"]).arg(&dir).args(["podtorrent"]).args(&args)
        .env("PODTORRENT_HOME", &data)
        .env("UV_PROJECT_ENVIRONMENT", data.join("venv"))
        // uv's own native Python: a system one (e.g. an Intel Miniconda under Rosetta) can't load MLX.
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(unix)]
    cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()))
        .process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    // Off Apple Silicon the first run downloads CUDA PyTorch (~3 GB). A cache of our own lets
    // setup_progress measure it; macOS keeps uv's shared cache so existing installs don't redownload.
    #[cfg(not(target_os = "macos"))]
    cmd.env("UV_CACHE_DIR", data.join("uv-cache"));
    // In a chosen folder uv's managed Python goes there too, so nothing large lands on the system
    // drive. The default location keeps uv's own, so existing installs don't rebuild their venv.
    if data != default_dir() {
        cmd.env("UV_PYTHON_INSTALL_DIR", data.join("python"));
    }
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

/// Bytes in the engine's package cache: grows while the first run downloads PyTorch, for the
/// UI's install progress. Always 0 on macOS (uv's shared cache there, and MLX is small).
#[tauri::command]
fn setup_progress() -> u64 {
    fn size(p: &std::path::Path) -> u64 {
        std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        }).sum()).unwrap_or(0)
    }
    size(&data_dir().join("uv-cache"))
}

/// Model folders on this machine without the engine (mirrors podtorrent/catalog.py `local`):
/// layers held (from safetensors headers), layer count, and disk size.
#[tauri::command]
fn local_models() -> Vec<serde_json::Value> {
    use std::io::Read;
    fn size(p: &std::path::Path) -> u64 {
        std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => size(&e.path()),
            Ok(m) => m.len(),
            _ => 0,
        }).sum()).unwrap_or(0)
    }
    let home = data_dir().join("models");
    let mut dirs: Vec<_> = std::fs::read_dir(&home).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
    dirs.sort();
    dirs.iter().map(|d| {
        let name = d.file_name().unwrap_or_default().to_string_lossy().to_string();
        let repo = std::fs::read_to_string(d.join(".repo")).map(|s| s.trim().to_string()).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| name.clone());
        let n = std::fs::read_to_string(d.join("config.json")).ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|c| c.get("num_hidden_layers").and_then(|v| v.as_u64()));
        let mut layers = std::collections::BTreeSet::new();
        for f in std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "safetensors")) {
            let Ok(mut fh) = std::fs::File::open(&f) else { continue };
            let mut len = [0u8; 8];
            if fh.read_exact(&mut len).is_err() { continue }
            let mut buf = vec![0u8; u64::from_le_bytes(len).min(1 << 28) as usize];
            if fh.read_exact(&mut buf).is_err() { continue }
            let Ok(serde_json::Value::Object(m)) = serde_json::from_slice(&buf) else { continue };
            layers.extend(m.keys().filter_map(|k| k.strip_prefix("model.layers.")?.split('.').next()?.parse::<u64>().ok()));
        }
        let mut runs: Vec<[u64; 2]> = vec![];
        for x in &layers {
            match runs.last_mut() { Some(r) if r[1] == *x => r[1] += 1, _ => runs.push([*x, x + 1]) }
        }
        serde_json::json!({ "repo": repo, "dir": name, "n_layers": n, "layers": runs,
            "complete": n.is_some_and(|n| n > 0 && layers.len() as u64 == n), "disk_bytes": size(d), "serving": [] })
    }).collect()
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

#[cfg(target_os = "macos")]
fn sh(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

struct Static { chip: String, mem_bytes: u64, os: String }
fn statics() -> &'static Static {
    static S: OnceLock<Static> = OnceLock::new();
    S.get_or_init(|| {
        use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
        let sys = System::new_with_specifics(RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing()).with_memory(MemoryRefreshKind::nothing().with_ram()));
        Static {
            chip: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
            mem_bytes: sys.total_memory(),
            // "macOS 15.5" / "Windows 11 Pro": the UI shows it as is.
            os: if cfg!(target_os = "macos") {
                format!("macOS {}", System::os_version().unwrap_or_default())
            } else {
                System::long_os_version().unwrap_or_default()
            },
        }
    })
}

/// Chip, memory, power source, thermal state and memory pressure. Used to show health
/// and to throttle the UI's own animation; never affects the engine.
#[cfg(target_os = "macos")]
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

/// Elsewhere: chip, memory and memory pressure (from free RAM); on Windows also power and
/// Battery Saver, and with an NVIDIA GPU its temperature (as the thermal state), load and memory.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn system_health() -> serde_json::Value {
    use sysinfo::{MemoryRefreshKind, System};
    let s = statics();
    let mut sys = System::new();
    sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
    let avail = sys.available_memory() as f64 / sys.total_memory().max(1) as f64;
    let pressure = if avail < 0.05 { "critical" } else if avail < 0.15 { "warn" } else { "normal" };
    let (power, battery_pct, low_power) = power_status();
    let gpu = nvidia_gpu();
    let thermal = match gpu.as_ref().and_then(|g| g["temp_c"].as_f64()) {
        Some(t) if t >= 93.0 => "critical", Some(t) if t >= 87.0 => "serious",
        Some(t) if t >= 80.0 => "fair", Some(_) => "nominal", None => "unknown",
    };
    serde_json::json!({
        "chip": s.chip, "mem_total_gb": s.mem_bytes as f64 / (1u64 << 30) as f64, "os": s.os,
        "thermal": thermal, "low_power": low_power,
        "power": power, "battery_pct": battery_pct, "mem_pressure": pressure,
        "ram_used_pct": ((1.0 - avail) * 100.0).round(), "gpu": gpu,
    })
}

/// AC or battery, battery percent (None on a desktop) and whether Battery Saver is on.
#[cfg(windows)]
fn power_status() -> (&'static str, Option<u32>, bool) {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut p: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut p) } == 0 { return ("unknown", None, false); }
    let power = match p.ACLineStatus { 1 => "ac", 0 => "battery", _ => "unknown" };
    // BatteryFlag 128: no battery; BatteryLifePercent 255: unknown.
    let pct = (p.BatteryFlag & 128 == 0 && p.BatteryLifePercent != 255).then_some(p.BatteryLifePercent as u32);
    (power, pct, p.SystemStatusFlag == 1)
}
#[cfg(not(any(windows, target_os = "macos")))]
fn power_status() -> (&'static str, Option<u32>, bool) { ("unknown", None, false) }

/// The first NVIDIA GPU's name, temperature, load and memory from nvidia-smi, or None.
#[cfg(not(target_os = "macos"))]
fn nvidia_gpu() -> Option<serde_json::Value> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes every poll
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    let line = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
    let f: Vec<&str> = line.split(',').map(str::trim).collect();
    let num = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok());
    Some(serde_json::json!({
        "name": f.first()?, "temp_c": num(1), "util_pct": num(2),
        "mem_used_gb": num(3).map(|m| m / 1024.0), "mem_total_gb": num(4).map(|m| m / 1024.0),
    }))
}

// ---- tray ----

/// Menu-bar icon: a status dot (filled = contributing) and a throughput sparkline.
/// On macOS it's a template image (tinted for light and dark menu bars); elsewhere
/// there's no tinting, so it's drawn white for the usually dark taskbar.
fn tray_image(samples: &[f32], online: bool) -> Image<'static> {
    let (w, h) = (64u32, 36u32);
    let mut px = vec![0u8; (w * h * 4) as usize];
    if !cfg!(target_os = "macos") {
        px.chunks_exact_mut(4).for_each(|p| p[..3].fill(255));
    }
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
        #[cfg(target_os = "macos")]
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

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            engine_log, engine_log_tail, engine_running, start_engine,
            stop_engine, quit_app, system_health, tray_update, notify, setup_progress, local_models,
            data_location, pick_folder, set_data_location
        ])
        .setup(|app| {
            let handle = app.handle();
            // Only macOS has an app menu bar; on Windows it would render inside the window,
            // and the UI handles Ctrl shortcuts itself there.
            #[cfg(target_os = "macos")]
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
                // macOS opens tray menus on click; on Windows left-click opens the window, right-click the menu.
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        if !cfg!(target_os = "macos") { show_main(tray.app_handle()); }
                    }
                })
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
            // Closing the window keeps the node contributing from the menu bar / tray; Quit is in the tray menu.
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
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
