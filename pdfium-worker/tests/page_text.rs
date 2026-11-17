//! The worker's page text (op page_text) must hold the same text items as
//! PDF.js's getTextContent, which the app's scans were built on: where an
//! item starts and ends (gaps, lines, marked content, form XObjects), its
//! spaces, a line-end hyphen, and its position. The expected items below
//! are what PDF.js (pdfjs-dist 6.3) gives for this fixture. Run with:
//! `cargo test -p pdfium-worker --test page_text -- --nocapture`

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::process::{Command, Stdio};

/// A sheet with the text shapes the scans meet: schedule cells that touch,
/// each its own marked content (CAD layers); a note line ending in a
/// hyphen; a label drawn by a form XObject; a plain line with spaces; and
/// a turned sheet number.
pub fn fixture() -> Vec<u8> {
    let content = concat!(
        "BT /F1 10 Tf 1 0 0 1 100 700 Tm (PANEL LP-1) Tj ET\n",
        "/OC /L1 BDC BT /F1 10 Tf 1 0 0 1 100 650 Tm (33) Tj ET EMC\n",
        "/OC /L1 BDC BT /F1 10 Tf 1 0 0 1 111.12 650 Tm (32) Tj ET EMC\n",
        "BT /F1 10 Tf 1 0 0 1 100 600 Tm (NEUTRAL AS A CURRENT-) Tj 0 -12 Td (CARRYING CONDUCTOR) Tj ET\n",
        "q 1 0 0 1 300 500 cm /Fm1 Do Q\n",
        "BT /F1 10 Tf 1 0 0 1 100 400 Tm (A) Tj 1 0 0 1 109 400 Tm (B) Tj 1 0 0 1 130 400 Tm (C) Tj ET\n",
        "BT /F1 14 Tf 0 1 -1 0 560 100 Tm (E-101) Tj ET\n",
        "BT /F1 10 Tf 1 0 0 1 220 300 Tm (WHITE) Tj 1 0 0 1 200 300 Tm (4) Tj ET\n",
    );
    pdf(content)
}

/// A one-page PDF with `content`, a Helvetica /F1, a form /Fm1 drawing a
/// label, and an optional content group /L1.
fn pdf(content: &str) -> Vec<u8> {
    let form = "BT /F1 10 Tf 1 0 0 1 0 0 Tm (FORM LABEL) Tj ET\n";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
           /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> /Properties << /L1 7 0 R >> >> >>"
            .to_string(),
        format!("<< /Length {} >>\nstream\n{}endstream", content.len(), content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!(
            "<< /Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 5 0 R >> >> /Length {} >>\nstream\n{}endstream",
            form.len(),
            form
        ),
        "<< /Type /OCG /Name (Layer) >>".to_string(),
    ];
    let mut pdf = b"%PDF-1.5\n".to_vec();
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

fn page_text(pdf: &std::path::Path, unique: &str) -> serde_json::Value {
    let lib_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../open-pdf-studio/src-tauri/binaries/linux-x64");
    let mut child = Command::new(env!("CARGO_BIN_EXE_pdfium-worker"))
        .arg("95").arg(unique).current_dir(&lib_dir)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["page_text"], true, "worker must advertise page text: {line}");
    writeln!(stdin, "{}", serde_json::json!({ "op": "page_text", "id": 1, "path": pdf, "page_index": 0 })).unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["ok"], true, "{line}");
    let shm = std::env::temp_dir().join(format!("pdfium-worker-{unique}-95.shm"));
    let mut file = std::fs::File::open(&shm).unwrap();
    file.seek(SeekFrom::Start(32)).unwrap();
    let mut json = vec![0; reply["text_bytes"].as_u64().unwrap() as usize];
    file.read_exact(&mut json).unwrap();
    let _ = writeln!(stdin, "{}", serde_json::json!({ "op": "shutdown" }));
    let _ = child.wait();
    let _ = std::fs::remove_file(&shm);
    serde_json::from_slice(&json).unwrap()
}

