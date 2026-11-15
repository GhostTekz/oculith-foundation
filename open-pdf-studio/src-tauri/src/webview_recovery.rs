//! When the page's web process ends under the window.
//!
//! The web engine runs the page in its own process. When that process
//! crashes (or the system takes its memory), the window stays open with a
//! dead, blank page while the rest of the app keeps running. On Linux the
//! main window watches for this: it records why in the app log and the
//! startup diagnostics, reloads the page, and keeps a notice that the
//! reloaded page reads (`webview_termination_notice`) to reopen the drawings
//! and offer the unsaved markups from the crash-recovery file.
//!
//! The crash-recovery file (`crash-recovery.json` beside the session file) is
//! written by the page while a drawing has unsaved changes and removed when
//! there are none; it also covers a crash of the whole app.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// At most this many automatic reloads within `RELOAD_WINDOW`: a page that
/// takes its process down again right after loading is not reloaded forever.
pub const MAX_RELOADS: usize = 3;
pub const RELOAD_WINDOW: Duration = Duration::from_secs(300);

/// The largest crash-recovery file the page may write.
pub const MAX_RECOVERY_BYTES: usize = 64 * 1024 * 1024;

const RECOVERY_FILE: &str = "crash-recovery.json";

/// Why the web process ended, as recorded in the log and diagnostics.
pub const TERMINATION_REASONS: &[&str] = &["crashed", "memory-limit", "ended-by-app", "unknown"];

/// A page reload after the web process ended, for the reloaded page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewTermination {
    pub reason: String,
    pub at_ms: u64,
    pub reloaded: bool,
}

#[derive(Default)]
pub struct WebviewRecovery {
    reloads: Mutex<VecDeque<Instant>>,
    notice: Mutex<Option<WebviewTermination>>,
}

/// Room for another automatic reload at `now`? Records it when there is.
pub fn allow_reload(
    reloads: &mut VecDeque<Instant>,
    now: Instant,
    max: usize,
    window: Duration,
) -> bool {
    while let Some(first) = reloads.front() {
        if now.saturating_duration_since(*first) > window {
            reloads.pop_front();
        } else {
            break;
        }
    }
    if reloads.len() >= max {
        return false;
    }
    reloads.push_back(now);
    true
}

/// Does the page come back after this ending? Not when the app ended it.
pub fn reload_after(reason: &str) -> bool {
    reason != "ended-by-app"
}

impl WebviewRecovery {
    /// Note that the web process ended for `reason` (one of
    /// TERMINATION_REASONS); true when the page is to be reloaded.
    pub fn ended(&self, reason: &str, now: Instant) -> bool {
        let reload = reload_after(reason)
            && self
                .reloads
                .lock()
                .map(|mut reloads| allow_reload(&mut reloads, now, MAX_RELOADS, RELOAD_WINDOW))
                .unwrap_or(false);
        let at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default();
        if let Ok(mut notice) = self.notice.lock() {
            *notice = Some(WebviewTermination {
                reason: reason.to_string(),
                at_ms,
                reloaded: reload,
            });
        }
        reload
    }

    /// The last ending, once: the reloaded page asks at start.
    pub fn take_notice(&self) -> Option<WebviewTermination> {
        self.notice.lock().ok().and_then(|mut notice| notice.take())
    }
}

#[cfg(target_os = "linux")]
pub fn reason_label(reason: webkit2gtk::WebProcessTerminationReason) -> &'static str {
    use webkit2gtk::WebProcessTerminationReason as R;
    match reason {
        R::Crashed => "crashed",
        R::ExceededMemoryLimit => "memory-limit",
        R::TerminatedByApi => "ended-by-app",
        _ => "unknown",
    }
}

