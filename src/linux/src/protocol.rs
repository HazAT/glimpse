use serde::{Deserialize, Serialize};

// ── Inbound (stdin → binary) ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum InboundMsg {
    Html { html: String },
    Eval { js: String },
    File { path: String },
    Show { title: Option<String> },
    Close,
    GetInfo,
    FollowCursor {
        #[serde(default = "default_true")]
        enabled: bool,
        anchor: Option<String>,
        mode: Option<String>,
    },
}

fn default_true() -> bool {
    true
}

// ── Outbound (binary → stdout) ────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum OutboundMsg {
    Ready {
        #[serde(flatten)]
        info: SystemInfo,
    },
    Info {
        #[serde(flatten)]
        info: SystemInfo,
    },
    Message {
        data: serde_json::Value,
    },
    Closed,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    pub width: i32,
    pub height: i32,
    pub scale_factor: i32,
    pub visible_x: i32,
    pub visible_y: i32,
    pub visible_width: i32,
    pub visible_height: i32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceInfo {
    pub dark_mode: bool,
    pub accent_color: Option<String>,
    pub reduce_motion: bool,
    pub increase_contrast: bool,
}

#[derive(Debug, Serialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub screen: ScreenInfo,
    pub screens: Vec<ScreenInfo>,
    pub appearance: AppearanceInfo,
    pub cursor: CursorPos,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_tip: Option<CursorPos>,
}