#[test]
fn page_text_items_match_pdfjs() {
    let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../open-pdf-studio/src-tauri/binaries/linux-x64/libpdfium.so");
    if !cfg!(target_os = "linux") || !lib.exists() {
        eprintln!("Skipping: Linux PDFium runtime unavailable");
        return;
    }
    let unique = format!("page-text-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let pdf = std::env::temp_dir().join(format!("{unique}.pdf"));
    std::fs::write(&pdf, fixture()).unwrap();
    let text = page_text(&pdf, &unique);
    let _ = std::fs::remove_file(&pdf);
    if std::env::var_os("PAGE_TEXT_DUMP").is_some() {
        println!("{}", serde_json::to_string_pretty(&text).unwrap());
    }
    let items = text["items"].as_array().unwrap();
    let strs: Vec<&str> = items.iter().map(|i| i["str"].as_str().unwrap()).collect();
    assert_eq!(strs, EXPECTED.iter().map(|e| e.0).collect::<Vec<_>>());
    for (item, (s, x, y, width, height)) in items.iter().zip(EXPECTED) {
        let t = item["transform"].as_array().unwrap();
        let close = |a: &serde_json::Value, b: f64, tol: f64| (a.as_f64().unwrap() - b).abs() <= tol;
        assert!(close(&t[4], x, 0.01) && close(&t[5], y, 0.01), "{s}: origin {t:?}");
        assert!(close(&item["width"], width, 0.05 * width.max(1.0)), "{s}: width {} vs {width}", item["width"]);
        assert!(close(&item["height"], height, 0.01), "{s}: height {}", item["height"]);
    }
    assert_eq!(text["view"], serde_json::json!([0.0, 0.0, 612.0, 792.0]));
    assert_eq!(text["exact"], true, "every character of this page is read");
}

fn runtime() -> bool {
    let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../open-pdf-studio/src-tauri/binaries/linux-x64/libpdfium.so");
    cfg!(target_os = "linux") && lib.exists()
}

fn read(content: &str, name: &str) -> serde_json::Value {
    let unique = format!("page-text-{name}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let path = std::env::temp_dir().join(format!("{unique}.pdf"));
    std::fs::write(&path, pdf(content)).unwrap();
    let text = page_text(&path, &unique);
    let _ = std::fs::remove_file(&path);
    text
}

/// PDFium leaves out text drawn twice over itself (a bold effect, or two
/// layers); PDF.js reads both copies. The worker draws the dropped copy
/// again from the one kept, so the page holds PDF.js's two items exactly.
#[test]
fn text_drawn_twice_is_read_twice_as_pdfjs_reads_it() {
    if !runtime() { eprintln!("Skipping: Linux PDFium runtime unavailable"); return; }
    let twice = read(concat!(
        "BT /F1 10 Tf 1 0 0 1 100 700 Tm (*DP-1AM1-1) Tj ET\n",
        "BT /F1 10 Tf 1 0 0 1 100.2 700 Tm (*DP-1AM1-1) Tj ET\n",
    ), "twice");
    assert_eq!(twice["exact"], true, "{twice}");
    let items = twice["items"].as_array().unwrap();
    let got: Vec<(String, f64)> = items.iter().map(|i| (i["str"].as_str().unwrap().to_string(), i["transform"][4].as_f64().unwrap())).collect();
    // pdfjs-dist 6.3: ["*DP-1AM1-1", 100, 700, 56.12, 10], ["*DP-1AM1-1", 100.2, 700, 56.12, 10]
    assert_eq!(got.len(), 2, "{twice}");
    assert_eq!(got[0].0, "*DP-1AM1-1");
    assert_eq!(got[1].0, "*DP-1AM1-1");
    assert!((got[0].1 - 100.0).abs() < 0.01 && (got[1].1 - 100.2).abs() < 0.01, "{got:?}");
    for item in items {
        assert!((item["width"].as_f64().unwrap() - 56.12).abs() < 0.5, "{item}");
    }
    let once = read("BT /F1 10 Tf 1 0 0 1 100 700 Tm (*DP-1AM1-1) Tj ET\n", "once");
    assert_eq!(once["exact"], true, "{once}");
    assert_eq!(once["items"].as_array().unwrap().len(), 1);
}

/// Text at an angle is read by PDF.js (its advance is not taken from PDFium yet).
#[test]
fn angled_text_marks_the_page_not_exact() {
    if !runtime() { eprintln!("Skipping: Linux PDFium runtime unavailable"); return; }
    let angled = read("BT /F1 10 Tf 0.8 0.6 -0.6 0.8 300 300 Tm (43) Tj ET\n", "angled");
    assert_eq!(angled["exact"], false, "{angled}");
}

/// (str, x, y, width, height) of each PDF.js item that holds text.
const EXPECTED: [(&str, f64, f64, f64, f64); 11] = [
    ("PANEL LP-1", 100.0, 700.0, 56.69, 10.0),
    ("33", 100.0, 650.0, 11.12, 10.0),
    ("32", 111.12, 650.0, 11.12, 10.0),
    ("NEUTRAL AS A CURRENT-", 100.0, 600.0, 127.23, 10.0),
    ("CARRYING CONDUCTOR", 100.0, 588.0, 120.55, 10.0),
    ("FORM LABEL", 300.0, 500.0, 63.35, 10.0),
    ("A B", 100.0, 400.0, 15.67, 10.0),
    ("C", 130.0, 400.0, 7.22, 10.0),
    ("E-101", 560.0, 100.0, 37.352, 14.0),
    ("WHITE", 220.0, 300.0, 32.22, 10.0),
    ("4", 200.0, 300.0, 5.56, 10.0),
];