/// Watch the main window's web process (Linux, WebKitGTK).
#[cfg(target_os = "linux")]
pub fn watch_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let _ = main.with_webview(move |webview| {
        use webkit2gtk::WebViewExt;
        webview.inner().connect_web_process_terminated(move |view, reason| {
            let label = reason_label(reason);
            log::error!("[webview] the page's web process ended ({label}); see the system crash log for a core dump");
            if let Some(diagnostics) = handle.try_state::<crate::startup_diagnostics::StartupDiagnostics>() {
                diagnostics.record("webview-terminated", Some(label));
            }
            let reload = handle
                .try_state::<WebviewRecovery>()
                .map(|recovery| recovery.ended(label, Instant::now()))
                .unwrap_or(false);
            if !reload {
                log::error!("[webview] not reloading the page ({label}, {MAX_RELOADS} reloads within {}s already)", RELOAD_WINDOW.as_secs());
                return;
            }
            // Panel windows popped out of the page ran in the same process.
            for (label, window) in handle.webview_windows() {
                if label.starts_with("panel-") {
                    let _ = window.destroy();
                }
            }
            log::warn!("[webview] reloading the page");
            view.reload();
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn watch_main_window<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

/// The last time the page's web process ended, once (None when it has not).
#[tauri::command]
pub fn webview_termination_notice(
    recovery: tauri::State<'_, WebviewRecovery>,
) -> Option<WebviewTermination> {
    recovery.take_notice()
}

const DETACHED_PREFIX: &str = "crash-recovery-detached-";
/// A detached window's file left behind by a process that ended is removed
/// after this long.
const DETACHED_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// The crash-recovery file name of this process. A detached document window
/// is its own app process (window_mgmt.rs) and keeps its own file, so two
/// processes never write one file; it outlives a reload of its page.
pub fn recovery_file_name(detached_pid: Option<u32>) -> String {
    match detached_pid {
        Some(pid) => format!("{DETACHED_PREFIX}{pid}.json"),
        None => RECOVERY_FILE.to_string(),
    }
}

fn storage_dir() -> Option<PathBuf> {
    let dir = crate::datamap::lokale_datamap()?.join(crate::APP_STORAGE_DIR);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn detached() -> bool {
    std::env::var("OPDS_DETACHED").as_deref() == Ok("1")
}

fn recovery_file() -> Option<PathBuf> {
    let pid = detached().then(std::process::id);
    Some(storage_dir()?.join(recovery_file_name(pid)))
}

/// Remove old files of detached windows (the main window's process only).
fn sweep_detached_files(dir: &std::path::Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(DETACHED_PREFIX) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Check what the page writes as crash recovery: JSON, within the size cap.
pub fn valid_recovery(data: &str) -> Result<(), String> {
    if data.len() > MAX_RECOVERY_BYTES {
        return Err(format!("crash recovery too large ({} bytes)", data.len()));
    }
    serde_json::from_str::<serde_json::Value>(data)
        .map(|_| ())
        .map_err(|e| format!("crash recovery is not JSON: {e}"))
}

#[tauri::command(async)]
pub fn crash_recovery_save(data: String) -> Result<(), String> {
    valid_recovery(&data)?;
    let path = recovery_file().ok_or("no app data directory")?;
    crate::atomic_file::write(&path, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn crash_recovery_load() -> Option<String> {
    if !detached() {
        if let Some(dir) = storage_dir() {
            sweep_detached_files(&dir, DETACHED_MAX_AGE);
        }
    }
    std::fs::read_to_string(recovery_file()?).ok()
}

#[tauri::command(async)]
pub fn crash_recovery_clear() -> Result<(), String> {
    let Some(path) = recovery_file() else {
        return Ok(());
    };
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_are_capped_within_the_window() {
        let mut reloads = VecDeque::new();
        let start = Instant::now();
        let window = Duration::from_secs(300);
        assert!(allow_reload(&mut reloads, start, 3, window));
        assert!(allow_reload(
            &mut reloads,
            start + Duration::from_secs(10),
            3,
            window
        ));
        assert!(allow_reload(
            &mut reloads,
            start + Duration::from_secs(20),
            3,
            window
        ));
        assert!(!allow_reload(
            &mut reloads,
            start + Duration::from_secs(30),
            3,
            window
        ));
        // Once the first reload is older than the window, there is room again.
        assert!(allow_reload(
            &mut reloads,
            start + Duration::from_secs(301),
            3,
            window
        ));
        assert_eq!(reloads.len(), 3);
    }

    #[test]
    fn a_page_the_app_ended_is_not_reloaded() {
        assert!(reload_after("crashed"));
        assert!(reload_after("memory-limit"));
        assert!(reload_after("unknown"));
        assert!(!reload_after("ended-by-app"));
    }

    #[test]
    fn the_notice_is_kept_once_for_the_reloaded_page() {
        let recovery = WebviewRecovery::default();
        assert_eq!(recovery.take_notice(), None);
        let now = Instant::now();
        assert!(recovery.ended("crashed", now));
        let notice = recovery.take_notice().expect("a notice");
        assert_eq!(notice.reason, "crashed");
        assert!(notice.reloaded);
        assert!(notice.at_ms > 0);
        assert_eq!(recovery.take_notice(), None);

        assert!(!recovery.ended("ended-by-app", now));
        assert!(!recovery.take_notice().unwrap().reloaded);
        // The fourth crash within the window: noted, not reloaded.
        assert!(recovery.ended("crashed", now));
        assert!(recovery.ended("crashed", now));
        assert!(!recovery.ended("crashed", now));
        assert!(!recovery.take_notice().unwrap().reloaded);
    }

    #[test]
    fn the_notice_is_camel_case_json() {
        let notice = WebviewTermination {
            reason: "crashed".into(),
            at_ms: 7,
            reloaded: true,
        };
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"reason":"crashed","atMs":7,"reloaded":true}"#
        );
    }

    #[test]
    fn recovery_data_must_be_json_within_the_cap() {
        assert!(valid_recovery(r#"{"version":1,"documents":[]}"#).is_ok());
        assert!(valid_recovery("not json").is_err());
        let big = format!("\"{}\"", "x".repeat(MAX_RECOVERY_BYTES));
        assert!(valid_recovery(&big).is_err());
    }

    #[test]
    fn a_detached_window_keeps_its_own_file() {
        assert_eq!(recovery_file_name(None), "crash-recovery.json");
        assert_eq!(
            recovery_file_name(Some(42)),
            "crash-recovery-detached-42.json"
        );
    }

    #[test]
    fn only_old_detached_files_are_swept() {
        let dir =
            std::env::temp_dir().join(format!("webview-recovery-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("crash-recovery.json"), "{}").unwrap();
        std::fs::write(dir.join("crash-recovery-detached-1.json"), "{}").unwrap();
        sweep_detached_files(&dir, Duration::from_secs(3600));
        assert!(dir.join("crash-recovery-detached-1.json").exists());
        sweep_detached_files(&dir, Duration::ZERO);
        assert!(!dir.join("crash-recovery-detached-1.json").exists());
        assert!(dir.join("crash-recovery.json").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_reason_label_is_a_known_reason() {
        for reason in ["crashed", "memory-limit", "ended-by-app", "unknown"] {
            assert!(TERMINATION_REASONS.contains(&reason));
        }
    }
}
