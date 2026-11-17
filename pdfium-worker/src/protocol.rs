use serde::{Deserialize, Serialize};

pub use ocg_render_copy::LayerVisibility;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Render {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ocg_visibility: Vec<LayerVisibility>,
        /// Annotaties (op /NM) die met hun eigen uiterlijk (/AP) mee
        /// gerasterd worden; alle andere niet-widget-annotaties blijven weg.
        /// Afwezig = geen annotaties (het oude gedrag).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annot_appearance: Option<Vec<String>>,
        /// Idem op positie in de /Annots-rij van de pagina, voor markeringen
        /// zonder (unieke) /NM. Elk van beide lijsten zet annotaties aan.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annot_appearance_index: Option<Vec<u32>>,
    },
    RenderRegion {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
        /// Pixel rectangle within the original region, preserving its transform.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pixel_clip: Option<[u32; 4]>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ocg_visibility: Vec<LayerVisibility>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annot_appearance: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annot_appearance_index: Option<Vec<u32>>,
    },
    /// A page's text as PDF.js text items (text.rs), written to the SHM
    /// region as JSON. The page is parsed for this request only.
    PageText { id: u64, path: String, page_index: u32 },
    /// Evict one document after an atomic same-path rewrite. Unlike Trim,
    /// this discards the document bytes as well as any open page handle.
    Invalidate { id: u64, path: String },
    /// Sluit open pagina-handles (parse-state, honderden MB's op zware
    /// CAD-pagina's); documenten blijven gecachet. Fire-and-forget: geen
    /// response. Gestuurd door de pool bij inactiviteit.
    Trim,
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Response {
    Ready {
        op: String,
        shm_name: String,
        shm_size: u64,
        ocg_visibility: bool,
        #[serde(default)]
        annot_appearance: bool,
        #[serde(default)]
        annot_appearance_index: bool,
        #[serde(default)]
        region_pixel_clip: bool,
        #[serde(default)]
        page_text: bool,
    },
    RenderOk { id: u64, ok: bool, w: u32, h: u32, shm_bytes: u64 },
    RenderErr { id: u64, ok: bool, error: String },
    // Before InvalidateOk: untagged, and { id, ok } would also match it.
    TextOk { id: u64, ok: bool, text_bytes: u64 },
    InvalidateOk { id: u64, ok: bool },
}

