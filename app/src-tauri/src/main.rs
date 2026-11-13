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
/// The bundled podtorrent-agent: links this peer to the PodTorrent network.
#[derive(Default)]
struct Agent(Mutex<Option<Child>>);
/// Tray menu's status line, updated from the UI.
struct TrayStatus(MenuItem<Wry>);

/// Windows: start without a console window (the engine is a console program).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// A command for a program outside the app, without the environment the AppImage launcher set.
/// AppImageKit's AppRun (which Tauri bundles) sets PYTHONHOME/PYTHONPATH to the mounted image
/// and puts its folders first on PATH/LD_LIBRARY_PATH etc. Inherited, they make uv's managed
/// Python look for its standard library inside the AppImage ("No module named 'encodings'"),
/// break system Python tools such as powerprofilesctl, and load the image's libraries into
/// ROCm/CUDA processes. Outside an AppImage nothing changes.
fn host_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR").filter(|d| !d.is_empty()) {
        let appdir = PathBuf::from(appdir);
        for var in ["PYTHONHOME", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "PERLLIB"] {
            cmd.env_remove(var);
        }
        // Keep the user's own entries, drop the ones that point into the mounted image.
        for var in ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR", "QT_PLUGIN_PATH"] {
            let Some(val) = std::env::var_os(var) else { continue };
            let kept: Vec<PathBuf> = std::env::split_paths(&val)
                .filter(|p| !p.as_os_str().is_empty() && !p.starts_with(&appdir))
                .collect();
            if kept.is_empty() {
                if var == "PATH" {
                    cmd.env(var, "/usr/local/bin:/usr/bin:/bin");
                } else {
                    cmd.env_remove(var);
                }
            } else if let Ok(joined) = std::env::join_paths(kept) {
                cmd.env(var, joined);
            }
        }
    }
    cmd
}

/// Stop the engine and everything it started (uv -> python).
fn kill_group(child: &mut Child) {
    // Already exited (it crashed, or its node went away): nothing to signal.
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let pid = child.id();
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
        // Give it 3 s to exit cleanly, then kill the group so Quit never hangs.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
    }
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
    let mut cmd = host_command(uv);
    cmd.args(["run", "--project"]).arg(&dir).args(["podtorrent"]).args(&args)
        .env("PODTORRENT_HOME", &data)
        .env("UV_PROJECT_ENVIRONMENT", data.join("venv"))
        // uv's own native Python: a system one (e.g. an Intel Miniconda under Rosetta) can't load MLX.
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(target_os = "macos")]
    cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()));
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

// ---- PodTorrent network (the bundled agent) ----

const AGENT: &str = if cfg!(windows) { "podtorrent-agent.exe" } else { "podtorrent-agent" };

/// The node token lives in the data folder, readable by this user only.
fn token_path() -> PathBuf {
    data_dir().join("node-token")
}

fn saved_token() -> Option<String> {
    std::fs::read_to_string(token_path()).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn save_token(token: &str) -> std::io::Result<()> {
    let p = token_path();
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    std::io::Write::write_all(&mut o.open(&p)?, token.as_bytes())?;
    #[cfg(unix)]
    std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(())
}

/// The network to join, by the name the UI shows. The token must come from the same one.
fn network_url(name: &str) -> Result<&'static str, String> {
    match name {
        "production" => Ok("wss://api.podtorrent.com/v0/node/connect"),
        "staging" => Ok("wss://staging-api.podtorrent.com/v0/node/connect"),
        _ => Err(format!("unknown network {name:?}")),
    }
}

fn engine_port() -> String {
    std::env::var("PODTORRENT_PORT").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "27183".into())
}

/// Whether this machine's node is started: its local API accepts connections. The network agent
/// only runs while it is, since it serves network requests through that API.
fn node_up() -> bool {
    let Ok(port) = engine_port().parse::<u16>() else { return false };
    std::net::TcpStream::connect_timeout(&(std::net::Ipv4Addr::LOCALHOST, port).into(),
        std::time::Duration::from_secs(1)).is_ok()
}

