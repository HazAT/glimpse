use glib::prelude::*;
use gtk4::prelude::*;

use crate::protocol::{AppearanceInfo, CursorPos, ScreenInfo, SystemInfo};

pub fn collect(
    display: &gdk4::Display,
    cursor_pos: Option<CursorPos>,
    cursor_tip: Option<CursorPos>,
) -> SystemInfo {
    let monitor_list = display.monitors();
    let n = monitor_list.n_items();

    let mut screens: Vec<ScreenInfo> = Vec::new();
    for i in 0..n {
        if let Some(obj) = monitor_list.item(i) {
            if let Ok(monitor) = obj.downcast::<gdk4::Monitor>() {
                screens.push(monitor_to_screen_info(&monitor));
            }
        }
    }

    // Primary screen — first monitor, without x/y (matching Swift's main screen output)
    let primary = if let Some(first) = screens.first() {
        ScreenInfo {
            x: None,
            y: None,
            width: first.width,
            height: first.height,
            scale_factor: first.scale_factor,
            visible_x: first.visible_x,
            visible_y: first.visible_y,
            visible_width: first.visible_width,
            visible_height: first.visible_height,
        }
    } else {
        ScreenInfo::default()
    };

    let dark_mode = detect_dark_mode();

    SystemInfo {
        screen: primary,
        screens,
        appearance: AppearanceInfo {
            dark_mode,
            accent_color: None,
            reduce_motion: false,
            increase_contrast: false,
        },
        cursor: cursor_pos.unwrap_or_default(),
        cursor_tip,
    }
}

fn monitor_to_screen_info(monitor: &gdk4::Monitor) -> ScreenInfo {
    let geom = monitor.geometry();

    ScreenInfo {
        x: Some(geom.x()),
        y: Some(geom.y()),
        width: geom.width(),
        height: geom.height(),
        scale_factor: monitor.scale_factor(),
        visible_x: geom.x(),
        visible_y: geom.y(),
        visible_width: geom.width(),
        visible_height: geom.height(),
    }
}

fn detect_dark_mode() -> bool {
    if let Some(settings) = gtk4::Settings::default() {
        if settings.is_gtk_application_prefer_dark_theme() {
            return true;
        }
    }

    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
    {
        let s = String::from_utf8_lossy(&output.stdout);
        if s.contains("prefer-dark") {
            return true;
        }
    }

    false
}
