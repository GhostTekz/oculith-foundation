//! The optional add-on helper bridge: a published, generic part of the editor.
//!
//! A full edition may declare one helper. Independent native packages may
//! each declare a helper. The editor starts a verified helper on its first
//! call and passes JSON lines:
//!
//! - `edition_helper_call(method, params)` sends `{"id", "method", "params"}`
//!   and resolves with the helper's `result` or `error`;
//! - a line `{"event", "payload"}` from the helper is emitted to the page as
//!   the Tauri event `edition-helper` with that object.
//! - `addon_helper_call(package_id, method, params)` selects an enabled
//!   package; its events use `addon-helper` with that package ID.
//!
//! The editor knows nothing about the methods. A package without a verified
//! helper receives a "no helper" error.
//!
//! A call may bound its wait: `timeoutMs` fails it when no answer comes in
//! that time, `idleMs` when the helper writes no line at all (no event, no
//! reply) for that long. Either way the call fails with a plain error and
//! its slot is freed; a late answer is dropped. Without them a call waits
//! until the helper answers or stops.
//!
//! One writer task owns the helper's input and takes lines from a channel, so
//! a large request never holds up other calls behind a lock. The reader looks
//! only at a line's top-level keys: results and event lines are passed on as
//! the helper wrote them, without being parsed into a tree and written again.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

type Reply = Result<Box<RawValue>, String>;
type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

/// Request lines waiting for the writer; a full queue makes callers wait
/// (without any lock held) instead of growing without bound.
const QUEUE: usize = 64;
const STOPPED: &str = "The edition helper stopped.";
const EVENT: &str = "edition-helper";

/// One request line for the writer task, with the id it answers to.
struct Outgoing {
    id: u64,
    line: Vec<u8>,
}

struct Running {
    queue: mpsc::Sender<Outgoing>,
    child: Child,
    pending: Pending,
    activity: Arc<Activity>,
}

/// When the helper last wrote a line (any line), for the calls that wait
/// with an idle limit.
struct Activity {
    epoch: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self { Self { epoch: Instant::now(), last_ms: AtomicU64::new(0) } }
    fn touch(&self) {
        let ms = u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_ms.fetch_max(ms, Ordering::Relaxed);
    }
    fn last(&self) -> Instant { self.epoch + Duration::from_millis(self.last_ms.load(Ordering::Relaxed)) }
}

/// How long one call may wait (see the module notes). The longest accepted
/// limit is a day; a larger or zero value means no limit.
#[derive(Clone, Copy, Default, Debug)]
struct Limits {
    total: Option<Duration>,
    idle: Option<Duration>,
}

const LONGEST_LIMIT_MS: u64 = 24 * 60 * 60 * 1000;

impl Limits {
    fn from_ms(timeout_ms: Option<u64>, idle_ms: Option<u64>) -> Self {
        let pick = |ms: Option<u64>| ms.filter(|ms| *ms > 0 && *ms <= LONGEST_LIMIT_MS).map(Duration::from_millis);
        Self { total: pick(timeout_ms), idle: pick(idle_ms) }
    }
}

fn whole_seconds(d: Duration) -> u64 { d.as_millis().div_ceil(1000) as u64 }

#[derive(Default)]
pub struct EditionHelper {
    running: Mutex<HashMap<String, Running>>,
    next: AtomicU64,
}

const NO_HELPER: &str = "This edition has no helper.";
const NO_PACKAGE_HELPER: &str = "This package has no enabled, verified helper.";

/// The top-level keys of a helper line, borrowed from it unparsed. A key that
/// is present (even as `null`) is `Some`.
#[derive(Deserialize)]
struct Line<'a> {
    #[serde(borrow, default, deserialize_with = "present")]
    id: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    event: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    payload: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    result: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    error: Option<&'a RawValue>,
}

fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(d).map(Some)
}

/// Whether the selected add-on ships a helper.
#[tauri::command]
pub fn edition_helper_available(app: tauri::AppHandle) -> bool {
    crate::selected_helper_available(&app)
}

fn fail(pending: &Pending, id: u64) {
    if let Some(tx) = pending.lock().unwrap().remove(&id) {
        let _ = tx.send(Err(STOPPED.into()));
    }
}

