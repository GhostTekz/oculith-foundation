//! A region rendered in `pixel_clip` tiles and stitched together must match
//! the same region rendered whole: the app stitches oversized regions this
//! way, and an offset or rounding error would show as a seam.
//!
//! PDFium's rasterizer depends slightly on the bitmap's clip box: antialiased
//! edges of paths, glyphs and images rendered into a smaller bitmap differ by
//! one or two levels per channel even with the identical transform (the
//! first strip below starts at the region origin). So the stitched result
//! is held to that bound, and to exact equality where the clip is the whole
//! region. Column edges through text differ by far more in PDFium (a glyph
//! cut by the bitmap's left or right edge is rendered differently), which is
//! why the app tiles in full-width strips. Run with:
//! `cargo test -p pdfium-worker --test region_pixel_clip -- --nocapture`

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// 400×300 pt page with antialiased paths (diagonals, a curve, thin lines),
/// text in a standard font and an upscaled 4×4 RGB image XObject, so edges,
/// glyphs and image samples cross every tile boundary.
fn fixture() -> Vec<u8> {
    let content = concat!(
        "1 1 0.9 rg 0 0 400 300 re f\n",
        "0.1 0.3 0.8 RG 1.3 w 10 10 m 390 290 l S\n",
        "0.8 0.1 0.1 RG 0.4 w 10 290 m 390 13 l S\n",
        "0 0.6 0.2 rg 200 150 m 260 230 330 90 380 160 c 300 40 l h f\n",
        "0 0 0 RG 0.25 w 33.3 0 m 33.3 300 l S 0 101.7 m 400 101.7 l S\n",
        "q 97.3 0 0 61.9 41.7 181.2 cm /Im1 Do Q\n",
        "q 0 0 0 rg BT /F1 23.7 Tf 1 0 0 1 61.3 47.9 Tm (Tiles 0123 Wg) Tj ET Q\n",
        "q 0.2 0.2 0.2 rg BT /F1 7.1 Tf 0.96 0.28 -0.28 0.96 230.4 250.6 Tm (rotated small text) Tj ET Q\n",
    );
    // 4×4 RGB pixels, hex-encoded so the fixture stays plain text.
    let image = "ff0000 00ff00 0000ff ffffff \
                 000000 ffff00 00ffff ff00ff \
                 808080 c04020 2040c0 40c020 \
                 102030 f0e0d0 7f7f00 007f7f>";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R \
           /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>"
            .to_string(),
        format!("<< /Length {} >>\nstream\n{}endstream", content.len(), content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!(
            "<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB \
             /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length {} >>\nstream\n{}\nendstream",
            image.len(),
            image
        ),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
    );
    pdf
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    shm: std::path::PathBuf,
    next_id: u64,
}

impl Worker {
    fn start(lib_dir: &std::path::Path, unique: &str, slot: u32) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pdfium-worker"))
            .arg(slot.to_string())
            .arg(unique)
            .current_dir(lib_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["op"], "ready", "worker did not start: {line}");
        assert_eq!(ready["region_pixel_clip"], true, "worker must advertise pixel clipping");
        let shm = std::env::temp_dir().join(format!("pdfium-worker-{unique}-{slot}.shm"));
        Self { child, stdin, stdout, shm, next_id: 1 }
    }

    /// One region exchange; returns (w, h, RGBA) or the worker's error.
    fn region(&mut self, request: &serde_json::Value) -> Result<(u32, u32, Vec<u8>), String> {
        let mut request = request.clone();
        request["id"] = self.next_id.into();
        self.next_id += 1;
        writeln!(self.stdin, "{request}").unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        let response: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], request["id"]);
        if response["ok"] != true {
            return Err(response["error"].as_str().unwrap_or_default().to_string());
        }
        let mut file = std::fs::File::open(&self.shm).unwrap();
        file.seek(SeekFrom::Start(32)).unwrap();
        let mut rgba = vec![0; response["shm_bytes"].as_u64().unwrap() as usize];
        file.read_exact(&mut rgba).unwrap();
        Ok((response["w"].as_u64().unwrap() as u32, response["h"].as_u64().unwrap() as u32, rgba))
    }

    fn stop(mut self) {
        let _ = writeln!(self.stdin, "{}", serde_json::json!({"op": "shutdown"}));
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.shm);
    }
}

/// Split `width` x `height` into a grid with the given column and row edges.
fn grid(xs: &[u32], ys: &[u32]) -> Vec<[u32; 4]> {
    let mut tiles = Vec::new();
    for row in ys.windows(2) {
        for col in xs.windows(2) {
            tiles.push([col[0], row[0], col[1] - col[0], row[1] - row[0]]);
        }
    }
    tiles
}

