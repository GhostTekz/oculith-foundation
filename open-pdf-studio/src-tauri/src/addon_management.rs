//! Offline, per-user management of independent packages and of the single
//! full edition package, from a folder or from one add-on file (a zip
//! archive). The editor still chooses and verifies its active package set only
//! when it starts.
use super::{addon_file, addon_manifest_target_compatible, atomic_file, datamap, valid_addon_id,
 bundled_edition_package_dir,
    valid_addon_version, validate_plugin_central_directory, verified_edition_package, verified_package,
    AddonManifest, EnabledAddons, HOST_API_VERSION, MAX_ENABLED_PACKAGES};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static STAGE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    id: String,
    version: String,
    enabled: bool,
    valid: bool,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAddon {
    id: String,
    version: String,
    /// "edition" for the full edition package, "package" for an independent one.
    kind: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionInfo {
    id: String,
    version: String,
    valid: bool,
    /// Shipped inside this installation rather than installed by the user.
    included: bool,
}

const EDITION_DIR: &str = "active";
const EDITION_BACKUP: &str = ".previous-active";
const EDITION_REMOVAL: &str = ".remove-active";
/// Backup name used by the command-line installer; recovered the same way.
const SCRIPT_EDITION_BACKUP: &str = ".previous";
const EDITION_STAGE_PREFIX: &str = ".edition-stage-";
const FILE_STAGE_PREFIX: &str = ".file-stage-";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;
const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NATIVE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARCHIVE_PACKAGES: usize = 16;
const MAX_PATH_DEPTH: usize = 8;

struct Lock { path: PathBuf, file: Option<File> }
impl Drop for Lock {
    fn drop(&mut self) { drop(self.file.take()); let _ = fs::remove_file(&self.path); }
}

fn real_directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err("Add-on path is not a real directory.".into()); }
    Ok(())
}

fn checked_paths(data: &Path) -> Result<(PathBuf, PathBuf), String> {
    if !data.exists() { fs::create_dir_all(data).map_err(|e| e.to_string())?; }
    real_directory(data)?;
    let addons = data.join("addons");
    ensure_directory(&addons)?;
    let packages = addons.join("packages");
    ensure_directory(&packages)?;
    Ok((addons, packages))
}

// Two commands may create the same directory at once (the add-on panel reads
// the package list and the edition together); the second creation is not an error.
fn ensure_directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => real_directory(path),
        Err(e) => Err(e.to_string()),
    }
}

/// How long a lock file without a process number may be in the middle of
/// being written by its owner before it counts as left over.
const UNWRITTEN_LOCK_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

/// The lock is a file created exclusively that holds its owner's process
/// number (the command-line installers use the same file). One left by a
/// process that is gone, after a crash mid-install, is removed and taken over.
fn lock(addons: &Path) -> Result<Lock, String> {
    let path = addons.join(".install.lock");
    let busy = || "Another add-on operation is running. Close the editor and retry after checking the stale lock.".to_string();
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let written = writeln!(file, "{}", std::process::id()).and_then(|()| file.sync_all());
                let lock = Lock { path, file: Some(file) };
                written.map_err(|e| e.to_string())?;
                return Ok(lock);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(stale) = stale_lock_contents(&path) else { return Err(busy()) };
                // Remove only the lock that was judged stale, not one another
                // process has just put in its place.
                if fs::read(&path).ok().as_deref() != Some(stale.as_slice()) {
                    return Err(busy());
                }
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(busy())
}

/// The contents of a lock file whose owner is gone; None while it may be in use.
fn stale_lock_contents(path: &Path) -> Option<Vec<u8>> {
    let contents = fs::read(path).ok()?;
    let pid = std::str::from_utf8(&contents).ok().and_then(|s| s.trim().parse::<u32>().ok());
    match pid {
        Some(pid) if pid != 0 && !process_alive(pid) => Some(contents),
        Some(_) => None,
        // Empty or unreadable: an owner may still be writing its number.
        None => {
            let age = fs::metadata(path).ok()?.modified().ok()?.elapsed().ok()?;
            (age >= UNWRITTEN_LOCK_GRACE).then_some(contents)
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // Signal 0 only checks: EPERM means it exists under another user.
    let signalled = unsafe { libc::kill(pid, 0) } == 0;
    signalled || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // A process we may not query still exists.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        !ok || code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: u32) -> bool {
    true
}

fn read_index(addons: &Path) -> Result<Vec<String>, String> {
    let path = addons.join("enabled.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 {
        return Err("Invalid add-on index. Repair it before changing packages.".into());
    }
    let index: EnabledAddons = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid add-on index. Repair it before changing packages.")?;
    let mut seen = HashSet::new();
    if index.schema_version != 1 || index.ids.len() > MAX_ENABLED_PACKAGES
        || index.ids.iter().any(|id| !valid_addon_id(id) || !seen.insert(id)) {
        return Err("Invalid add-on index. Repair it before changing packages.".into());
    }
    Ok(index.ids)
}

fn write_index(addons: &Path, ids: &[String]) -> Result<(), String> {
    if ids.len() > MAX_ENABLED_PACKAGES { return Err("Too many enabled add-ons.".into()); }
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "schemaVersion": 1, "ids": ids }))
        .map_err(|e| e.to_string())?;
    atomic_file::write(&addons.join("enabled.json"), &bytes).map_err(|e| e.to_string())
}