/// Pass one helper line on: an event to the page, a reply to its caller.
fn dispatch(app: &tauri::AppHandle, pending: &Pending, line: String, package_id: Option<&str>) {
    let Ok(message) = serde_json::from_str::<Line>(&line) else { return };
    if let Some(event) = message.event {
        // Checked as JSON above, so it can go to the page as written.
        if let Some(package_id) = package_id {
            if serde_json::from_str::<String>(event.get()).is_ok() {
                let wrapped = format!(r#"{{"packageId":{},"event":{},"payload":{}}}"#,
                    serde_json::to_string(package_id).expect("package id is serializable"),
                    event.get(), message.payload.map_or("null", RawValue::get));
                let _ = app.emit_str("addon-helper", wrapped);
            }
        } else { let _ = app.emit_str(EVENT, line); }
        return;
    }
    let Some(id) = message.id.and_then(|id| serde_json::from_str::<u64>(id.get()).ok()) else {
        // An error the helper could not tie to a call (a line it could
        // not read): passed on, not dropped, so the page can show it.
        if message.error.is_some() {
            if let Some(package_id) = package_id {
                let _ = app.emit_str("addon-helper", json!({"packageId": package_id, "event": "helper-error", "payload": line}).to_string());
            } else {
                let _ = app.emit_str(EVENT, format!(r#"{{"event":"helper-error","payload":{line}}}"#));
            }
        }
        return;
    };
    let reply = match message.error {
        Some(error) => Err(serde_json::from_str::<String>(error.get()).unwrap_or_else(|_| error.get().to_owned())),
        None => Ok(message.result.map_or_else(|| RawValue::NULL.to_owned(), |r| r.to_owned())),
    };
    if let Some(tx) = pending.lock().unwrap().remove(&id) {
        let _ = tx.send(reply);
    }
}

async fn start(app: &tauri::AppHandle, path: std::path::PathBuf, package_id: Option<String>) -> Result<Running, String> {
    let data_dir = crate::datamap::tauri_map(app, crate::datamap::TauriMap::Data).map_err(|e| e.to_string())?;
    let mut child = Command::new(path)
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("The edition helper could not start: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("The edition helper has no input.")?;
    let stdout = child.stdout.take().ok_or("The edition helper has no output.")?;
    let pending: Pending = Default::default();

    // The writer: the only owner of the helper's input.
    let (queue, mut lines_out) = mpsc::channel::<Outgoing>(QUEUE);
    let writer_pending = pending.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(out) = lines_out.recv().await {
            let sent = async {
                stdin.write_all(&out.line).await?;
                stdin.flush().await
            }
            .await;
            if sent.is_err() {
                // The helper no longer reads: this call and every queued one
                // fail, and the closed queue makes the next call restart it.
                fail(&writer_pending, out.id);
                lines_out.close();
                while let Some(out) = lines_out.recv().await {
                    fail(&writer_pending, out.id);
                }
                break;
            }
        }
    });

    let reader_pending = pending.clone();
    let activity = Arc::new(Activity::new());
    let reader_activity = activity.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            reader_activity.touch();
            dispatch(&app, &reader_pending, line, package_id.as_deref());
        }
        // The helper ended: every call still waiting fails, and the page is
        // told, so work the helper had accepted (and would have answered
        // with events) fails too instead of waiting forever.
        for (_, tx) in reader_pending.lock().unwrap().drain() {
            let _ = tx.send(Err(STOPPED.into()));
        }
        if let Some(package_id) = package_id {
            let _ = app.emit_str("addon-helper", json!({"packageId": package_id, "event": "helper-exit", "payload": null}).to_string());
        } else {
            let _ = app.emit_str(EVENT, r#"{"event":"helper-exit"}"#.to_owned());
        }
    });
    Ok(Running { queue, child, pending, activity })
}

/// Send one call to the edition helper and wait for its answer. Methods
/// under `host.` are the editor's own and cannot be called from the page.
#[tauri::command]
pub async fn edition_helper_call(
    app: tauri::AppHandle,
    state: tauri::State<'_, EditionHelper>,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    idle_ms: Option<u64>,
) -> Result<Box<RawValue>, String> {
    if method.starts_with("host.") {
        return Err(format!("Unknown helper method: {method}"));
    }
    send(&app, &state, None, &method, params.unwrap_or(Value::Null), Limits::from_ms(timeout_ms, idle_ms)).await
}

/// Whether one enabled add-on package has a verified helper. Verifying hashes
/// the helper and its companion files, so it runs on a blocking thread, never
/// on the main (UI) thread a synchronous command would use.
#[tauri::command]
pub async fn addon_helper_available(app: tauri::AppHandle, package_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::package_helper_path(&app, &package_id).is_some())
        .await
        .unwrap_or(false)
}

/// Call the verified helper belonging to one enabled add-on package.

