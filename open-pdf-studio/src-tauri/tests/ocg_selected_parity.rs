//! Selected OCG pixels must agree between the worker and in-process fallback.
//! Run after `cargo build -p pdfium-worker` on Linux.
#[path = "../../../pdfium-worker/tests/support/ocg_fixture.rs"]
mod ocg_fixture;

use app_lib::pdfium_renderer::{
    get_or_load_pdfium_doc_for_render, init_pdfium, render_page_region_to_rgba,
    render_page_to_rgba, render_thumbnail_to_json, PdfiumDocCache, PixmapCacheState,
};
use app_lib::worker_pool::{spawn::spawn_pool, WorkerPool};
use ocg_render_copy::{render_copy, LayerVisibility};
use base64::Engine;
use std::sync::Arc;

fn blue_pixel(rgba: &[u8], width: usize, x: usize, y: usize) -> &[u8] {
    let offset = (y * width + x) * 4;
    &rgba[offset..offset + 4]
}

#[tokio::test]
async fn selected_ocg_full_and_region_match_fallback_without_touching_source() {
    if !cfg!(target_os = "linux") {
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let lib_dir = root.join("open-pdf-studio/src-tauri/binaries/linux-x64");
    let worker_exe = root.join("target/debug/pdfium-worker");
    if !lib_dir.join("libpdfium.so").exists() || !worker_exe.exists() {
        eprintln!("Skipping: bundled Linux PDFium or built worker unavailable");
        return;
    }
    init_pdfium(&lib_dir).unwrap();
    let source = ocg_fixture::ocg_fixture();
    let path = std::env::temp_dir().join(format!("ocg-tauri-parity-{}.pdf", std::process::id()));
    std::fs::write(&path, &source).unwrap();
    let old_dir = std::env::current_dir().unwrap();
    std::env::set_current_dir(&lib_dir).unwrap();
    let workers = spawn_pool(1, &worker_exe).await.unwrap();
    std::env::set_current_dir(old_dir).unwrap();
    let pool = WorkerPool::new(workers);
    assert!(pool.is_ready());
    let cache = PdfiumDocCache::default();
    let pixmaps = PixmapCacheState::default();
    let path_str = path.to_str().unwrap();

    for (label, visibility, expected_blue) in [
        ("default", vec![], false),
        (
            "ON",
            vec![LayerVisibility {
                object_number: 6,
                generation: 0,
                visible: true,
            }],
            true,
        ),
        (
            "OFF",
            vec![LayerVisibility {
                object_number: 6,
                generation: 0,
                visible: false,
            }],
            false,
        ),
    ] {
        let full = pool.render(path_str, 0, 1.0, 0, &visibility).await.unwrap();
        let (ww, wh, worker_full) = (full.width, full.height, full.rgba().to_vec());
        let bytes = if visibility.is_empty() {
            source.clone()
        } else {
            render_copy(&source, &visibility).unwrap()
        };
        let generation = if visibility.is_empty() {
            pixmaps.snapshot_generation(path_str)
        } else {
            None
        };
        let handle = get_or_load_pdfium_doc_for_render(
            path_str,
            Arc::new(bytes),
            &cache,
            &pixmaps,
            generation,
        )
        .unwrap();
        let (fw, fh, fallback_full) = render_page_to_rgba(handle.document(), 0, 1.0, 0).unwrap();
        assert_eq!((ww, wh), (fw, fh), "{label} full dimensions");
        assert_eq!(worker_full, fallback_full, "{label} full pixels");
        let blue = blue_pixel(&worker_full, ww as usize, 75, 75);
        if expected_blue {
            assert!(blue[2] > 200 && blue[0] < 50, "{label} blue pixel {blue:?}");
        } else {
            assert!(
                blue[..3].iter().all(|part| *part > 200),
                "{label} white pixel {blue:?}"
            );
        }

        // The thumbnail command uses this same PDFium renderer and width scale.
        // Its JPEG pixel must agree with the worker's selected full-page pixel,
        // allowing for lossy encoding at quality 75.
        let thumbnail = render_thumbnail_to_json(handle.document(), 0, 100, 0).unwrap();
        let thumbnail: serde_json::Value = serde_json::from_str(&thumbnail).unwrap();
        assert_eq!(thumbnail["width"].as_u64(), Some(ww as u64));
        assert_eq!(thumbnail["height"].as_u64(), Some(wh as u64));
        let data_url = thumbnail["dataURL"].as_str().unwrap();
        let jpeg = base64::engine::general_purpose::STANDARD
            .decode(data_url.strip_prefix("data:image/jpeg;base64,").unwrap()).unwrap();
        let rgb = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
            .unwrap().to_rgb8();
        let thumb_blue = rgb.get_pixel(75, 75).0;
        if expected_blue {
            assert!(thumb_blue[2] > 180 && thumb_blue[0] < 70,
                "{label} thumbnail blue pixel {thumb_blue:?}");
        } else {
            assert!(thumb_blue.iter().all(|part| *part > 180),
                "{label} thumbnail white pixel {thumb_blue:?}");
        }

        let region = pool
            .render_region(
                path_str,
                0,
                1.0,
                0,
                50.0,
                50.0,
                50.0,
                50.0,
                false,
                &visibility,
            )
            .await
            .unwrap();
        let (rw, rh, worker_region) = (region.width, region.height, region.rgba().to_vec());
        let (frw, frh, fallback_region) =
            render_page_region_to_rgba(handle.document(), 0, 1.0, 0, 50.0, 50.0, 50.0, 50.0)
                .unwrap();
        assert_eq!((rw, rh), (frw, frh), "{label} region dimensions");
        assert_eq!(worker_region, fallback_region, "{label} region pixels");
        assert_eq!(
            blue_pixel(&worker_region, rw as usize, 25, 25)[..3],
            blue[..3]
        );
        if !visibility.is_empty() {
            assert_eq!(
                cache.0.lock().unwrap().len(),
                1,
                "selected fallback must not enter the default document cache"
            );
        }
    }
    assert_eq!(std::fs::read(&path).unwrap(), source);
    if let Some(child) = pool.workers[0].child.lock().await.as_mut() {
        let _ = child.kill().await;
    }
    std::fs::remove_file(path).unwrap();
}