fn manifest(root: &Path) -> Result<AddonManifest, String> {
    real_directory(root)?;
    let path = addon_file(root, "manifest.json").ok_or("Invalid add-on manifest.")?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() == 0 || meta.len() > 1024 * 1024 { return Err("Invalid add-on manifest.".into()); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid add-on manifest.".into())
}

fn recover_staged(packages: &Path, ids: &[String]) -> Result<(), String> {
    for entry in fs::read_dir(packages).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue; };
        if let Some(id) = name.strip_prefix(".previous-") {
            if !valid_addon_id(id) { return Err("Invalid staged add-on replacement.".into()); }
            real_directory(&entry.path())?;
            let target = packages.join(id);
            if target.exists() {
                // The new package reached its destination. Keep the committed
                // version if backup cleanup was interrupted after the index write.
                real_directory(&target)?;
                let _ = fs::remove_dir_all(entry.path()); // An open helper can delay cleanup on Windows.
            } else {
                // The replacement stopped after moving the old package away.
                fs::rename(entry.path(), target).map_err(|e| e.to_string())?;
            }
        } else if let Some(id) = name.strip_prefix(".remove-") {
            if !valid_addon_id(id) { return Err("Invalid staged add-on removal.".into()); }
            real_directory(&entry.path())?;
            if ids.iter().any(|item| item == id) && !packages.join(id).exists() {
                fs::rename(entry.path(), packages.join(id)).map_err(|e| e.to_string())?;
            } else {
                // A helper held open by the editor may make this retry fail on Windows.
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}

fn with_lock<T>(data: &Path, operation: impl FnOnce(&Path, &Path) -> Result<T, String>) -> Result<T, String> {
    let (addons, packages) = checked_paths(data)?;
    let _lock = lock(&addons)?;
    let ids = read_index(&addons)?;
    recover_staged(&packages, &ids)?;
    recover_edition(&addons)?;
    operation(&addons, &packages)
}

fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Finish or roll back an interrupted edition replacement or removal and drop
/// stale stage directories. Runs under the add-on lock.
fn recover_edition(addons: &Path) -> Result<(), String> {
    let active = addons.join(EDITION_DIR);
    for name in [EDITION_BACKUP, SCRIPT_EDITION_BACKUP] {
        let backup = addons.join(name);
        if !exists(&backup)? { continue; }
        real_directory(&backup)?;
        if exists(&active)? {
            // The replacement reached its destination; only cleanup was interrupted.
            real_directory(&active)?;
            let _ = fs::remove_dir_all(&backup);
        } else {
            fs::rename(&backup, &active).map_err(|e| e.to_string())?;
        }
    }
    let removal = addons.join(EDITION_REMOVAL);
    if exists(&removal)? { real_directory(&removal)?; let _ = fs::remove_dir_all(&removal); }
    for entry in fs::read_dir(addons).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue; };
        if (name.starts_with(EDITION_STAGE_PREFIX) || name.starts_with(FILE_STAGE_PREFIX))
            && real_directory(&entry.path()).is_ok() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn stage_dir(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    let stage = parent.join(format!("{prefix}{}-{}", std::process::id(), STAGE_ID.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    Ok(stage)
}

fn outside_addons(source: &Path, addons: &Path) -> Result<(), String> {
    let source = dunce::canonicalize(source).map_err(|e| e.to_string())?;
    let installed = dunce::canonicalize(addons).map_err(|e| e.to_string())?;
    if source.starts_with(installed) { return Err("Choose a package outside the app's add-ons directory.".into()); }
    Ok(())
}

/// A specific reason when the manifest itself explains a failed verification.
fn incompatibility(package: &AddonManifest, editor_version: &str) -> String {
    if package.editor_version != editor_version {
        let built = if valid_addon_version(&package.editor_version) { package.editor_version.as_str() } else { "another version" };
        return format!("This add-on is built for editor {built}; this editor is {editor_version}.");
    }
    if package.host_api_version != HOST_API_VERSION {
        return "This add-on needs a different add-on interface version.".into();
    }
    if !addon_manifest_target_compatible(package) {
        return "This add-on is built for a different operating system or processor.".into();
    }
    format!("{} failed verification: a file is missing, changed or not allowed.",
        if valid_addon_id(&package.id) { package.id.as_str() } else { "The add-on" })
}

fn installed(package: &AddonManifest) -> InstalledAddon {
    InstalledAddon {
        id: package.id.clone(),
        version: package.version.clone(),
        kind: if package.schema_version == 1 { "edition" } else { "package" },
    }
}

fn list_at(data: &Path, editor_version: &str) -> Result<Vec<PackageInfo>, String> {
    let (addons, packages) = checked_paths(data)?;
    let ids = read_index(&addons)?;
    let mut rows = Vec::new();
    for entry in fs::read_dir(packages).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(id) = name.to_str() else { continue; };
        if !valid_addon_id(id) { continue; }
        let valid = verified_package(&entry.path(), id, editor_version).is_some();
        let version = manifest(&entry.path()).ok().map(|item| item.version)
            .filter(|version| valid_addon_version(version)).unwrap_or_default();
        rows.push(PackageInfo { id: id.to_string(), version, enabled: ids.iter().any(|item| item == id), valid });
        if rows.len() >= 128 { break; }
    }
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(rows)
}

fn install_at(data: &Path, source: &Path, editor_version: &str) -> Result<String, String> {
    let package = manifest(source)?;
    if !valid_addon_id(&package.id) || package.host_api_version != HOST_API_VERSION
        || verified_package(source, &package.id, editor_version).is_none() {
        return Err("The selected folder is not a compatible, verified add-on package.".into());
    }
    with_lock(data, |addons, packages| {
        outside_addons(source, addons)?;
        install_package_locked(addons, packages, &dunce::canonicalize(source).map_err(|e| e.to_string())?,
            &package, editor_version)
    })
}

/// Copy a verified independent package into place. The caller holds the lock.
fn install_package_locked(addons: &Path, packages: &Path, source: &Path, package: &AddonManifest,
    editor_version: &str) -> Result<String, String> {
    let mut ids = read_index(addons)?;
    if !ids.contains(&package.id) && ids.len() >= MAX_ENABLED_PACKAGES { return Err("Too many enabled add-ons.".into()); }
    let stage = stage_dir(packages, ".install-stage-")?;
    let result = (|| {
        for name in std::iter::once("manifest.json").chain(package.files.keys().map(String::as_str)) {
            let from = addon_file(source, name).ok_or("Package changed during installation.")?;
            fs::copy(from, stage.join(name)).map_err(|e| e.to_string())?;
        }
        if verified_package(&stage, &package.id, editor_version).is_none() {
            return Err("Package changed during installation.".into());
        }
        let destination = packages.join(&package.id);
        let backup = packages.join(format!(".previous-{}", package.id));
        if backup.exists() { return Err("A previous package replacement needs recovery.".into()); }
        let old = destination.exists();
        if old { real_directory(&destination)?; fs::rename(&destination, &backup).map_err(|e| e.to_string())?; }
        if let Err(error) = fs::rename(&stage, &destination) {
            if old { let _ = fs::rename(&backup, &destination); }
            return Err(error.to_string());
        }
        if !ids.contains(&package.id) { ids.push(package.id.clone()); }
        if let Err(error) = write_index(addons, &ids) {
            let _ = fs::remove_dir_all(&destination);
            if old { let _ = fs::rename(&backup, &destination); }
            return Err(error);
        }
        if old { let _ = fs::remove_dir_all(backup); }
        Ok(package.id.clone())
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

/// Install-time bounds for a full edition package folder: the loader's rules
/// plus the native file size cap, so a copy cannot fill the disk.
fn edition_sizes_ok(root: &Path, package: &AddonManifest) -> Result<(), String> {
    let mut total = 0u64;
    for name in package.files.keys() {
        let path = addon_file(root, name).ok_or("The edition package is missing a listed file.")?;
        let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
        if size > MAX_NATIVE_FILE_BYTES { return Err(format!("{name} is larger than 128 MiB.")); }
        total += size;
    }
    if total > MAX_EXTRACTED_BYTES { return Err("The edition package is larger than 512 MiB.".into()); }
    Ok(())
}

/// Move a verified, staged edition package into `addons/active`, keeping the
/// previous one as a backup until the new one is in place. Caller holds the lock.
fn swap_edition(addons: &Path, staged: &Path, editor_version: &str) -> Result<(), String> {
    if verified_edition_package(staged, editor_version).is_none() {
        return Err("The edition package changed during installation.".into());
    }
    let active = addons.join(EDITION_DIR);
    let backup = addons.join(EDITION_BACKUP);
    if exists(&backup)? { return Err("A previous edition package replacement needs recovery.".into()); }
    let old = exists(&active)?;
    if old { real_directory(&active)?; fs::rename(&active, &backup).map_err(|e| e.to_string())?; }
    if let Err(error) = fs::rename(staged, &active) {
        if old { let _ = fs::rename(&backup, &active); }
        return Err(error.to_string());
    }
    if old { let _ = fs::remove_dir_all(&backup); } // Retried later if a helper keeps a file open.
    Ok(())
}

fn install_edition_at(data: &Path, source: &Path, editor_version: &str) -> Result<InstalledAddon, String> {
    let package = manifest(source)?;
    if package.schema_version != 1 { return Err("The selected folder is not a full edition package.".into()); }
    if verified_edition_package(source, editor_version).is_none() {
        return Err(incompatibility(&package, editor_version));
    }
    edition_sizes_ok(source, &package)?;
    with_lock(data, |addons, _| {
        outside_addons(source, addons)?;
        let stage = stage_dir(addons, EDITION_STAGE_PREFIX)?;
        let result = (|| {
            for name in std::iter::once("manifest.json").chain(package.files.keys().map(String::as_str)) {
                let from = addon_file(source, name).ok_or("The edition package changed during installation.")?;
                let to = stage.join(name);
                if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                fs::copy(from, &to).map_err(|e| e.to_string())?; // Keeps the executable bit on Unix.
            }
            swap_edition(addons, &stage, editor_version)
        })();
        let _ = fs::remove_dir_all(&stage);
        result.map(|()| installed(&package))
    })
}

fn remove_edition_at(data: &Path) -> Result<bool, String> {
    with_lock(data, |addons, _| {
        let active = addons.join(EDITION_DIR);
        if !exists(&active)? { return Ok(false); }
        real_directory(&active)?;
        let removal = addons.join(EDITION_REMOVAL);
        fs::rename(&active, &removal).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(removal); // Retried by the next operation if a file is still open.
        Ok(true)
    })
}

fn edition_at(data: &Path, editor_version: &str) -> Result<Option<EditionInfo>, String> {
    let (addons, _) = checked_paths(data)?;
    let active = addons.join(EDITION_DIR);
    if !exists(&active)? { return Ok(None); }
    Ok(Some(edition_info(&active, editor_version, false)))
}

fn edition_info(root: &Path, editor_version: &str, included: bool) -> EditionInfo {
    let (id, version) = manifest(root).ok()
        .map(|item| (item.id, item.version))
        .filter(|(id, version)| valid_addon_id(id) && valid_addon_version(version))
        .unwrap_or_default();
    let valid = verified_edition_package(root, editor_version).is_some();
    EditionInfo { id, version, valid, included }
}

/// Route a chosen folder by its manifest: schema 1 is the full edition
/// package, schemas 2-4 are independent packages.
fn install_folder_at(data: &Path, source: &Path, editor_version: &str) -> Result<InstalledAddon, String> {
    let package = manifest(source)?;
    if package.schema_version == 1 { return install_edition_at(data, source, editor_version); }
    install_at(data, source, editor_version)?;
    Ok(installed(&package))
}

/// Check one archive entry name: relative, forward slashes, no `.`/`..`,
/// no drive or control characters, bounded depth and length.
fn archive_entry_name(raw: &str, is_dir: bool) -> Result<String, String> {
    let name = if is_dir { raw.strip_suffix('/').unwrap_or(raw) } else { raw };
    let parts: Vec<&str> = name.split('/').collect();
    if name.is_empty() || name.len() > 1024 || name.starts_with('/') || name.contains('\\') || name.contains(':')
        || name.chars().any(char::is_control) || parts.len() > MAX_PATH_DEPTH
        || parts.iter().any(|part| part.is_empty() || *part == "." || *part == ".." || part.len() > 255) {
        return Err(format!("The add-on file contains an unsafe path: {}", name.chars().take(120).collect::<String>()));
    }
    Ok(name.to_string())
}

fn archive_entry_limit(name: &str) -> u64 {
    match name.rsplit('/').next().unwrap_or(name) {
        "manifest.json" => 1024 * 1024,
        "plugin.js" => 64 * 1024 * 1024,
        "plugin.css" => 16 * 1024 * 1024,
        _ => MAX_NATIVE_FILE_BYTES,
    }
}

/// Extract an add-on file into `stage` without trusting it: no absolute or
/// parent paths, links, special files, encryption or duplicate entries (also
/// differing only in case), bounded entry count, entry size and total size.
/// Returns the extracted file names.
fn extract_archive(archive_path: &Path, stage: &Path) -> Result<BTreeSet<String>, String> {
    use std::io::{Read, Seek};
    let meta = fs::metadata(archive_path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 { return Err("The add-on file is empty or not a file.".into()); }
    if meta.len() > MAX_ARCHIVE_BYTES { return Err("The add-on file is larger than 512 MiB.".into()); }
    let invalid = |_| "The add-on file is not a valid archive.".to_string();
    let archive = zip::ZipArchive::new(File::open(archive_path).map_err(|e| e.to_string())?).map_err(invalid)?;
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("The add-on file has no entries or too many entries.".into());
    }
    // The zip reader keeps only the last entry of a repeated name; check the raw directory.
    let (start, count) = (archive.central_directory_start(), archive.len());
    let mut file = archive.into_inner();
    validate_plugin_central_directory(&mut file, start, count)
        .map_err(|_| "The add-on file has duplicate, hidden or too many entries.".to_string())?;
    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(invalid)?;
    let mut seen = HashSet::new();
    let mut files = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "The add-on file is damaged.".to_string())?;
        let is_dir = entry.is_dir();
        let name = archive_entry_name(entry.name(), is_dir)?;
        if entry.enclosed_name().is_none() { return Err("The add-on file contains an unsafe path.".into()); }
        if entry.encrypted() { return Err("The add-on file contains an encrypted entry.".into()); }
        let mode = entry.unix_mode().unwrap_or(0);
        if entry.is_symlink() || !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000) {
            return Err(format!("The add-on file contains a link or special file: {name}"));
        }
        if !seen.insert(name.to_lowercase()) { return Err(format!("The add-on file repeats an entry: {name}")); }
        let destination = stage.join(&name);
        if is_dir {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            continue;
        }
        let limit = archive_entry_limit(&name);
        let declared = entry.size();
        if declared > limit { return Err(format!("{name} is too large.")); }
        if total + declared > MAX_EXTRACTED_BYTES { return Err("The add-on file expands to more than 512 MiB.".into()); }
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let mut output = OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut entry.take(limit + 1), &mut output)
            .map_err(|_| format!("Could not extract {name} from the add-on file."))?;
        if copied > limit || copied != declared { return Err(format!("{name} does not match its declared size.")); }
        total += copied;
        drop(output);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let mode = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
            fs::set_permissions(&destination, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
        }
        files.insert(name);
    }
    Ok(files)
}

/// The packages in an extracted add-on file: one at its root, or one per
/// top-level directory. Returns each package root with the files found in it.
fn archive_packages(stage: &Path, files: &BTreeSet<String>) -> Result<Vec<(PathBuf, BTreeSet<String>)>, String> {
    if files.contains("manifest.json") { return Ok(vec![(stage.to_path_buf(), files.clone())]); }
    let mut groups: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for name in files {
        let Some((top, rest)) = name.split_once('/') else {
            return Err("The add-on file has loose files next to its package folders.".into());
        };
        groups.entry(top).or_default().insert(rest.to_string());
    }
    if groups.is_empty() { return Err("The add-on file contains no package.".into()); }
    if groups.len() > MAX_ARCHIVE_PACKAGES { return Err("The add-on file contains too many packages.".into()); }
    groups.into_iter().map(|(top, names)| {
        if !names.contains("manifest.json") { return Err(format!("The folder {top} in the add-on file has no manifest.json.")); }
        Ok((stage.join(top), names))
    }).collect()
}

/// Install every package in one add-on file. Everything is extracted and
/// verified before anything is installed; independent packages go first and
/// the full edition package last.
fn install_file_at(data: &Path, archive: &Path, editor_version: &str) -> Result<Vec<InstalledAddon>, String> {
    with_lock(data, |addons, packages| {
        outside_addons(archive, addons)?;
        let stage = stage_dir(addons, FILE_STAGE_PREFIX)?;
        let result = (|| {
            let files = extract_archive(archive, &stage)?;
            let mut plan = Vec::new();
            let mut ids = HashSet::new();
            let mut edition = None;
            for (root, found) in archive_packages(&stage, &files)? {
                let package = manifest(&root)?;
                let listed: BTreeSet<String> = std::iter::once("manifest.json".to_string())
                    .chain(package.files.keys().cloned()).collect();
                if found != listed {
                    return Err(format!("{} has files its manifest does not list, or lacks listed files.",
                        if valid_addon_id(&package.id) { package.id.as_str() } else { "A package" }));
                }
                let verified = if package.schema_version == 1 {
                    verified_edition_package(&root, editor_version).is_some()
                } else {
                    valid_addon_id(&package.id) && verified_package(&root, &package.id, editor_version).is_some()
                };
                if !verified { return Err(incompatibility(&package, editor_version)); }
                if !ids.insert(package.id.clone()) { return Err(format!("The add-on file contains {} twice.", package.id)); }
                if package.schema_version == 1 {
                    if edition.is_some() { return Err("The add-on file contains more than one edition package.".into()); }
                    edition = Some((root, package));
                } else {
                    plan.push((root, package));
                }
            }
            let index = read_index(addons)?;
            let added = plan.iter().filter(|(_, package)| !index.contains(&package.id)).count();
            if index.len() + added > MAX_ENABLED_PACKAGES { return Err("Too many enabled add-ons.".into()); }
            let mut done = Vec::new();
            for (root, package) in &plan {
                install_package_locked(addons, packages, root, package, editor_version)
                    .map_err(|error| partial(error, &done))?;
                done.push(installed(package));
            }
            if let Some((root, package)) = edition {
                swap_edition(addons, &root, editor_version).map_err(|error| partial(error, &done))?;
                done.push(installed(&package));
            }
            Ok(done)
        })();
        let _ = fs::remove_dir_all(&stage);
        result
    })
}

fn partial(error: String, done: &[InstalledAddon]) -> String {
    if done.is_empty() { return error; }
    let ids: Vec<&str> = done.iter().map(|item| item.id.as_str()).collect();
    format!("{error} Already installed from this file: {}.", ids.join(", "))
}

fn set_enabled_at(data: &Path, id: &str, enabled: bool, editor_version: &str) -> Result<(), String> {
    if !valid_addon_id(id) { return Err("Invalid add-on ID.".into()); }
    with_lock(data, |addons, packages| {
        let mut ids = read_index(addons)?;
        if enabled && verified_package(&packages.join(id), id, editor_version).is_none() {
            return Err("This package is missing or incompatible with the editor.".into());
        }
        if enabled {
            if !ids.iter().any(|item| item == id) {
                ids.push(id.to_string());
                write_index(addons, &ids)?;
            }
        } else if ids.iter().any(|item| item == id) {
            ids.retain(|item| item != id);
            write_index(addons, &ids)?;
        }
        Ok(())
    })
}

fn remove_at(data: &Path, id: &str) -> Result<(), String> {
    if !valid_addon_id(id) { return Err("Invalid add-on ID.".into()); }
    with_lock(data, |addons, packages| {
        let target = packages.join(id);
        real_directory(&target)?;
        let staged = packages.join(format!(".remove-{id}"));
        if staged.exists() { return Err("A previous removal is waiting for the editor to close.".into()); }
        fs::rename(&target, &staged).map_err(|e| e.to_string())?;
        let mut ids = read_index(addons)?;
        ids.retain(|item| item != id);
        if let Err(error) = write_index(addons, &ids) {
            let _ = fs::rename(&staged, &target);
            return Err(error);
        }
        let _ = fs::remove_dir_all(staged); // Retried after restart if a helper is still open.
        Ok(())
    })
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    datamap::tauri_map(app, datamap::TauriMap::Data).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn addon_packages_list(app: tauri::AppHandle) -> Result<Vec<PackageInfo>, String> {
    list_at(&app_data(&app)?, &app.package_info().version.to_string())
}

#[tauri::command(async)]
pub fn addon_package_install(app: tauri::AppHandle, source: String) -> Result<String, String> {
    install_at(&app_data(&app)?, Path::new(&source), &app.package_info().version.to_string())
}

#[tauri::command(async)]
pub fn addon_install_folder(app: tauri::AppHandle, source: String) -> Result<InstalledAddon, String> {
    install_folder_at(&app_data(&app)?, Path::new(&source), &app.package_info().version.to_string())
}

#[tauri::command(async)]
pub fn addon_file_install(app: tauri::AppHandle, source: String) -> Result<Vec<InstalledAddon>, String> {
    install_file_at(&app_data(&app)?, Path::new(&source), &app.package_info().version.to_string())
}

#[tauri::command(async)]
pub fn addon_edition_info(app: tauri::AppHandle) -> Result<Option<EditionInfo>, String> {
    let editor_version = app.package_info().version.to_string();
    if let Some(installed) = edition_at(&app_data(&app)?, &editor_version)? { return Ok(Some(installed)); }
    // Without an installed package, the one shipped with this installation (if any) is active.
    Ok(bundled_edition_package_dir(&app)
        .filter(|dir| dir.join("manifest.json").is_file())
        .map(|dir| edition_info(&dir, &editor_version, true)))
}

#[tauri::command(async)]
pub fn addon_edition_remove(app: tauri::AppHandle) -> Result<bool, String> {
    remove_edition_at(&app_data(&app)?)
}

#[tauri::command(async)]
pub fn addon_package_set_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    set_enabled_at(&app_data(&app)?, &id, enabled, &app.package_info().version.to_string())
}

#[tauri::command(async)]
pub fn addon_package_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    remove_at(&app_data(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("addon-manager-{}-{}", std::process::id(), STAGE_ID.fetch_add(1, Ordering::Relaxed)));
        let data = root.join("data");
        let source = root.join("source");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(&source).unwrap();
        let script = b"export function createAddon() { return {}; }";
        fs::write(source.join("plugin.js"), script).unwrap();
        fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 2, "id": "example.tools", "version": "1.0.0", "hostApiVersion": 1,
            "editorVersion": "2026.68.0", "files": { "plugin.js": format!("{:x}", Sha256::digest(script)) }
        })).unwrap()).unwrap();
        (data, source)
    }

    #[test]
    fn simultaneous_first_reads_share_the_new_addons_directory() {
        let (data, _) = fixture();
        let readers: Vec<_> = (0..8).map(|_| {
            let data = data.clone();
            std::thread::spawn(move || checked_paths(&data).map(|_| ()))
        }).collect();
        for reader in readers { assert_eq!(reader.join().unwrap(), Ok(())); }
        assert!(data.join("addons/packages").is_dir());
    }

    #[test]
    fn install_toggle_remove_preserves_other_packages_and_refuses_tampering() {
        let (data, source) = fixture();
        let root = data.parent().unwrap();
        assert_eq!(install_at(&data, &source, "2026.68.0").unwrap(), "example.tools");
        assert_eq!(list_at(&data, "2026.68.0").unwrap().len(), 1);
        assert!(list_at(&data, "2026.68.0").unwrap()[0].enabled);
        set_enabled_at(&data, "example.tools", false, "2026.68.0").unwrap();
        assert!(!list_at(&data, "2026.68.0").unwrap()[0].enabled);
        set_enabled_at(&data, "example.tools", true, "2026.68.0").unwrap();
        fs::write(source.join("plugin.js"), b"tampered").unwrap();
        assert!(install_at(&data, &source, "2026.68.0").is_err());
        assert!(list_at(&data, "2026.68.0").unwrap()[0].valid);
        remove_at(&data, "example.tools").unwrap();
        assert!(list_at(&data, "2026.68.0").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bad_index_and_symlinked_source_cannot_be_installed() {
        let (data, source) = fixture();
        let root = data.parent().unwrap();
        let (addons, _) = checked_paths(&data).unwrap();
        fs::write(addons.join("enabled.json"), b"broken").unwrap();
        assert!(install_at(&data, &source, "2026.68.0").is_err());
        assert!(source.join("plugin.js").is_file());
        fs::remove_file(addons.join("enabled.json")).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::symlink;
            fs::remove_file(source.join("plugin.js")).unwrap();
            symlink(root.join("elsewhere.js"), source.join("plugin.js")).unwrap();
            assert!(install_at(&data, &source, "2026.68.0").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_recovery_keeps_committed_package_and_restores_interrupted_move() {
        let (data, source) = fixture();
        let root = data.parent().unwrap();
        install_at(&data, &source, "2026.68.0").unwrap();
        let (addons, packages) = checked_paths(&data).unwrap();
        let destination = packages.join("example.tools");
        let backup = packages.join(".previous-example.tools");

        fs::rename(&destination, &backup).unwrap();
        recover_staged(&packages, &read_index(&addons).unwrap()).unwrap();
        assert!(destination.join("plugin.js").is_file());
        assert!(!backup.exists());

        fs::rename(&destination, &backup).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("marker"), b"committed new package").unwrap();
        recover_staged(&packages, &read_index(&addons).unwrap()).unwrap();
        assert_eq!(fs::read(destination.join("marker")).unwrap(), b"committed new package");
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn host_target() -> serde_json::Value {
        let os = match std::env::consts::OS { "macos" => "macos", "windows" => "windows", _ => "linux" };
        let arch = match std::env::consts::ARCH { "aarch64" => "arm64", _ => "x64" };
        serde_json::json!({ "os": os, "arch": arch })
    }

    /// A full edition package with a script, a notice in a subfolder and an
    /// executable helper under bin/.
    fn edition_fixture(root: &Path, name: &str, version: &str) -> PathBuf {
        let source = root.join(name);
        fs::create_dir_all(source.join("bin")).unwrap();
        fs::create_dir_all(source.join("notices")).unwrap();
        let files: [(&str, &[u8]); 3] = [
            ("plugin.js", b"export const edition = {};"),
            ("notices/LICENSE-ADDON.txt", b"Example add-on licence"),
            ("bin/helper", b"\x7fELF example helper"),
        ];
        let mut hashes = serde_json::Map::new();
        for (file, bytes) in files {
            fs::write(source.join(file), bytes).unwrap();
            hashes.insert(file.into(), format!("{:x}", Sha256::digest(bytes)).into());
        }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(source.join("bin/helper"), fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "id": "example.edition", "version": version, "hostApiVersion": 1,
            "editorVersion": "2026.68.0", "target": host_target(), "files": hashes, "helper": "bin/helper"
        })).unwrap()).unwrap();
        source
    }

    fn zip_dir(zip: &mut zip::ZipWriter<File>, root: &Path, prefix: &str) {
        let mut names = Vec::new();
        fn walk(dir: &Path, relative: &str, names: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = format!("{relative}{}", entry.file_name().to_str().unwrap());
                if entry.file_type().unwrap().is_dir() { walk(&entry.path(), &format!("{name}/"), names); } else { names.push(name); }
            }
        }
        walk(root, "", &mut names);
        names.sort();
        for name in names {
            let path = root.join(&name);
            #[cfg(unix)] let mode = { use std::os::unix::fs::PermissionsExt; fs::metadata(&path).unwrap().permissions().mode() & 0o777 };
            #[cfg(not(unix))] let mode = 0o644;
            zip.start_file(format!("{prefix}{name}"), zip::write::SimpleFileOptions::default().unix_permissions(mode)).unwrap();
            zip.write_all(&fs::read(path).unwrap()).unwrap();
        }
    }

    fn archive_of(path: &Path, dirs: &[(&Path, &str)], extra: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (dir, prefix) in dirs { zip_dir(&mut zip, dir, prefix); }
        for (name, bytes) in extra {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// Entries in `addons/` other than the expected durable ones.
    fn addons_residue(data: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(data.join("addons")).unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| !matches!(name.as_str(), "active" | "packages" | "enabled.json"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn edition_folder_install_replace_and_remove() {
        let (data, _) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let first = edition_fixture(&root, "edition-1", "1.0.0");
        let installed = install_edition_at(&data, &first, "2026.68.0").unwrap();
        assert_eq!(installed, InstalledAddon { id: "example.edition".into(), version: "1.0.0".into(), kind: "edition" });
        let active = data.join("addons").join("active");
        assert!(verified_edition_package(&active, "2026.68.0").is_some());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(active.join("bin/helper")).unwrap().permissions().mode() & 0o111, 0);
        }
        let info = edition_at(&data, "2026.68.0").unwrap().unwrap();
        assert_eq!((info.id.as_str(), info.version.as_str(), info.valid), ("example.edition", "1.0.0", true));
        assert!(!edition_at(&data, "2026.69.0").unwrap().unwrap().valid);

        let second = edition_fixture(&root, "edition-2", "2.0.0");
        install_folder_at(&data, &second, "2026.68.0").unwrap();
        assert_eq!(edition_at(&data, "2026.68.0").unwrap().unwrap().version, "2.0.0");
        assert!(addons_residue(&data).is_empty(), "{:?}", addons_residue(&data));

        // A changed file or another editor version never replaces the working package.
        fs::write(first.join("plugin.js"), b"tampered").unwrap();
        assert!(install_edition_at(&data, &first, "2026.68.0").is_err());
        let error = install_edition_at(&data, &second, "2026.69.0").unwrap_err();
        assert!(error.contains("built for editor 2026.68.0"), "{error}");
        assert!(install_edition_at(&data, &active, "2026.68.0").is_err(), "installed copy is not a source");
        assert_eq!(edition_at(&data, "2026.68.0").unwrap().unwrap().version, "2.0.0");

        assert!(remove_edition_at(&data).unwrap());
        assert!(edition_at(&data, "2026.68.0").unwrap().is_none());
        assert!(!remove_edition_at(&data).unwrap());
        assert!(addons_residue(&data).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edition_recovery_restores_interrupted_swap_and_clears_stale_stages() {
        let (data, _) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        install_edition_at(&data, &edition_fixture(&root, "edition", "1.0.0"), "2026.68.0").unwrap();
        let addons = data.join("addons");
        fs::rename(addons.join("active"), addons.join(EDITION_BACKUP)).unwrap();
        fs::create_dir(addons.join(".file-stage-1-1")).unwrap();
        with_lock(&data, |_, _| Ok(())).unwrap();
        assert!(edition_at(&data, "2026.68.0").unwrap().unwrap().valid);
        assert!(addons_residue(&data).is_empty(), "{:?}", addons_residue(&data));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_lock_of_a_running_process_blocks_and_a_fresh_empty_one_too() {
        let (data, _) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let (addons, _) = checked_paths(&data).unwrap();
        let lock_path = addons.join(".install.lock");
        fs::write(&lock_path, format!("{}\n", std::process::id())).unwrap();
        assert!(with_lock(&data, |_, _| Ok(())).is_err());
        fs::write(&lock_path, b"").unwrap();
        assert!(with_lock(&data, |_, _| Ok(())).is_err());
        assert!(lock_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_left_by_a_process_that_is_gone_is_taken_over() {
        let (data, _) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let (addons, _) = checked_paths(&data).unwrap();
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let gone = child.id();
        child.wait().unwrap();
        let lock_path = addons.join(".install.lock");
        fs::write(&lock_path, format!("{gone}\n")).unwrap();
        with_lock(&data, |_, _| {
            assert_eq!(fs::read_to_string(&lock_path).unwrap().trim(), std::process::id().to_string());
            Ok(())
        }).unwrap();
        assert!(!lock_path.exists());
        // An old lock without a process number is left over as well.
        fs::write(&lock_path, b"").unwrap();
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        OpenOptions::new().write(true).open(&lock_path).unwrap().set_modified(long_ago).unwrap();
        with_lock(&data, |_, _| Ok(())).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_install_routes_by_schema() {
        let (data, source) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let package = install_folder_at(&data, &source, "2026.68.0").unwrap();
        assert_eq!(package.kind, "package");
        let edition = install_folder_at(&data, &edition_fixture(&root, "edition", "1.0.0"), "2026.68.0").unwrap();
        assert_eq!(edition.kind, "edition");
        assert_eq!(list_at(&data, "2026.68.0").unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_on_file_installs_one_package_or_several_folders() {
        let (data, source) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let edition = edition_fixture(&root, "edition", "1.0.0");
        let single = root.join("single.ocaddon");
        archive_of(&single, &[(edition.as_path(), "")], &[]);
        let summary = install_file_at(&data, &single, "2026.68.0").unwrap();
        assert_eq!(summary, vec![InstalledAddon { id: "example.edition".into(), version: "1.0.0".into(), kind: "edition" }]);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(data.join("addons/active/bin/helper")).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "executable bit survives the archive");
        }

        let edition2 = edition_fixture(&root, "edition-2", "2.0.0");
        let several = root.join("several.zip");
        archive_of(&several, &[(edition2.as_path(), "example.edition/"), (source.as_path(), "example.tools/")], &[]);
        let summary = install_file_at(&data, &several, "2026.68.0").unwrap();
        assert_eq!(summary.iter().map(|item| (item.id.as_str(), item.kind)).collect::<Vec<_>>(),
            [("example.tools", "package"), ("example.edition", "edition")]);
        assert_eq!(edition_at(&data, "2026.68.0").unwrap().unwrap().version, "2.0.0");
        assert!(list_at(&data, "2026.68.0").unwrap()[0].enabled);
        assert!(addons_residue(&data).is_empty(), "{:?}", addons_residue(&data));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_on_file_rejects_unsafe_or_inconsistent_archives_without_changes() {
        let (data, source) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let edition = edition_fixture(&root, "edition", "1.0.0");
        install_edition_at(&data, &edition, "2026.68.0").unwrap();
        let options = zip::write::SimpleFileOptions::default();
        let cases: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
            ("parent path", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "")], &[("../escape.txt", b"x")]))),
            ("absolute path", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "")], &[("/escape.txt", b"x")]))),
            ("drive path", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "")], &[("C:/escape.txt", b"x")]))),
            ("unlisted file", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "")], &[("extra.js", b"x")]))),
            ("case duplicate", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "")], &[("PLUGIN.js", b"x")]))),
            ("loose file", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "one/")], &[("readme.txt", b"x")]))),
            ("folder without manifest", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "one/")], &[("two/plugin.js", b"x")]))),
            ("same package twice", Box::new(|path: &Path| archive_of(path, &[(source.as_path(), "one/"), (source.as_path(), "two/")], &[]))),
            ("symlink", Box::new(|path: &Path| {
                let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
                zip_dir(&mut zip, &source, "");
                zip.add_symlink("link.js", "/etc/passwd", options).unwrap();
                zip.finish().unwrap();
            })),
            ("too many entries", Box::new(|path: &Path| {
                let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
                for index in 0..=MAX_ARCHIVE_ENTRIES { zip.start_file(format!("f{index}"), options).unwrap(); }
                zip.finish().unwrap();
            })),
            ("oversized manifest", Box::new(|path: &Path| {
                let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
                zip.start_file("manifest.json", options.compression_method(zip::CompressionMethod::Deflated)).unwrap();
                zip.write_all(&vec![b' '; 1024 * 1024 + 1]).unwrap();
                zip.finish().unwrap();
            })),
            ("not an archive", Box::new(|path: &Path| fs::write(path, b"not a zip").unwrap())),
        ];
        for (label, build) in cases {
            let path = root.join(format!("{}.ocaddon", label.replace(' ', "-")));
            build(&path);
            let expected = match label {
                "parent path" | "absolute path" | "drive path" => "unsafe path",
                "unlisted file" => "does not list",
                "case duplicate" => "repeats an entry",
                "loose file" => "loose files",
                "folder without manifest" => "has no manifest.json",
                "same package twice" => "twice",
                "symlink" => "link or special file",
                "too many entries" => "too many entries",
                "oversized manifest" => "too large",
                _ => "not a valid archive",
            };
            let error = install_file_at(&data, &path, "2026.68.0").expect_err(label);
            assert!(error.contains(expected), "{label}: {error}");
            assert!(list_at(&data, "2026.68.0").unwrap().is_empty(), "{label} installed a package");
            assert!(edition_at(&data, "2026.68.0").unwrap().unwrap().valid, "{label} changed the edition package");
            assert!(addons_residue(&data).is_empty(), "{label} left {:?}", addons_residue(&data));
        }
        assert!(!root.join("escape.txt").exists() && !data.join("escape.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_on_file_rejects_raw_duplicate_entries() {
        let (data, source) = fixture();
        let root = data.parent().unwrap().to_path_buf();
        let path = root.join("duplicate.ocaddon");
        archive_of(&path, &[(source.as_path(), "")], &[("plugin.xx", b"other")]);
        // The zip writer refuses repeated names, so rename an entry in place.
        let mut bytes = fs::read(&path).unwrap();
        let mut replaced = 0;
        for index in 0..=bytes.len() - 9 {
            if &bytes[index..index + 9] == b"plugin.xx" { bytes[index..index + 9].copy_from_slice(b"plugin.js"); replaced += 1; }
        }
        assert!(replaced >= 2);
        fs::write(&path, bytes).unwrap();
        let error = install_file_at(&data, &path, "2026.68.0").unwrap_err();
        assert!(error.contains("duplicate"), "{error}");
        assert!(addons_residue(&data).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    /// End-to-end check of a real add-on file. Run with
    /// `ADDON_FILE_E2E=/path/to/file.ocaddon cargo test --lib -- --ignored add_on_file_e2e`.
    #[test]
    #[ignore]
    fn add_on_file_e2e() {
        let archive = PathBuf::from(std::env::var("ADDON_FILE_E2E").expect("ADDON_FILE_E2E"));
        let version = std::env::var("ADDON_FILE_E2E_EDITOR").unwrap_or_else(|_| "2026.68.0".into());
        let data = std::env::temp_dir().join(format!("addon-file-e2e-{}", std::process::id()));
        fs::create_dir_all(&data).unwrap();
        let summary = install_file_at(&data, &archive, &version).unwrap();
        eprintln!("installed: {summary:?}");
        let edition = edition_at(&data, &version).unwrap();
        if let Some(info) = &edition { eprintln!("edition: {} {} valid={}", info.id, info.version, info.valid); assert!(info.valid); }
        assert!(addons_residue(&data).is_empty());
        // Installing the same file again replaces it cleanly.
        assert_eq!(install_file_at(&data, &archive, &version).unwrap(), summary);
        if edition.is_some() { assert!(remove_edition_at(&data).unwrap()); }
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn redundant_enable_preserves_package_order() {
        let (data, source) = fixture();
        let root = data.parent().unwrap();
        install_at(&data, &source, "2026.68.0").unwrap();
        let second = root.join("second");
        fs::create_dir(&second).unwrap();
        fs::copy(source.join("plugin.js"), second.join("plugin.js")).unwrap();
        let mut second_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join("manifest.json")).unwrap()).unwrap();
        second_manifest["id"] = "second.tools".into();
        fs::write(second.join("manifest.json"), serde_json::to_vec(&second_manifest).unwrap()).unwrap();
        install_at(&data, &second, "2026.68.0").unwrap();
        let (addons, _) = checked_paths(&data).unwrap();
        let original = read_index(&addons).unwrap();
        assert_eq!(original, ["example.tools", "second.tools"]);
        set_enabled_at(&data, "example.tools", true, "2026.68.0").unwrap();
        assert_eq!(read_index(&addons).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }
}