#[tauri::command]
pub async fn addon_helper_call(
    app: tauri::AppHandle,
    state: tauri::State<'_, EditionHelper>,
    package_id: String,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    idle_ms: Option<u64>,
) -> Reply {
    if method.starts_with("host.") { return Err(format!("Unknown helper method: {method}")); }
    send(&app, &state, Some(&package_id), &method, params.unwrap_or(Value::Null), Limits::from_ms(timeout_ms, idle_ms)).await
}

/// Share a file the page may open (one in the editor's file scope) with the
/// helper, so an edition can read it there, for example to upload it.
#[tauri::command]
pub async fn edition_helper_share_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, EditionHelper>,
    path: String,
) -> Result<bool, String> {
    use tauri_plugin_fs::FsExt;
    if !std::path::Path::new(&path).is_absolute() || !app.fs_scope().is_allowed(std::path::Path::new(&path)) {
        return Err("This file is not open in the editor.".into());
    }
    send(&app, &state, None, "host.shareFile", json!({ "path": path }), Limits::default()).await?;
    Ok(true)
}

/// Share an editor-authorized PDF with one enabled package helper. The
/// package's web code must obtain the path through an explicit user action;
/// the file scope itself does not establish which tab is active.
#[tauri::command]
pub async fn addon_helper_share_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, EditionHelper>,
    package_id: String,
    path: String,
) -> Result<String, String> {
    use tauri_plugin_fs::FsExt;
    if package_id.is_empty() || !crate::package_helper_enabled(&app, &package_id) {
        return Err(NO_PACKAGE_HELPER.into());
    }
    let pdf = check_shareable_pdf(std::path::Path::new(&path))?;
    if !app.fs_scope().is_allowed(std::path::Path::new(&path))
        || !app.fs_scope().is_allowed(&pdf)
    {
        return Err("This file is not open in the editor.".into());
    }
    send(&app, &state, Some(&package_id), "host.shareFile", json!({ "path": &pdf }), Limits::default()).await?;
    Ok(pdf.to_string_lossy().into_owned())
}

fn check_shareable_pdf(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::io::Read;
    let invalid = || "Only a regular PDF of at most 250 MiB can be shared.".to_string();
    if !path.is_absolute()
        || !path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err(invalid());
    }
    let metadata = path.symlink_metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > FILE_CAP {
        return Err(invalid());
    }
    let real = dunce::canonicalize(path).map_err(|_| invalid())?;
    let mut magic = [0; 5];
    std::fs::File::open(&real).and_then(|mut file| file.read_exact(&mut magic)).map_err(|_| invalid())?;
    if &magic != b"%PDF-" { return Err(invalid()); }
    Ok(real)
}

async fn send(app: &tauri::AppHandle, state: &EditionHelper, package_id: Option<&str>, method: &str, params: Value, limits: Limits) -> Reply {
    if let Some(package_id) = package_id {
        if !crate::package_helper_enabled(app, package_id) {
            let mut running = state.running.lock().await;
            if let Some(mut old) = running.remove(package_id) { let _ = old.child.start_kill(); }
            return Err(NO_PACKAGE_HELPER.into());
        }
    }
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let mut line = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params })).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let (tx, rx) = oneshot::channel();
    // The lock covers only the liveness check and the registration; the
    // write itself happens in the writer task.
    let (queue, pending, activity) = {
        let mut running = state.running.lock().await;
        let key = package_id.unwrap_or("").to_owned();
        // Start (or restart, after it stopped) the helper.
        let alive = running
            .get_mut(&key)
            .is_some_and(|r| !r.queue.is_closed() && r.child.try_wait().ok().flatten().is_none());
        if !alive {
            let path = match package_id {
                Some(id) => crate::package_helper_path(app, id).ok_or(NO_PACKAGE_HELPER)?,
                None => crate::selected_helper_path(app).ok_or(NO_HELPER)?,
            };
            running.insert(key.clone(), start(app, path, package_id.map(str::to_owned)).await?);
        }
        let helper = running.get(&key).expect("started above");
        helper.pending.lock().unwrap().insert(id, tx);
        (helper.queue.clone(), helper.pending.clone(), helper.activity.clone())
    };
    let started = Instant::now();
    // A full queue counts against the call's limits too.
    let queued = queue.send(Outgoing { id, line });
    let queued = match limits.total {
        Some(total) => tokio::time::timeout(total, queued).await.unwrap_or(Ok(())),
        None => queued.await,
    };
    if queued.is_err() {
        pending.lock().unwrap().remove(&id);
        return Err(STOPPED.into());
    }
    wait_reply(rx, &pending, id, method, limits, &activity, started).await
}

