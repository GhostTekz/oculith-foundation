// Open the user's default mail client with a PDF attached. This only opens a
// draft — the user reviews and sends it; the app never sends mail autonomously.
//
// Windows : Simple MAPI (MAPISendMail) — works with the default MAPI client.
// Linux   : xdg-email --attach.
// macOS   : Mail.app via osascript.

#[tauri::command]
pub async fn email_pdf(path: String, subject: Option<String>) -> Result<(), String> {
    let subject = subject.unwrap_or_default();
    // MAPISendMail is blocking (it shows the client's compose window), so run
    // it off the async runtime.
    tokio::task::spawn_blocking(move || email_impl(&path, &subject))
        .await
        .map_err(|e| format!("email task failed: {e}"))?
}

#[cfg(target_os = "windows")]
fn email_impl(path: &str, subject: &str) -> Result<(), String> {
    use std::ffi::CString;
    use std::path::Path;
    use std::os::raw::{c_char, c_void};

    // Simple MAPI structs (ANSI). Layout must match mapi.h exactly.
    #[repr(C)]
    struct MapiFileDesc {
        reserved: u32,
        flags: u32,
        position: u32,
        path_name: *const c_char,
        file_name: *const c_char,
        file_type: *mut c_void,
    }
    #[repr(C)]
    struct MapiMessage {
        reserved: u32,
        subject: *const c_char,
        note_text: *const c_char,
        message_type: *const c_char,
        date_received: *const c_char,
        conversation_id: *const c_char,
        flags: u32,
        originator: *mut c_void,
        recip_count: u32,
        recips: *mut c_void,
        file_count: u32,
        files: *const MapiFileDesc,
    }
    // raw-dylib: MSVC's mapi32.lib exporteert MAPISendMail niet (mingw's
    // libmapi32.a wel — daarom linkte de GNU-build lokaal en faalde CI/MSVC
    // met LNK2019 __imp_MAPISendMail). raw-dylib genereert de import
    // rechtstreeks, zonder import-library, op beide toolchains.
    #[link(name = "mapi32", kind = "raw-dylib")]
    extern "system" {
        fn MAPISendMail(
            session: usize,
            ui_param: usize,
            message: *const MapiMessage,
            flags: u32,
            reserved: u32,
        ) -> u32;
    }
    const MAPI_LOGON_UI: u32 = 0x0000_0001;
    const MAPI_DIALOG: u32 = 0x0000_0008;
    const SUCCESS_SUCCESS: u32 = 0;
    const MAPI_USER_ABORT: u32 = 1;

    let file_name = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document.pdf");
    let c_path = CString::new(path).map_err(|e| e.to_string())?;
    let c_file = CString::new(file_name).map_err(|e| e.to_string())?;
    let c_subject = CString::new(subject).map_err(|e| e.to_string())?;

    let file = MapiFileDesc {
        reserved: 0,
        flags: 0,
        position: u32::MAX, // not embedded at a character position
        path_name: c_path.as_ptr(),
        file_name: c_file.as_ptr(),
        file_type: std::ptr::null_mut(),
    };
    let message = MapiMessage {
        reserved: 0,
        subject: c_subject.as_ptr(),
        note_text: std::ptr::null(),
        message_type: std::ptr::null(),
        date_received: std::ptr::null(),
        conversation_id: std::ptr::null(),
        flags: 0,
        originator: std::ptr::null_mut(),
        recip_count: 0,
        recips: std::ptr::null_mut(),
        file_count: 1,
        files: &file,
    };

    let r = unsafe { MAPISendMail(0, 0, &message, MAPI_LOGON_UI | MAPI_DIALOG, 0) };
    if r == SUCCESS_SUCCESS || r == MAPI_USER_ABORT {
        Ok(())
    } else {
        Err(format!(
            "No default email program found (MAPI code {r}). Set up a MAPI mail client (e.g. Outlook/Thunderbird)."
        ))
    }
}

#[cfg(target_os = "linux")]
fn email_impl(path: &str, subject: &str) -> Result<(), String> {
    std::process::Command::new("xdg-email")
        .arg("--subject")
        .arg(subject)
        .arg("--attach")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-email is not available: {e}"))
}

/// The Mail script and its arguments. The subject and path travel as
/// osascript arguments (`on run argv`), never inside the script text, so no
/// quote or backslash in them can end a string and run as AppleScript. Each
/// carries a one-letter prefix so a value that starts with `-` is never read
/// as an osascript option; the script strips it.
#[cfg(any(target_os = "macos", test))]
fn mail_script_args(path: &str, subject: &str) -> Vec<String> {
    let script = "on run argv\n\
         set theSubject to \"\"\n\
         if (length of (item 1 of argv)) > 1 then set theSubject to text 2 thru -1 of (item 1 of argv)\n\
         set thePath to text 2 thru -1 of (item 2 of argv)\n\
         tell application \"Mail\"\n\
         set newMsg to make new outgoing message with properties {subject:theSubject, visible:true}\n\
         tell newMsg to make new attachment with properties {file name:(POSIX file thePath)}\n\
         activate\n\
         end tell\n\
         end run";
    vec!["-e".into(), script.into(), format!("s{subject}"), format!("p{path}")]
}

#[cfg(target_os = "macos")]
fn email_impl(path: &str, subject: &str) -> Result<(), String> {
    std::process::Command::new("osascript")
        .args(mail_script_args(path, subject))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the mail client: {e}"))
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn email_impl(_path: &str, _subject: &str) -> Result<(), String> {
    Err("Email is not supported on this platform.".to_string())
}

#[cfg(test)]
mod tests {
    use super::mail_script_args;

    #[test]
    fn mail_values_are_arguments_not_script_text() {
        let subject = "x\\\" & do shell script \"touch /tmp/pwned\" & \"";
        let path = "/tmp/a\\\".pdf";
        let args = mail_script_args(path, subject);
        assert_eq!(args[0], "-e");
        assert!(!args[1].contains("pwned") && !args[1].contains("a\\"));
        assert_eq!(args[2], format!("s{subject}"));
        assert_eq!(args[3], format!("p{path}"));
        // Neither value can be taken for an osascript option.
        assert!(!mail_script_args("-x", "-e").iter().skip(2).any(|a| a.starts_with('-')));
    }
}
