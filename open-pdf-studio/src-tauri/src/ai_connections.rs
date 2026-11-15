//! AI connections: read and write the MCP settings of known AI clients
//! (Claude Desktop, Claude Code, VS Code, Cursor, Codex, OpenCode) so the
//! user can link them to the app's AI link from the AI connections panel
//! (js/mcp/ai-connections.js plans every change; this module only reads and
//! writes).
//!
//! Scope is deliberately narrow:
//! - Only the fixed per-client settings files are read or written. The
//!   WebView names a client id, never a path.
//! - A write must name the exact text it was planned on (`expected`); a file
//!   that changed since the panel read it is refused.
//! - The new text must parse (JSON with comments, or TOML) before it is
//!   written; a file that does not parse is never touched.
//! - The first write keeps a one-time `<file>.bak` beside the file, then the
//!   file is replaced atomically.
//!
//! `ai_link_test` asks the app's own AI link for `tools/list` on loopback;
//! the editor contacts nothing else.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Largest settings file the panel reads (Claude Code's file grows with history).
const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
/// Largest AI link answer read by Test connection.
const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    Windows,
    Mac,
}

impl Os {
    fn current() -> Os {
        if cfg!(target_os = "windows") {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
    fn sep(self) -> char {
        if self == Os::Windows { '\\' } else { '/' }
    }
}

/// The parts of the environment that decide where clients keep settings.
#[derive(Clone, Debug, Default)]
pub struct HostEnv {
    pub home: String,
    pub appdata: Option<String>,
    pub xdg_config_home: Option<String>,
    pub codex_home: Option<String>,
    pub claude_config_dir: Option<String>,
}

impl HostEnv {
    fn from_process(os: Os) -> Option<HostEnv> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let home = if os == Os::Windows { var("USERPROFILE").or_else(|| var("HOME")) } else { var("HOME") }
            .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()))?;
        Some(HostEnv {
            home,
            appdata: var("APPDATA"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
            codex_home: var("CODEX_HOME"),
            claude_config_dir: var("CLAUDE_CONFIG_DIR"),
        })
    }
}

/// Join path parts with the separator of `os` (so Windows paths can be
/// tested on any machine).
pub fn join(os: Os, base: &str, parts: &[&str]) -> String {
    let sep = os.sep();
    let trim: &[char] = if os == Os::Windows { &['\\', '/'] } else { &['/'] };
    let mut out = base.trim_end_matches(trim).to_string();
    if out.is_empty() && os != Os::Windows {
        out.push('/');
    }
    for part in parts {
        if !out.ends_with(sep) {
            out.push(sep);
        }
        out.push_str(part);
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    ClaudeDesktop,
    ClaudeCode,
    VsCode,
    Cursor,
    Codex,
    OpenCode,
}

pub const CLIENTS: [Client; 6] =
    [Client::ClaudeDesktop, Client::ClaudeCode, Client::VsCode, Client::Cursor, Client::Codex, Client::OpenCode];

impl Client {
    pub fn id(self) -> &'static str {
        match self {
            Client::ClaudeDesktop => "claude-desktop",
            Client::ClaudeCode => "claude-code",
            Client::VsCode => "vscode",
            Client::Cursor => "cursor",
            Client::Codex => "codex",
            Client::OpenCode => "opencode",
        }
    }
    pub fn from_id(id: &str) -> Option<Client> {
        CLIENTS.into_iter().find(|c| c.id() == id)
    }
    /// "json" (comments tolerated) or "toml".
    pub fn format(self) -> &'static str {
        if self == Client::Codex { "toml" } else { "json" }
    }
    fn cli(self) -> Option<&'static str> {
        match self {
            Client::ClaudeDesktop => None,
            Client::ClaudeCode => Some("claude"),
            Client::VsCode => Some("code"),
            Client::Cursor => Some("cursor"),
            Client::Codex => Some("codex"),
            Client::OpenCode => Some("opencode"),
        }
    }
}

