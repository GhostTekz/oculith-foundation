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
    },
    RenderOk { id: u64, ok: bool, w: u32, h: u32, shm_bytes: u64 },
    RenderErr { id: u64, ok: bool, error: String },
    InvalidateOk { id: u64, ok: bool },
}

#[cfg(test)]
mod tests {
    use super::*;

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
