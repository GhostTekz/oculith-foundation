//! `extract_page_pdf`: one page of a multi-page file becomes a standalone
//! one-page PDF with that page's boxes, rotation and content. Uses the bundled
//! Linux PDFium; skipped where it is absent.

use app_lib::pdfium_renderer::{extract_page_pdf, init_pdfium};
use lopdf::{dictionary, Document, Object, Stream};

/// Three pages; the second inherits /Rotate 90 from the page tree and has a
/// CropBox inside its MediaBox. Each page draws a line and names itself.
fn three_page_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let sizes = [(600, 400), (842, 595), (300, 300)];
    let mut kids = Vec::new();
    for (i, (w, h)) in sizes.iter().enumerate() {
        let content = format!(
            "0 0 1 RG 2 w 20 20 m {} {} l S BT /F1 12 Tf 30 30 Td (sheet-{}) Tj ET",
            w - 20,
            h - 20,
            i + 1
        );
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let mut page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), (*w).into(), (*h).into()],
            "Contents" => content_id,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
        };
        if i == 1 {
            page.set(
                "CropBox",
                vec![10.into(), 20.into(), 800.into(), 580.into()],
            );
        }
        kids.push(Object::Reference(doc.add_object(page)));
    }
    // The second page sits in a child page tree that carries the rotation.
    let rotated_tree = doc.new_object_id();
    let second = kids[1].as_reference().unwrap();
    doc.get_object_mut(second)
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set("Parent", rotated_tree);
    doc.objects.insert(
        rotated_tree,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Parent" => pages_id, "Kids" => vec![kids[1].clone()],
            "Count" => 1, "Rotate" => 90,
        }),
    );
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![kids[0].clone(), Object::Reference(rotated_tree), kids[2].clone()],
            "Count" => 3,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn numbers(obj: &Object) -> Vec<f32> {
    obj.as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_float().unwrap())
        .collect()
}

#[test]
fn extracts_one_page_with_its_boxes_rotation_and_content() {
    let lib_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/linux-x64");
    if !cfg!(target_os = "linux") || !lib_dir.join("libpdfium.so").exists() {
        eprintln!("Skipping: bundled Linux PDFium unavailable");
        return;
    }
    init_pdfium(&lib_dir).unwrap();

    let dir = std::env::temp_dir().join(format!("extract-page-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("set.pdf");
    std::fs::write(&path, three_page_pdf()).unwrap();

    let bytes = extract_page_pdf(&path, 1).expect("extract page 2");
    let single = Document::load_mem(&bytes).expect("the page PDF parses");
    let pages = single.get_pages();
    assert_eq!(pages.len(), 1, "one page");
    let page_id = *pages.values().next().unwrap();
    let page = single.get_dictionary(page_id).unwrap();
    assert_eq!(
        numbers(page.get(b"MediaBox").unwrap()),
        vec![0.0, 0.0, 842.0, 595.0]
    );
    assert_eq!(
        numbers(page.get(b"CropBox").unwrap()),
        vec![10.0, 20.0, 800.0, 580.0]
    );
    assert_eq!(
        page.get(b"Rotate").unwrap().as_i64().unwrap(),
        90,
        "the inherited rotation is on the page"
    );
    let content = String::from_utf8_lossy(&single.get_page_content(page_id).unwrap()).into_owned();
    assert!(
        content.contains("sheet-2"),
        "the second page's content: {content}"
    );
    assert!(!content.contains("sheet-1") && !content.contains("sheet-3"));

    let first = Document::load_mem(&extract_page_pdf(&path, 0).unwrap()).unwrap();
    let first_page = *first.get_pages().values().next().unwrap();
    assert!(
        String::from_utf8_lossy(&first.get_page_content(first_page).unwrap()).contains("sheet-1")
    );

    let missing = extract_page_pdf(&path, 3).unwrap_err();
    assert!(missing.contains("not found"), "{missing}");
    assert!(extract_page_pdf(&dir.join("absent.pdf"), 0).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