/// Linux user configuration directory (XDG_CONFIG_HOME or ~/.config).
fn xdg_config(os: Os, env: &HostEnv) -> String {
    env.xdg_config_home.clone().unwrap_or_else(|| join(os, &env.home, &[".config"]))
}

/// The roaming application-data directory Electron apps use
/// (Claude Desktop, VS Code).
fn app_data(os: Os, env: &HostEnv) -> String {
    match os {
        Os::Windows => env.appdata.clone().unwrap_or_else(|| join(os, &env.home, &["AppData", "Roaming"])),
        Os::Mac => join(os, &env.home, &["Library", "Application Support"]),
        Os::Linux => xdg_config(os, env),
    }
}

/// Candidate settings files of a client, preferred first. The first one that
/// exists is used; with none, the first is created.
pub fn config_candidates(client: Client, os: Os, env: &HostEnv) -> Vec<String> {
    match client {
        Client::ClaudeDesktop => vec![join(os, &app_data(os, env), &["Claude", "claude_desktop_config.json"])],
        Client::ClaudeCode => vec![match &env.claude_config_dir {
            Some(dir) => join(os, dir, &[".claude.json"]),
            None => join(os, &env.home, &[".claude.json"]),
        }],
        Client::VsCode => vec![join(os, &app_data(os, env), &["Code", "User", "mcp.json"])],
        Client::Cursor => vec![join(os, &env.home, &[".cursor", "mcp.json"])],
        Client::Codex => vec![match &env.codex_home {
            Some(dir) => join(os, dir, &["config.toml"]),
            None => join(os, &env.home, &[".codex", "config.toml"]),
        }],
        // OpenCode reads ~/.config/opencode on every platform (XDG base dir).
        Client::OpenCode => {
            let dir = env.xdg_config_home.clone().unwrap_or_else(|| join(os, &env.home, &[".config"]));
            vec![join(os, &dir, &["opencode", "opencode.json"]), join(os, &dir, &["opencode", "opencode.jsonc"])]
        }
    }
}

/// The directory whose presence says the client has been installed and run
/// (besides its command on PATH).
fn install_marker(client: Client, os: Os, env: &HostEnv) -> String {
    match client {
        Client::ClaudeDesktop => join(os, &app_data(os, env), &["Claude"]),
        Client::ClaudeCode => join(os, &env.home, &[".claude"]),
        Client::VsCode => join(os, &app_data(os, env), &["Code", "User"]),
        Client::Cursor => join(os, &env.home, &[".cursor"]),
        Client::Codex => env.codex_home.clone().unwrap_or_else(|| join(os, &env.home, &[".codex"])),
        Client::OpenCode => join(os, &xdg_config(os, env), &["opencode"]),
    }
}

pub fn resolve_config_path(client: Client, os: Os, env: &HostEnv) -> String {
    let candidates = config_candidates(client, os, env);
    candidates.iter().find(|p| Path::new(p).is_file()).cloned().unwrap_or_else(|| candidates[0].clone())
}

/// Find a program on PATH (with PATHEXT on Windows).
pub fn find_on_path(name: &str, path_var: &str, os: Os, pathext: &str) -> Option<String> {
    find_on_path_with(name, path_var, os, pathext, |candidate| {
        let p = Path::new(candidate);
        p.is_file() && is_executable(p)
    })
}