/// Put this peer on the network as `node`. The peer writes network-manifest.json (the models
/// the swarm fully covers, with their routes) from network.json; the agent serves them through
/// the peer's /v1 API. An empty token means the one saved in the data folder.
/// `network` is "production" (default) or "staging"; a node token works on one of them only.
#[tauri::command]
fn network_join(app: AppHandle, state: State<Agent>, node: String, token: String,
                price_in: f64, price_out: f64, network: Option<String>) -> Result<(), String> {
    let network = network.unwrap_or_else(|| "production".into());
    network_url(&network)?;
    let node = node.trim().to_lowercase();
    if node.is_empty() || !node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("node id: letters, digits, - and _ only".into());
    }
    if !(price_in >= 0.0 && price_out >= 0.0) {
        return Err("prices must not be negative".into());
    }
    match token.trim() {
        "" if saved_token().is_none() => return Err("no saved node token: paste the one you were given".into()),
        "" => {}
        t => save_token(t).map_err(|e| format!("couldn't save the token: {e}"))?,
    }
    if !backend_dir(&app).join(AGENT).exists() {
        return Err("this build doesn't include the network agent".into());
    }
    let base = serde_json::json!({ "node": node, "network": network, "tiers": ["interactive", "batch"],
        "price": { "per_mtok_in": price_in, "per_mtok_out": price_out } });
    std::fs::write(data_dir().join("network.json"), serde_json::to_vec_pretty(&base).unwrap()).map_err(|e| e.to_string())?;
    start_agent(&app, &state)
}

/// Start the agent from the saved network.json and token, replacing a running one (and any left
/// over from an earlier run of the app). Fails while this machine's node is offline, and until
/// the swarm fully covers a model.
fn start_agent(app: &AppHandle, state: &Agent) -> Result<(), String> {
    if !node_up() {
        return Err("this machine's node is offline; start your node, then it connects to the network".into());
    }
    let data = data_dir();
    let config: serde_json::Value = std::fs::read_to_string(data.join("network.json")).ok()
        .and_then(|t| serde_json::from_str(&t).ok()).ok_or("not joined")?;
    let url = network_url(config.get("network").and_then(|v| v.as_str()).unwrap_or("production"))?;
    let token = saved_token().ok_or("no saved node token: paste the one you were given")?;
    let bin = backend_dir(app).join(AGENT);
    let manifest = data.join("network-manifest.json");
    let covered = std::fs::read_to_string(&manifest).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|m| m.get("models").and_then(|v| v.as_array()).map(|a| !a.is_empty()))
        .unwrap_or(false);
    if !covered {
        return Err("no model is fully covered by reachable peers yet; try again once the chat box unlocks".into());
    }
    let mut slot = state.0.lock().unwrap();
    if let Some(mut old) = slot.take() {
        kill_group(&mut old);
    }
    kill_stray_agents(&bin);
    let log = std::fs::File::create(data.join("agent.log")).map_err(|e| e.to_string())?;
    let mut cmd = host_command(bin);
    cmd.arg("-manifest").arg(&manifest)
        .env("PODTORRENT_ENGINE", format!("http://127.0.0.1:{}", engine_port()))
        .env("PODTORRENT_NODE_TOKEN", token)
        .env("PODTORRENT_NETWORK", url)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    *slot = Some(cmd.spawn().map_err(|e| format!("failed to start the network agent: {e}"))?);
    Ok(())
}

/// Agents this app started that outlived it (a crash, or a dev rebuild): same binary, not ours.
/// Left running they keep dialing with old settings and write into the new agent.log.
fn kill_stray_agents(bin: &std::path::Path) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    for p in sys.processes().values() {
        if p.exe() == Some(bin) {
            p.kill();
            p.wait();
        }
    }
}