/// Wait for the answer to call `id` within `limits`. On a limit the call's
/// slot is freed (a late answer is dropped) and the call fails.
async fn wait_reply(
    mut rx: oneshot::Receiver<Reply>,
    pending: &Pending,
    id: u64,
    method: &str,
    limits: Limits,
    activity: &Activity,
    started: Instant,
) -> Reply {
    let deadline = limits.total.map(|d| started + d);
    loop {
        let idle_at = limits.idle.map(|d| activity.last().max(started) + d);
        let wake = match (deadline, idle_at) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => return rx.await.map_err(|_| STOPPED.to_string())?,
        };
        tokio::select! {
            reply = &mut rx => return reply.map_err(|_| STOPPED.to_string())?,
            _ = tokio::time::sleep_until(wake.into()) => {}
        }
        let now = Instant::now();
        let failure = match (deadline, limits.total) {
            (Some(at), Some(total)) if now >= at => Some(format!("The edition helper did not answer {method} within {} s.", whole_seconds(total))),
            _ => None,
        };
        let failure = failure.or_else(|| {
            let idle = limits.idle?;
            (now >= activity.last().max(started) + idle)
                .then(|| format!("The edition helper sent nothing for {} s while running {method}.", whole_seconds(idle)))
        });
        let Some(message) = failure else { continue };
        pending.lock().unwrap().remove(&id);
        // An answer that came in just now still counts.
        return match rx.try_recv() {
            Ok(reply) => reply,
            Err(_) => Err(message),
        };
    }
}

const FILE_CAP: u64 = 250 * 1024 * 1024;
const NOT_A_DRAWING: &str = "This is not a downloaded drawing.";

/// Let the page open a drawing the helper downloaded: an existing, direct
/// PDF in the app's own `drawings` folder, nothing else. Saved links are
/// data, so they cannot authorize a path somewhere else.
#[tauri::command]
pub fn edition_allow_drawing(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    use tauri_plugin_fs::FsExt;
    let root = crate::datamap::tauri_map(&app, crate::datamap::TauriMap::Data)
        .map_err(|_| NOT_A_DRAWING.to_string())?
        .join("drawings");
    let pdf = std::path::Path::new(&path);
    check_drawing(&root, pdf)?;
    app.fs_scope().allow_file(pdf).map_err(|_| NOT_A_DRAWING.to_string())?;
    Ok(true)
}

fn check_drawing(root: &std::path::Path, pdf: &std::path::Path) -> Result<(), String> {
    use std::io::Read;
    let fail = || NOT_A_DRAWING.to_string();
    let is_pdf = pdf.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("pdf"));
    if pdf.parent() != Some(root) || !is_pdf {
        return Err(fail());
    }
    let metadata = pdf.symlink_metadata().map_err(|_| fail())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > FILE_CAP {
        return Err(fail());
    }
    let real_root = dunce::canonicalize(root).map_err(|_| fail())?;
    let real_pdf = dunce::canonicalize(pdf).map_err(|_| fail())?;
    if real_pdf.parent() != Some(real_root.as_path()) {
        return Err(fail());
    }
    let mut magic = [0; 5];
    std::fs::File::open(pdf).and_then(|mut f| f.read_exact(&mut magic)).map_err(|_| fail())?;
    if &magic != b"%PDF-" {
        return Err(fail());
    }
    Ok(())
}

#[cfg(test)]
mod share_file_tests {
    use super::{check_shareable_pdf, FILE_CAP};