/// `find_on_path` with the file test given (so Windows lookups are testable anywhere).
pub fn find_on_path_with(name: &str, path_var: &str, os: Os, pathext: &str, runnable: impl Fn(&str) -> bool) -> Option<String> {
    let list_sep = if os == Os::Windows { ';' } else { ':' };
    let exts: Vec<String> = if os == Os::Windows {
        let mut e: Vec<String> = pathext.split(';').filter(|x| !x.is_empty()).map(|x| x.to_ascii_lowercase()).collect();
        if e.is_empty() {
            e = vec![".exe".into(), ".cmd".into(), ".bat".into()];
        }
        e
    } else {
        vec![String::new()]
    };
    for dir in path_var.split(list_sep).filter(|d| !d.trim().is_empty()) {
        let dir = dir.trim().trim_matches('"');
        for ext in &exts {
            let candidate = join(os, dir, &[&format!("{name}{ext}")]);
            if runnable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
#[cfg(not(unix))]
fn is_executable(_p: &Path) -> bool {
    true
}

fn which(name: &str) -> Option<String> {
    let os = Os::current();
    let path = std::env::var("PATH").unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_default();
    if let Some(found) = find_on_path(name, &path, os, &pathext) {
        return Some(found);
    }
    // GUI apps on macOS and Linux often start with a short PATH.
    let home = HostEnv::from_process(os).map(|e| e.home).unwrap_or_default();
    let extra: Vec<String> = match os {
        Os::Windows => vec![],
        _ => vec![
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            join(os, &home, &[".local", "bin"]),
            join(os, &home, &[".npm-global", "bin"]),
            join(os, &home, &[".opencode", "bin"]),
        ],
    };
    find_on_path(name, &extra.join(":"), os, "")
}

/// JSON with `//` and `/* */` comments and trailing commas, reduced to plain
/// JSON (for validation only; files are edited as text).
pub fn strip_jsonc(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut pending_comma: Option<usize> = None; // index in `out` of a comma that may trail
    while i < b.len() {
        let c = b[i];
        if c == b'"' {
            let start = i;
            i += 1;
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(b.len());
            out.push_str(&text[start..i]);
            pending_comma = None;
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            out.push(' ');
            continue;
        }
        if c == b',' {
            pending_comma = Some(out.len());
            out.push(',');
            i += 1;
            continue;
        }
        if c == b'}' || c == b']' {
            if let Some(at) = pending_comma.take() {
                out.replace_range(at..at + 1, " ");
            }
        } else if !c.is_ascii_whitespace() {
            pending_comma = None;
        }
        // Copy the whole UTF-8 character.
        let len = utf8_len(c);
        out.push_str(&text[i..(i + len).min(b.len())]);
        i += len;
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// `None` when `text` is a valid settings file of this format: an object at
/// the top (or empty).
pub fn parse_error(format: &str, text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    if format == "toml" {
        return text.parse::<toml::Table>().err().map(|e| e.to_string().trim().to_string());
    }
    match serde_json::from_str::<Value>(&strip_jsonc(text.trim_start_matches('\u{feff}'))) {
        Ok(Value::Object(_)) => None,
        Ok(_) => Some("The file does not hold a JSON object.".into()),
        Err(e) => Some(e.to_string()),
    }
}

fn read_config(path: &str) -> Value {
    let p = Path::new(path);
    match std::fs::metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "exists": false, "text": null, "error": null }),
        Err(e) => json!({ "exists": true, "text": null, "error": e.to_string() }),
        Ok(m) if !m.is_file() => json!({ "exists": true, "text": null, "error": "Not a regular file." }),
        Ok(m) if m.len() > MAX_CONFIG_BYTES => json!({ "exists": true, "text": null, "error": "The file is too large to edit here." }),
        Ok(m) => match std::fs::read(p) {
            Err(e) => json!({ "exists": true, "text": null, "error": e.to_string() }),
            Ok(bytes) => match String::from_utf8(bytes) {
                Err(_) => json!({ "exists": true, "text": null, "error": "The file is not UTF-8 text." }),
                Ok(text) => json!({ "exists": true, "text": text, "error": null, "readOnly": m.permissions().readonly() }),
            },
        },
    }
}

/// Scan one client: where its settings live, whether it looks installed, and
/// the current text (with a parse error when it does not parse).
pub fn scan_client(client: Client, os: Os, env: &HostEnv, cli: Option<String>) -> Value {
    let path = resolve_config_path(client, os, env);
    let mut file = read_config(&path);
    if let Some(text) = file.get("text").and_then(|t| t.as_str()) {
        file["parseError"] = json!(parse_error(client.format(), text));
    }
    let marker = Path::new(&install_marker(client, os, env)).is_dir();
    let installed = cli.is_some() || marker || file["exists"].as_bool().unwrap_or(false);
    json!({
        "id": client.id(),
        "format": client.format(),
        "path": path,
        "installed": installed,
        "cli": cli,
        "file": file,
    })
}

/// Validate, back up once, and write the new settings text of one client.
/// `expected` is the text the change was planned on (`None`: no file yet).
pub fn write_client(client: Client, os: Os, env: &HostEnv, text: &str, expected: Option<&str>) -> Result<Value, String> {
    if let Some(err) = parse_error(client.format(), text) {
        return Err(format!("The planned change does not parse, nothing was written: {err}"));
    }
    // An empty TOML file is valid (Disconnect of the only table); an empty
    // JSON file is not a settings object.
    if text.trim().is_empty() && client.format() == "json" {
        return Err("Refusing to write an empty settings file.".into());
    }
    let path = resolve_config_path(client, os, env);
    let p = PathBuf::from(&path);
    let current = match std::fs::read(&p) {
        Ok(bytes) => Some(String::from_utf8(bytes).map_err(|_| "The file is not UTF-8 text.".to_string())?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{path}: {e}")),
    };
    if current.as_deref() != expected {
        return Err("The file changed since it was read. Review the change again.".into());
    }
    if let Some(cur) = &current {
        if let Some(err) = parse_error(client.format(), cur) {
            return Err(format!("The file does not parse and was not changed: {err}"));
        }
    }
    let mut backup = None;
    if current.is_some() {
        let bak = PathBuf::from(format!("{path}.bak"));
        if !bak.exists() {
            std::fs::copy(&p, &bak).map_err(|e| format!("Could not keep a backup at {}: {e}", bak.display()))?;
            backup = Some(bak.to_string_lossy().into_owned());
        }
    } else if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    crate::atomic_file::write(&p, text.as_bytes()).map_err(|e| format!("{path}: {e}"))?;
    Ok(json!({ "path": path, "backup": backup }))
}

fn host_env() -> Result<(Os, HostEnv), String> {
    let os = Os::current();
    HostEnv::from_process(os).map(|e| (os, e)).ok_or_else(|| "No home directory.".to_string())
}

fn bridge_script(app: &AppHandle) -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("mcp-stdio").join("server.mjs"));
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mcp-stdio/server.mjs"));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| dunce::canonicalize(&p).unwrap_or(p).to_string_lossy().into_owned())
}

/// Every known client with its settings file, plus what a stdio link needs
/// (the bundled bridge and Node.js).
#[tauri::command]
pub async fn ai_connections_scan(app: AppHandle) -> Result<Value, String> {
    let (os, env) = host_env()?;
    let bridge = bridge_script(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let clients: Vec<Value> = CLIENTS.iter().map(|c| scan_client(*c, os, &env, c.cli().and_then(which))).collect();
        json!({
            "os": match os { Os::Windows => "windows", Os::Mac => "macos", Os::Linux => "linux" },
            "clients": clients,
            "bridge": { "script": bridge, "node": which("node") },
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_connection_write(client: String, text: String, expected: Option<String>) -> Result<Value, String> {
    let client = Client::from_id(&client).ok_or_else(|| format!("Unknown client {client}"))?;
    let (os, env) = host_env()?;
    tauri::async_runtime::spawn_blocking(move || write_client(client, os, &env, &text, expected.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn short_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "no answer (timed out)".into()
    } else if e.is_connect() {
        "nothing listening".into()
    } else {
        e.to_string()
    }
}

/// Ask the app's own AI link on loopback for `tools/list`.
#[tauri::command]
pub async fn ai_link_test(port: u16) -> Value {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let resp = match client.post(&url).header("content-type", "application/json").header("accept", "application/json, text/event-stream").body(body.to_string()).send().await {
        Ok(r) => r,
        Err(e) => return json!({ "ok": false, "url": url, "error": short_error(&e) }),
    };
    let status = resp.status().as_u16();
    let bytes = match resp.bytes().await {
        Ok(b) if b.len() <= MAX_ANSWER_BYTES => b,
        Ok(_) => return json!({ "ok": false, "url": url, "error": "The answer is too large." }),
        Err(e) => return json!({ "ok": false, "url": url, "error": short_error(&e) }),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => match v.pointer("/result/tools").and_then(|t| t.as_array()) {
            Some(tools) => json!({ "ok": true, "url": url, "tools": tools.len() }),
            None => json!({ "ok": false, "url": url, "error": v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("No tool list in the answer.") }),
        },
        Err(_) => json!({ "ok": false, "url": url, "error": format!("HTTP {status}, not a JSON-RPC answer") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("ai-conn-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn env(&self) -> HostEnv {
            HostEnv { home: self.0.to_string_lossy().into_owned(), ..Default::default() }
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn win_env() -> HostEnv {
        HostEnv { home: r"C:\Users\Sam".into(), appdata: Some(r"C:\Users\Sam\AppData\Roaming".into()), ..Default::default() }
    }

    #[test]
    fn paths_per_platform() {
        let w = win_env();
        assert_eq!(config_candidates(Client::ClaudeDesktop, Os::Windows, &w)[0], r"C:\Users\Sam\AppData\Roaming\Claude\claude_desktop_config.json");
        assert_eq!(config_candidates(Client::VsCode, Os::Windows, &w)[0], r"C:\Users\Sam\AppData\Roaming\Code\User\mcp.json");
        assert_eq!(config_candidates(Client::ClaudeCode, Os::Windows, &w)[0], r"C:\Users\Sam\.claude.json");
        assert_eq!(config_candidates(Client::Cursor, Os::Windows, &w)[0], r"C:\Users\Sam\.cursor\mcp.json");
        assert_eq!(config_candidates(Client::Codex, Os::Windows, &w)[0], r"C:\Users\Sam\.codex\config.toml");
        assert_eq!(config_candidates(Client::OpenCode, Os::Windows, &w)[0], r"C:\Users\Sam\.config\opencode\opencode.json");
        // A trailing separator on APPDATA does not double up.
        let w2 = HostEnv { appdata: Some(r"C:\Users\Sam\AppData\Roaming\".into()), ..win_env() };
        assert_eq!(config_candidates(Client::ClaudeDesktop, Os::Windows, &w2)[0], r"C:\Users\Sam\AppData\Roaming\Claude\claude_desktop_config.json");
        // Without APPDATA, the roaming folder under the profile.
        let w3 = HostEnv { appdata: None, ..win_env() };
        assert_eq!(config_candidates(Client::VsCode, Os::Windows, &w3)[0], r"C:\Users\Sam\AppData\Roaming\Code\User\mcp.json");

        let l = HostEnv { home: "/home/sam".into(), ..Default::default() };
        assert_eq!(config_candidates(Client::ClaudeDesktop, Os::Linux, &l)[0], "/home/sam/.config/Claude/claude_desktop_config.json");
        assert_eq!(config_candidates(Client::VsCode, Os::Linux, &l)[0], "/home/sam/.config/Code/User/mcp.json");
        assert_eq!(config_candidates(Client::OpenCode, Os::Linux, &l), vec!["/home/sam/.config/opencode/opencode.json", "/home/sam/.config/opencode/opencode.jsonc"]);
        let lx = HostEnv { xdg_config_home: Some("/cfg".into()), codex_home: Some("/codexhome".into()), claude_config_dir: Some("/cc".into()), ..l.clone() };
        assert_eq!(config_candidates(Client::VsCode, Os::Linux, &lx)[0], "/cfg/Code/User/mcp.json");
        assert_eq!(config_candidates(Client::Codex, Os::Linux, &lx)[0], "/codexhome/config.toml");
        assert_eq!(config_candidates(Client::ClaudeCode, Os::Linux, &lx)[0], "/cc/.claude.json");

        let m = HostEnv { home: "/Users/sam".into(), ..Default::default() };
        assert_eq!(config_candidates(Client::ClaudeDesktop, Os::Mac, &m)[0], "/Users/sam/Library/Application Support/Claude/claude_desktop_config.json");
        assert_eq!(config_candidates(Client::VsCode, Os::Mac, &m)[0], "/Users/sam/Library/Application Support/Code/User/mcp.json");
    }

    #[test]
    fn client_ids_round_trip() {
        for c in CLIENTS {
            assert_eq!(Client::from_id(c.id()), Some(c));
        }
        assert_eq!(Client::from_id("../../etc/passwd"), None);
    }

    #[test]
    fn jsonc_is_validated_without_losing_strings() {
        assert_eq!(parse_error("json", "// note\n{ \"servers\": { \"a\": { \"url\": \"http://x//y\" }, }, /* c */ }"), None);
        assert_eq!(parse_error("json", "{\"a\": \"/* not a comment */\", \"b\": [1,2,],}"), None);
        assert_eq!(parse_error("json", "{\"a\": \"é ü 中\"}"), None);
        assert!(parse_error("json", "{\"a\": }").is_some());
        assert!(parse_error("json", "[1,2]").is_some());
        assert_eq!(parse_error("json", "  \n"), None);
        assert_eq!(parse_error("toml", "model = \"x\"\n[mcp_servers.oculith-draw]\nurl = \"http://127.0.0.1:9223/mcp\"\n"), None);
        assert!(parse_error("toml", "[mcp_servers\nurl = 1").is_some());
        assert!(parse_error("toml", "a = 1\na = 2\n").is_some());
    }

    #[test]
    fn write_creates_backs_up_once_and_refuses_changed_or_bad_files() {
        let s = Scratch::new();
        let env = s.env();
        let os = Os::current();
        let path = PathBuf::from(resolve_config_path(Client::Cursor, os, &env));
        // Missing directory: created.
        let first = "{\n  \"mcpServers\": {}\n}\n";
        let r = write_client(Client::Cursor, os, &env, first, None).unwrap();
        assert_eq!(r["backup"], Value::Null);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        // Second write: one-time backup of the previous text.
        let second = "{\n  \"mcpServers\": {\"x\": {\"url\": \"u\"}}\n}\n";
        let r = write_client(Client::Cursor, os, &env, second, Some(first)).unwrap();
        assert!(r["backup"].as_str().unwrap().ends_with("mcp.json.bak"));
        let third = "{}\n";
        let r = write_client(Client::Cursor, os, &env, third, Some(second)).unwrap();
        assert_eq!(r["backup"], Value::Null);
        assert_eq!(std::fs::read_to_string(format!("{}.bak", path.display())).unwrap(), first);
        // Changed on disk since the plan.
        assert!(write_client(Client::Cursor, os, &env, first, Some(second)).unwrap_err().contains("changed"));
        // A plan that does not parse.
        assert!(write_client(Client::Cursor, os, &env, "{oops", Some(third)).unwrap_err().contains("does not parse"));
        // A file that does not parse is not touched.
        std::fs::write(&path, "{ broken").unwrap();
        assert!(write_client(Client::Cursor, os, &env, first, Some("{ broken")).unwrap_err().contains("does not parse"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
        // A TOML file whose only table was removed may become empty.
        let codex = PathBuf::from(resolve_config_path(Client::Codex, os, &env));
        let only = "[mcp_servers.oculith-draw]\nurl = \"http://127.0.0.1:9223/mcp\"\n";
        write_client(Client::Codex, os, &env, only, None).unwrap();
        write_client(Client::Codex, os, &env, "", Some(only)).unwrap();
        assert_eq!(std::fs::read_to_string(&codex).unwrap(), "");
        assert!(write_client(Client::Cursor, os, &env, " ", Some(first)).is_err());
        // No stray temp files.
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[cfg(unix)]
    #[test]
    fn read_only_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new();
        let env = s.env();
        let path = resolve_config_path(Client::Codex, Os::Linux, &env);
        std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, "model = \"m\"\n").unwrap();
        // Keep a backup already, so the refusal comes from the write itself.
        std::fs::write(format!("{path}.bak"), "model = \"m\"\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let err = write_client(Client::Codex, Os::Linux, &env, "model = \"n\"\n", Some("model = \"m\"\n")).unwrap_err();
        assert!(err.contains("writable") || err.contains("denied"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "model = \"m\"\n");
        let scan = scan_client(Client::Codex, Os::Linux, &env, None);
        assert_eq!(scan["file"]["readOnly"], json!(true));
    }

    #[test]
    fn scan_reports_parse_errors_and_prefers_an_existing_jsonc() {
        let s = Scratch::new();
        let env = s.env();
        let os = Os::current();
        let scan = scan_client(Client::OpenCode, os, &env, None);
        assert_eq!(scan["installed"], json!(false));
        assert_eq!(scan["file"]["exists"], json!(false));
        assert!(scan["path"].as_str().unwrap().ends_with("opencode.json"));
        let dir = s.0.join(".config").join("opencode");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("opencode.jsonc"), "{ // c\n \"mcp\": { }\n").unwrap();
        let scan = scan_client(Client::OpenCode, os, &env, None);
        assert_eq!(scan["installed"], json!(true));
        assert!(scan["path"].as_str().unwrap().ends_with("opencode.jsonc"));
        assert!(scan["file"]["parseError"].is_string());
    }

    #[test]
    fn path_search_honours_pathext_on_windows_style_lists() {
        let s = Scratch::new();
        let bin = s.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("claude");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_var = format!("/nonexistent:{}", bin.display());
        assert_eq!(find_on_path("claude", &path_var, Os::Linux, ""), Some(tool.to_string_lossy().into_owned()));
        assert_eq!(find_on_path("codex", &path_var, Os::Linux, ""), None);
        // Windows-style lookup: ';' separates PATH entries (quoted ones too),
        // PATHEXT supplies the extensions, '\\' joins.
        let present = [r"C:\Users\Sam\AppData\Roaming\npm\code.cmd", r"C:\Program Files\Microsoft VS Code\bin\code.exe", r"C:\Program Files\Codex\codex.exe"];
        let runnable = |c: &str| present.contains(&c);
        let path_var = r#"C:\Windows\system32;"C:\Program Files\Codex\";C:\Users\Sam\AppData\Roaming\npm"#;
        assert_eq!(find_on_path_with("code", path_var, Os::Windows, ".COM;.EXE;.BAT;.CMD", runnable).as_deref(), Some(present[0]));
        assert_eq!(find_on_path_with("codex", path_var, Os::Windows, "", runnable).as_deref(), Some(present[2]));
        assert_eq!(find_on_path_with("cursor", path_var, Os::Windows, ".EXE;.CMD", runnable), None);
    }


    #[test]
    fn link_test_counts_the_tools_of_the_ai_link() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut s = listener.incoming().next().unwrap().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).contains("tools/list"));
            let body = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"},{"name":"b"}]}}"#;
            let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body);
        });
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = rt.block_on(ai_link_test(port));
        assert_eq!((r["ok"].clone(), r["tools"].clone()), (json!(true), json!(2)), "{r}");
        // Nothing listening: a short error, not a failure of the command.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let r = rt.block_on(ai_link_test(closed));
        assert_eq!(r["ok"], json!(false));
    }
}
