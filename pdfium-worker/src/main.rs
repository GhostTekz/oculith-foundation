// Release builds: hide the console window so each spawned worker process
// doesn't pop a black terminal next to the Tauri main window. Debug builds
// keep the console so logs are visible during development. Mirrors the
// pattern in open-pdf-studio/src-tauri/src/main.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;
mod render;
mod shm;
mod text;

use anyhow::{Context, Result};
use protocol::{Request, Response};
use render::Renderer;
use shm::Shm;
use std::io::{BufRead, Write};

fn main() {
    let code = match run() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Error: {error:?}");
            1
        }
    };
    exit_without_teardown(code);
}

/// End the process without running the C library's exit handlers.
///
/// Returning from `main` calls `exit()`, which runs every static destructor
/// that libpdfium registered, among them its bundled C++ runtime's iostream
/// teardown (`std::__Cr::DoIOSInit::~DoIOSInit`, which flushes `std::cout`).
/// That destructor crashed workers with SIGSEGV (a call through a null vtable
/// slot of `std::cout`'s stream buffer) when the app stopped and closed their
/// pipe. Nothing in that teardown is needed: the documents and the mapping go
/// with the process, the parent has already removed the shared-memory file,
/// and this process writes its own output through Rust, flushed here.
fn exit_without_teardown(code: i32) -> ! {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    #[cfg(unix)]
    {
        extern "C" {
            fn _exit(status: i32) -> !;
        }
        // Safety: `_exit` ends the process immediately; no Rust state is
        // used afterwards and both output streams were flushed above.
        unsafe { _exit(code) }
    }
    #[cfg(not(unix))]
    std::process::exit(code)
}

fn run() -> Result<()> {
    // Slot is passed as argv[1] (set by the spawner). Default to 0 for
    // standalone testing. Namespace (owning app PID) is argv[2] so multiple
    // app instances don't collide on the same SHM file; default "0".
    let slot: u32 = std::env::args().nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let ns: String = std::env::args().nth(2).unwrap_or_else(|| "0".to_string());

    let mut renderer = Renderer::new().context("init Renderer")?;
    let mut shm_region = Shm::create(&ns, slot).context("init SHM")?;

    // Emit ready message — main process waits for this before
    // sending render requests.
    let ready = Response::Ready {
        op: "ready".to_string(),
        shm_name: format!("pdfium-worker-{}-{}.shm", ns, slot),
        shm_size: shm::SHM_SIZE as u64,
        ocg_visibility: true,
        annot_appearance: true,
        annot_appearance_index: true,
        region_pixel_clip: true,
        page_text: true,
    };
    writeln!(std::io::stdout(), "{}", serde_json::to_string(&ready)?)?;
    std::io::stdout().flush()?;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[worker {}] stdin read error: {}", slot, e);
                break;
            }
        };
        if line.trim().is_empty() { continue; }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[worker {}] bad request: {}", slot, e);
                if let Some(reply) = protocol::reply_to_unparsable(&line, &e.to_string()) {
                    writeln!(stdout, "{}", serde_json::to_string(&reply)?)?;
                    stdout.flush()?;
                }
                continue;
            }
        };

        match req {
            Request::Render { id, path, page_index, scale, rotation, ocg_visibility, annot_appearance, annot_appearance_index } => {
                let show = render::AnnotShow::from_request(annot_appearance.as_deref(), annot_appearance_index.as_deref());
                let resp = match renderer.render(&path, page_index, scale, rotation, &ocg_visibility, show, shm_region.payload_mut()) {
                    Ok(result) => {
                        match shm_region.write_header(result.width, result.height) {
                            Ok(bytes) => Response::RenderOk {
                                id, ok: true,
                                w: result.width, h: result.height,
                                shm_bytes: bytes,
                            },
                            Err(e) => Response::RenderErr {
                                id, ok: false,
                                error: format!("SHM write: {}", e),
                            },
                        }
                    }
                    Err(e) => Response::RenderErr {
                        id, ok: false,
                        error: format!("{}", e),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::RenderRegion {
                id, path, page_index, scale, rotation,
                region_x_pt, region_y_pt, region_w_pt, region_h_pt,
                pixel_clip,
                ocg_visibility, annot_appearance, annot_appearance_index,
            } => {
                let show = render::AnnotShow::from_request(annot_appearance.as_deref(), annot_appearance_index.as_deref());
                let resp = match renderer.render_region_tile(
                    &path, page_index, scale, rotation,
                    region_x_pt, region_y_pt, region_w_pt, region_h_pt,
                    &ocg_visibility, show, shm_region.payload_mut(),
                    pixel_clip,
                ) {
                    Ok(result) => {
                        match shm_region.write_header(result.width, result.height) {
                            Ok(bytes) => Response::RenderOk {
                                id, ok: true,
                                w: result.width, h: result.height,
                                shm_bytes: bytes,
                            },
                            Err(e) => Response::RenderErr {
                                id, ok: false,
                                error: format!("SHM write: {}", e),
                            },
                        }
                    }
                    Err(e) => Response::RenderErr {
                        id, ok: false,
                        error: format!("{}", e),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::PageText { id, path, page_index } => {
                let resp = match renderer.page_text(&path, page_index).and_then(|json| shm_region.write_bytes(&json)) {
                    Ok(bytes) => Response::TextOk { id, ok: true, text_bytes: bytes },
                    Err(e) => Response::RenderErr { id, ok: false, error: format!("{}", e) },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::Trim => {
                renderer.trim();
                return_freed_memory();
            }
            Request::Invalidate { id, path } => {
                renderer.invalidate_path(&path);
                writeln!(stdout, "{}", serde_json::to_string(&Response::InvalidateOk { id, ok: true })?)?;
                stdout.flush()?;
                return_freed_memory();
            }
            Request::Shutdown => {
                eprintln!("[worker {}] shutting down", slot);
                break;
            }
        }
    }

    Ok(())
}

/// Hand what PDFium just freed back to the system. PDFium allocates with the
/// C library's malloc, and glibc keeps freed memory of a long-lived process
/// for reuse: after a closed drawing the worker went on holding its parse,
/// over a gigabyte per worker after a few large sets.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn return_freed_memory() {
    extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    // Safety: malloc_trim only releases free heap memory; no pointers held
    // by this process are affected.
    unsafe {
        malloc_trim(0);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn return_freed_memory() {}