#[test]
fn pixel_clip_strips_stitch_to_the_whole_region() {
    if !cfg!(target_os = "linux") {
        eprintln!("Skipping: only the bundled Linux runtime is characterized");
        return;
    }
    let lib_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../open-pdf-studio/src-tauri/binaries/linux-x64");
    if !lib_dir.join("libpdfium.so").exists() {
        eprintln!("Skipping: Linux PDFium runtime unavailable");
        return;
    }
    let unique = format!(
        "region-pixel-clip-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    );
    let pdf_path = std::env::temp_dir().join(format!("{unique}.pdf"));
    std::fs::write(&pdf_path, fixture()).unwrap();
    let mut worker = Worker::start(&lib_dir, &unique, 96);

    // A fractional origin and a scale whose products are not whole pixels.
    let scale = 1.37_f32;
    let (region_x, region_y, region_w, region_h) = (13.37_f32, 7.81_f32, 351.9_f32, 271.3_f32);
    let base = serde_json::json!({
        "op": "render_region", "path": pdf_path,
        "page_index": 0, "scale": scale, "rotation": 0,
        "region_x_pt": region_x, "region_y_pt": region_y,
        "region_w_pt": region_w, "region_h_pt": region_h,
    });
    let (width, height, whole) = worker.region(&base).unwrap();
    assert_eq!(width, (region_w * scale).ceil() as u32);
    assert_eq!(height, (region_h * scale).ceil() as u32);
    // The fixture must actually put varied content in the region.
    let distinct: std::collections::HashSet<&[u8]> = (0..whole.len()).step_by(4).map(|i| &whole[i..i + 4]).collect();
    assert!(distinct.len() > 100, "fixture renders too few colours ({})", distinct.len());

    let (w, h) = (width, height);
    let clip = |worker: &mut Worker, [x, y, tw, th]: [u32; 4]| {
        let mut request = base.clone();
        request["pixel_clip"] = serde_json::json!([x, y, tw, th]);
        let (got_w, got_h, rgba) = worker.region(&request).unwrap();
        assert_eq!((got_w, got_h), (tw, th), "tile size of {:?}", [x, y, tw, th]);
        rgba
    };

    // A clip of the whole region is the whole-region render, exactly, and a
    // tile renders the same bytes every time.
    assert!(clip(&mut worker, [0, 0, w, h]) == whole, "a whole-region clip must equal the plain render");
    assert!(clip(&mut worker, [0, 97, w, 97]) == clip(&mut worker, [0, 97, w, 97]), "tiles must be deterministic");

    // The layouts the app's planner produces: full-width strips, with a
    // shorter last strip, down to single-row edges.
    let strips = |height: u32| -> Vec<u32> { (0..h).step_by(height as usize).chain([h]).collect() };
    let layouts: Vec<(&str, Vec<[u32; 4]>)> = vec![
        ("strips of 97 rows, short last strip", grid(&[0, w], &strips(97))),
        ("strips of 13 rows", grid(&[0, w], &strips(13))),
        ("strips of 7 rows", grid(&[0, w], &strips(7))),
        ("uneven strips with one-row edges", grid(&[0, w], &[0, 1, 2, 77, 150, h - 1, h])),
    ];
    for (name, tiles) in layouts {
        let mut stitched = vec![0u8; whole.len()];
        let mut covered = 0u64;
        for tile @ [x, y, tw, th] in tiles {
            let rgba = clip(&mut worker, tile);
            for row in 0..th as usize {
                let src = &rgba[row * tw as usize * 4..(row + 1) * tw as usize * 4];
                let start = ((y as usize + row) * w as usize + x as usize) * 4;
                stitched[start..start + src.len()].copy_from_slice(src);
            }
            covered += u64::from(tw) * u64::from(th);
        }
        assert_eq!(covered, u64::from(w) * u64::from(h), "{name}: tiles must cover the region once");
        // A misplaced tile or a shifted grid moves whole edges, which differ
        // by far more than two levels on many pixels.
        let mut differing = 0usize;
        for i in 0..(w * h) as usize {
            let (got, want) = (&stitched[i * 4..i * 4 + 4], &whole[i * 4..i * 4 + 4]);
            let delta = got.iter().zip(want).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
            assert!(
                delta <= 2,
                "{name}: pixel ({}, {}) is {got:?} stitched, {want:?} whole",
                i % w as usize,
                i / w as usize
            );
            differing += usize::from(delta > 0);
        }
        let pixels = (w * h) as usize;
        assert!(differing * 100 < pixels, "{name}: {differing} of {pixels} pixels differ");
    }

    // A clip outside the region is refused, not clamped.
    for bad in [[0, 0, w + 1, 1], [w, 0, 1, 1], [0, h, 1, 1], [0, 0, 0, 5]] {
        let mut request = base.clone();
        request["pixel_clip"] = serde_json::json!(bad);
        let error = worker.region(&request).unwrap_err();
        assert!(error.contains("pixel clip outside region"), "{bad:?}: {error}");
    }

    worker.stop();
    let _ = std::fs::remove_file(&pdf_path);
}