/// The reply to a request line that does not parse as a [`Request`] (a
/// field of the wrong type, such as a non-finite number sent as `null`).
/// The app waits for an answer to every request with an `id`, holding the
/// worker meanwhile; without one it would time out and kill this worker.
/// A line without a readable `id` (fire-and-forget, or not JSON) gets none.
pub fn reply_to_unparsable(line: &str, error: &str) -> Option<Response> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = value.get("id")?.as_u64()?;
    Some(Response::RenderErr { id, ok: false, error: format!("bad request: {error}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unparsable_request_with_an_id_gets_an_error_reply() {
        let line = r#"{"op":"render","id":12,"path":"a.pdf","page_index":0,"scale":null,"rotation":0}"#;
        let error = serde_json::from_str::<Request>(line).unwrap_err().to_string();
        let reply = reply_to_unparsable(line, &error).expect("a reply");
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["id"], 12);
        assert_eq!(value["ok"], false);
        assert!(value["error"].as_str().unwrap().starts_with("bad request: "));
        // Nothing to answer: no id, or no JSON at all.
        assert_eq!(reply_to_unparsable(r#"{"op":"bogus"}"#, "x"), None);
        assert_eq!(reply_to_unparsable("not json", "x"), None);
        assert_eq!(reply_to_unparsable(r#"{"op":"render","id":"7"}"#, "x"), None);
    }

    #[test]
    fn request_render_round_trips() {
        let req = Request::Render {
            id: 42,
            path: "C:/foo.pdf".to_string(),
            page_index: 5,
            scale: 0.25,
            rotation: 0,
            ocg_visibility: vec![],
            annot_appearance: None,
            annot_appearance_index: None,
        };
        let line = serde_json::to_string(&req).unwrap();
        let parsed: Request = serde_json::from_str(&line).unwrap();
        assert_eq!(req, parsed);
        assert!(!line.contains("ocg_visibility"), "default protocol stays unchanged");
        assert!(!line.contains("annot_appearance"), "default protocol stays unchanged");
        assert!(!line.contains("annot_appearance_index"), "default protocol stays unchanged");
    }

    #[test]
    fn selected_ocg_round_trips_and_legacy_request_defaults_empty() {
        let selected = serde_json::json!({
            "op": "render_region", "id": 8, "path": "/tmp/plan.pdf",
            "page_index": 0, "scale": 1.0, "rotation": 0,
            "region_x_pt": 0.0, "region_y_pt": 0.0,
            "region_w_pt": 50.0, "region_h_pt": 50.0,
            "ocg_visibility": [{ "object_number": 6, "generation": 0, "visible": true }],
        });
        let request: Request = serde_json::from_value(selected.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), selected);
        let mut legacy = selected;
        legacy.as_object_mut().unwrap().remove("ocg_visibility");
        let decoded: Request = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    }

    #[test]
    fn annot_appearance_round_trips_and_legacy_requests_render_without() {
        let with = serde_json::json!({
            "op": "render", "id": 3, "path": "/tmp/plan.pdf",
            "page_index": 0, "scale": 1.0, "rotation": 0,
            "annot_appearance": ["a-nm", "b-nm"],
        });
        let request: Request = serde_json::from_value(with.clone()).unwrap();
        assert!(matches!(&request, Request::Render { annot_appearance: Some(v), .. } if v.len() == 2));
        assert_eq!(serde_json::to_value(request).unwrap(), with);
        let mut legacy = with;
        legacy.as_object_mut().unwrap().remove("annot_appearance");
        let decoded: Request = serde_json::from_value(legacy).unwrap();
        assert!(matches!(decoded, Request::Render { annot_appearance: None, .. }));
    }

    #[test]
    fn annot_appearance_index_round_trips_and_defaults_to_none() {
        let with = serde_json::json!({
            "op": "render_region", "id": 4, "path": "/tmp/plan.pdf",
            "page_index": 0, "scale": 1.0, "rotation": 0,
            "region_x_pt": 0.0, "region_y_pt": 0.0, "region_w_pt": 9.0, "region_h_pt": 9.0,
            "annot_appearance_index": [0, 7],
        });
        let request: Request = serde_json::from_value(with.clone()).unwrap();
        assert!(matches!(&request, Request::RenderRegion { annot_appearance_index: Some(v), annot_appearance: None, .. } if v == &vec![0, 7]));
        assert_eq!(serde_json::to_value(request).unwrap(), with);
    }

    #[test]
    fn pixel_clip_round_trips_and_is_absent_by_default() {
        let with = serde_json::json!({
            "op": "render_region", "id": 5, "path": "/tmp/plan.pdf",
            "page_index": 2, "scale": 1.5, "rotation": 0,
            "region_x_pt": 10.5, "region_y_pt": 20.25, "region_w_pt": 300.0, "region_h_pt": 200.0,
            "pixel_clip": [16, 32, 400, 7],
        });
        let request: Request = serde_json::from_value(with.clone()).unwrap();
        assert!(matches!(&request, Request::RenderRegion { pixel_clip: Some([16, 32, 400, 7]), .. }));
        assert_eq!(serde_json::to_value(request).unwrap(), with);
        // A whole-region request (and every request of an older app) has no
        // clip, and serializing one adds none.
        let mut whole = with;
        whole.as_object_mut().unwrap().remove("pixel_clip");
        let decoded: Request = serde_json::from_value(whole.clone()).unwrap();
        assert!(matches!(&decoded, Request::RenderRegion { pixel_clip: None, .. }));
        assert_eq!(serde_json::to_value(decoded).unwrap(), whole);
        // A clip must be exactly four unsigned pixel values.
        for bad in [serde_json::json!([1, 2, 3]), serde_json::json!([1, 2, 3, 4, 5]), serde_json::json!([-1, 0, 4, 4])] {
            let mut request = whole.clone();
            request["pixel_clip"] = bad.clone();
            assert!(serde_json::from_value::<Request>(request).is_err(), "{bad}");
        }
    }

    #[test]
    fn ready_advertises_region_pixel_clip_and_older_readies_default_off() {
        let ready = Response::Ready {
            op: "ready".into(), shm_name: "pdfium-worker-1-0.shm".into(), shm_size: 64,
            ocg_visibility: true, annot_appearance: true, annot_appearance_index: true,
            region_pixel_clip: true, page_text: true,
        };
        let value = serde_json::to_value(&ready).unwrap();
        assert_eq!(value["region_pixel_clip"], true);
        assert_eq!(serde_json::from_value::<Response>(value).unwrap(), ready);
        // A worker from before tiling does not send the flag.
        let older = serde_json::json!({
            "op": "ready", "shm_name": "pdfium-worker-1-0.shm", "shm_size": 64, "ocg_visibility": true,
        });
        assert!(matches!(
            serde_json::from_value::<Response>(older).unwrap(),
            Response::Ready { region_pixel_clip: false, annot_appearance: false, page_text: false, .. }
        ));
    }

    #[test]
    fn page_text_request_and_reply_round_trip() {
        let req = Request::PageText { id: 9, path: "/tmp/set.pdf".into(), page_index: 207 };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains("\"op\":\"page_text\""), "{line}");
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
        let reply = Response::TextOk { id: 9, ok: true, text_bytes: 1234 };
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["text_bytes"], 1234);
        assert_eq!(serde_json::from_value::<Response>(value).unwrap(), reply);
    }

    #[test]
    fn response_render_ok_serializes_with_ok_true() {
        let resp = Response::RenderOk { id: 42, ok: true, w: 1289, h: 596, shm_bytes: 3072512 };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"shm_bytes\":3072512"));
    }

    #[test]
    fn invalidate_round_trips_and_acknowledges() {
        let req = Request::Invalidate { id: 7, path: "/tmp/drawing.pdf".into() };
        let line = serde_json::to_string(&req).unwrap();
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
        let ack = serde_json::to_value(Response::InvalidateOk { id: 7, ok: true }).unwrap();
        assert_eq!(ack["id"], 7);
        assert_eq!(ack["ok"], true);
    }
}