/// Keeps a joined node on the network while this machine's node is started: whenever the agent
/// has exited, start it again when network.json says this machine joined and the swarm covers a
/// model. Stops the agent when the node goes offline, so it never dials the network without one.
fn supervise_agent(app: AppHandle) {
    std::thread::spawn(move || {
        kill_stray_agents(&backend_dir(&app).join(AGENT));
        let mut last: Option<std::time::Instant> = None;
        loop {
            let state = app.state::<Agent>();
            let running = state.0.lock().unwrap().as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none());
            let joined = data_dir().join("network.json").exists();
            if running && !node_up() {
                if let Some(mut c) = state.0.lock().unwrap().take() {
                    kill_group(&mut c);
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }
            // At most every 30 s, so an agent that exits at once doesn't restart in a tight loop.
            if joined && !running && last.is_none_or(|t| t.elapsed() >= std::time::Duration::from_secs(30))
                && start_agent(&app, &state).is_ok() {
                last = Some(std::time::Instant::now());
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

/// Open the operator dashboard of `network` in the default browser.
#[tauri::command]
fn open_dashboard(network: String) -> Result<(), String> {
    let url = match network.as_str() {
        "production" => "https://dashboard.podtorrent.com/",
        "staging" => "https://dashboard-staging.podtorrent.com/",
        _ => return Err(format!("unknown network {network:?}")),
    };
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(url).status();
    #[cfg(windows)]
    let r = Command::new("explorer").arg(url).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = host_command("xdg-open").arg(url).status();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Take this peer off the network. `forget` also removes the saved node token.
#[tauri::command]
fn network_leave(state: State<Agent>, forget: Option<bool>) -> Result<(), String> {
    if let Some(mut c) = state.0.lock().unwrap().take() {
        kill_group(&mut c);
    }
    let _ = std::fs::remove_file(data_dir().join("network.json"));
    if forget.unwrap_or(false) {
        match std::fs::remove_file(token_path()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

/// Whether the agent runs, whether a token is saved, the saved node settings, and the agent's
/// last log lines (it logs connection state, never request content).
#[tauri::command]
fn network_status(app: AppHandle, state: State<Agent>) -> serde_json::Value {
    let running = state.0.lock().unwrap().as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none());
    let saved = saved_token().is_some();
    let read = |f: &str| std::fs::read_to_string(data_dir().join(f)).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let log = std::fs::read_to_string(data_dir().join("agent.log")).unwrap_or_default();
    let lines: Vec<&str> = log.lines().collect();
    // The agent logs "connected" on each link up and "link down" on each drop; the last one wins.
    let connected = running && lines.iter().rev().find(|l| l.contains("msg=connected") || l.contains("link down"))
        .is_some_and(|l| l.contains("msg=connected"));
    serde_json::json!({ "available": backend_dir(&app).join(AGENT).exists(), "running": running, "connected": connected,
        "node_up": node_up(),
        "token_saved": saved, "config": read("network.json"), "manifest": read("network-manifest.json"),
        "log": lines[lines.len().saturating_sub(20)..].join("\n") })
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

/// Stop this machine's node, and the network agent with it: the agent only runs on a started node.
#[tauri::command]
fn stop_engine(state: State<Engine>, agent: State<Agent>) {
    if let Some(mut c) = agent.0.lock().unwrap().take() {
        kill_group(&mut c);
    }
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
    if let Some(mut c) = app.state::<Agent>().0.lock().unwrap().take() {
        kill_group(&mut c);
    }
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
    let gpu = gpu_stats();
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
/// Linux: from /sys/class/power_supply, and power-profiles-daemon's "power-saver" as Battery Saver.
#[cfg(target_os = "linux")]
fn power_status() -> (&'static str, Option<u32>, bool) {
    let read = |p: PathBuf| std::fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default();
    let (mut ac, mut pct) = (None, None);
    for e in std::fs::read_dir("/sys/class/power_supply").into_iter().flatten().flatten() {
        let p = e.path();
        match read(p.join("type")).as_str() {
            "Mains" => ac = Some(ac.unwrap_or(false) || read(p.join("online")) == "1"),
            "Battery" if read(p.join("scope")) != "Device" => {
                pct = pct.or_else(|| read(p.join("capacity")).parse::<u32>().ok());
            }
            _ => {}
        }
    }
    // A desktop has no battery: on AC even when no Mains supply is listed.
    let power = match (ac, pct) { (Some(true), _) | (None, None) => "ac", (Some(false), _) => "battery", (None, Some(_)) => "unknown" };
    let saver = host_command("powerprofilesctl").arg("get").output().ok()
        .is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "power-saver");
    (power, pct, saver)
}
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn power_status() -> (&'static str, Option<u32>, bool) { ("unknown", None, false) }

/// The first NVIDIA GPU's name, temperature, load, memory and driver version from nvidia-smi, or None.
#[cfg(not(target_os = "macos"))]
fn nvidia_gpu() -> Option<serde_json::Value> {
    let mut cmd = host_command("nvidia-smi");
    cmd.args(["--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,driver_version", "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes every poll
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    let line = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
    let f: Vec<&str> = line.split(',').map(str::trim).collect();
    let num = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok());
    Some(serde_json::json!({
        "name": f.first()?, "temp_c": num(1), "util_pct": num(2),
        "mem_used_gb": num(3).map(|m| m / 1024.0), "mem_total_gb": num(4).map(|m| m / 1024.0),
        "driver": f.get(5),
    }))
}

/// The first AMD GPU's name, temperature, load and memory from the amdgpu driver's sysfs files
/// (no rocm-smi needed), or None. `drm` is /sys/class/drm. An integrated GPU (a Ryzen APU) keeps its
/// data in system RAM, so when the GTT pool is larger than the BIOS-reserved VRAM it is the one shown.
#[cfg(any(target_os = "linux", test))]
fn amd_gpu_at(drm: &std::path::Path) -> Option<serde_json::Value> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok().map(|s| s.trim().to_string());
    let num = |p: PathBuf| read(p).and_then(|s| s.parse::<f64>().ok());
    let mut cards: Vec<PathBuf> = std::fs::read_dir(drm).ok()?.flatten().map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("card") && n[4..].chars().all(|c| c.is_ascii_digit())))
        .collect();
    cards.sort();
    let dev = cards.into_iter().map(|c| c.join("device"))
        .find(|d| read(d.join("vendor")).as_deref() == Some("0x1002") && d.join("mem_info_vram_total").exists())?;
    let gb = |b: f64| b / (1u64 << 30) as f64;
    let (vram, gtt) = (num(dev.join("mem_info_vram_total")).unwrap_or(0.0), num(dev.join("mem_info_gtt_total")).unwrap_or(0.0));
    let (total, used) = if gtt > vram {
        (gtt, num(dev.join("mem_info_gtt_used")))
    } else {
        (vram, num(dev.join("mem_info_vram_used")))
    };
    let temp_c = std::fs::read_dir(dev.join("hwmon")).ok()?.flatten()
        .find_map(|h| num(h.path().join("temp1_input"))).map(|t| t / 1000.0);
    Some(serde_json::json!({
        "name": read(dev.join("product_name")).unwrap_or_else(|| "AMD Radeon".into()),
        "temp_c": temp_c, "util_pct": num(dev.join("gpu_busy_percent")),
        "mem_used_gb": used.map(gb), "mem_total_gb": gb(total),
        "driver": read(PathBuf::from("/sys/module/amdgpu/version")),
    }))
}

/// The machine's GPU for the Hardware tab: NVIDIA via nvidia-smi, else AMD via sysfs.
#[cfg(not(target_os = "macos"))]
fn gpu_stats() -> Option<serde_json::Value> {
    #[cfg(target_os = "linux")]
    { nvidia_gpu().or_else(|| amd_gpu_at(std::path::Path::new("/sys/class/drm"))) }
    #[cfg(not(target_os = "linux"))]
    { nvidia_gpu() }
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
    // WebKitGTK's DMA-BUF renderer often draws a blank or flickering window on NVIDIA drivers.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .manage(Agent::default())
        .invoke_handler(tauri::generate_handler![
            engine_log, engine_log_tail, engine_running, start_engine,
            stop_engine, quit_app, system_health, tray_update, notify, setup_progress, local_models,
            data_location, pick_folder, set_data_location, network_join, network_leave, network_status, open_dashboard
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
                // Linux trays send no click events and always open the menu, so "Open PodTorrent" is the way back.
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        if !cfg!(target_os = "macos") { show_main(tray.app_handle()); }
                    }
                })
                .build(handle)?;
            app.manage(TrayStatus(status));
            supervise_agent(handle.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn put(p: &std::path::Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A fake /sys/class/drm with one card: vendor, VRAM/GTT sizes, load and a temperature.
    fn card(root: &std::path::Path, vendor: &str, vram: u64, gtt: u64) {
        let d = root.join("card1/device");
        put(&d.join("vendor"), vendor);
        put(&d.join("mem_info_vram_total"), &vram.to_string());
        put(&d.join("mem_info_vram_used"), "1073741824");
        put(&d.join("mem_info_gtt_total"), &gtt.to_string());
        put(&d.join("mem_info_gtt_used"), "4294967296");
        put(&d.join("gpu_busy_percent"), "37");
        put(&d.join("hwmon/hwmon3/temp1_input"), "51000");
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("podtorrent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn amd_apu_shows_the_shared_pool_not_the_bios_slice() {
        let root = tmp("apu");
        card(&root, "0x1002\n", 4 << 30, 96 << 30);
        let g = amd_gpu_at(&root).unwrap();
        assert_eq!(g["mem_total_gb"], 96.0);
        assert_eq!(g["mem_used_gb"], 4.0);
        assert_eq!(g["util_pct"], 37.0);
        assert_eq!(g["temp_c"], 51.0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn amd_discrete_card_shows_vram() {
        let root = tmp("dgpu");
        card(&root, "0x1002", 16 << 30, 8 << 30);
        assert_eq!(amd_gpu_at(&root).unwrap()["mem_total_gb"], 16.0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn other_vendors_and_missing_dirs_give_none() {
        let root = tmp("nv");
        card(&root, "0x10de", 16 << 30, 8 << 30);
        assert!(amd_gpu_at(&root).is_none());
        assert!(amd_gpu_at(&root.join("nope")).is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