    #[test]
    fn only_regular_pdfs_are_shareable() {
        let root = std::env::temp_dir().join(format!(
            "oculith-share-file-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        std::fs::create_dir(&root).unwrap();
        let pdf = root.join("drawing.pdf");
        std::fs::write(&pdf, b"%PDF-1.7\n").unwrap();
        assert_eq!(check_shareable_pdf(&pdf).unwrap(), dunce::canonicalize(&pdf).unwrap());
        assert!(check_shareable_pdf(&root).is_err());
        assert!(check_shareable_pdf(&root.join("missing.pdf")).is_err());
        let fake = root.join("fake.pdf");
        std::fs::write(&fake, b"not a pdf").unwrap();
        assert!(check_shareable_pdf(&fake).is_err());
        let large = root.join("large.pdf");
        let file = std::fs::File::create(&large).unwrap();
        file.set_len(FILE_CAP + 1).unwrap();
        drop(file);
        assert!(check_shareable_pdf(&large).is_err());
        #[cfg(unix)] {
            let link = root.join("linked.pdf");
            std::os::unix::fs::symlink(&pdf, &link).unwrap();
            assert!(check_shareable_pdf(&link).is_err());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod limit_tests {
    use super::{wait_reply, Activity, Limits, Pending, Reply};
    use serde_json::value::RawValue;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::oneshot;

    fn call(pending: &Pending, id: u64) -> (oneshot::Sender<Reply>, oneshot::Receiver<Reply>) {
        let (tx, rx) = oneshot::channel();
        // The bridge keeps the sender in `pending`; the test answers through
        // a second channel to keep a handle of its own.
        let (keep, _) = oneshot::channel();
        pending.lock().unwrap().insert(id, keep);
        (tx, rx)
    }

    fn ok() -> Reply { Ok(RawValue::from_string("true".into()).unwrap()) }

    #[test]
    fn limits_take_only_sensible_values() {
        let l = Limits::from_ms(Some(0), Some(25 * 60 * 60 * 1000));
        assert!(l.total.is_none() && l.idle.is_none());
        let l = Limits::from_ms(Some(1500), None);
        assert_eq!(l.total, Some(Duration::from_millis(1500)));
        assert!(Limits::from_ms(None, None).total.is_none());
    }

    #[tokio::test]
    async fn a_call_without_limits_waits_for_its_answer() {
        let pending: Pending = Default::default();
        let (tx, rx) = call(&pending, 1);
        tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(60)).await; let _ = tx.send(ok()); });
        let r = wait_reply(rx, &pending, 1, "m", Limits::default(), &Activity::new(), Instant::now()).await;
        assert_eq!(r.unwrap().get(), "true");
    }

    #[tokio::test]
    async fn a_silent_helper_fails_the_call_at_its_timeout_and_frees_the_slot() {
        let pending: Pending = Default::default();
        let (_tx, rx) = call(&pending, 7);
        let started = Instant::now();
        let r = wait_reply(rx, &pending, 7, "store.status", Limits::from_ms(Some(150), None), &Activity::new(), started).await;
        let waited = started.elapsed();
        assert_eq!(r.unwrap_err(), "The edition helper did not answer store.status within 1 s.");
        assert!(waited >= Duration::from_millis(150) && waited < Duration::from_secs(2), "{waited:?}");
        assert!(pending.lock().unwrap().is_empty(), "a late answer has nowhere to go");
    }

    #[tokio::test]
    async fn helper_lines_keep_an_idle_limited_call_alive_until_they_stop() {
        let pending: Pending = Default::default();
        let activity = Arc::new(Activity::new());
        // Lines every 40 ms for 400 ms keep a 150 ms idle limit from firing.
        let (tx, rx) = call(&pending, 3);
        let a = activity.clone();
        tokio::spawn(async move {
            for _ in 0..10 { tokio::time::sleep(Duration::from_millis(40)).await; a.touch(); }
            let _ = tx.send(ok());
        });
        let started = Instant::now();
        let r = wait_reply(rx, &pending, 3, "events.run", Limits::from_ms(None, Some(150)), &activity, started).await;
        assert_eq!(r.unwrap().get(), "true");
        assert!(started.elapsed() >= Duration::from_millis(380));

        // Then nothing: the same limit ends the next call.
        let (_tx, rx) = call(&pending, 4);
        let started = Instant::now();
        let r = wait_reply(rx, &pending, 4, "events.run", Limits::from_ms(None, Some(150)), &activity, started).await;
        assert_eq!(r.unwrap_err(), "The edition helper sent nothing for 1 s while running events.run.");
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(150) && waited < Duration::from_secs(2), "{waited:?}");
        assert!(!pending.lock().unwrap().contains_key(&4));
    }

    #[tokio::test]
    async fn the_total_limit_holds_even_while_the_helper_writes() {
        let pending: Pending = Default::default();
        let activity = Arc::new(Activity::new());
        let (_tx, rx) = call(&pending, 9);
        let a = activity.clone();
        let busy = tokio::spawn(async move { loop { tokio::time::sleep(Duration::from_millis(20)).await; a.touch(); } });
        let started = Instant::now();
        let r = wait_reply(rx, &pending, 9, "m", Limits::from_ms(Some(200), Some(100)), &activity, started).await;
        busy.abort();
        assert!(r.unwrap_err().contains("did not answer m within"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn an_answer_that_arrives_at_the_limit_still_counts() {
        let pending: Pending = Default::default();
        let (tx, rx) = call(&pending, 5);
        tx.send(ok()).unwrap();
        let r = wait_reply(rx, &pending, 5, "m", Limits::from_ms(Some(1), None), &Activity::new(), Instant::now() - Duration::from_secs(1)).await;
        assert_eq!(r.unwrap().get(), "true");
    }
}
