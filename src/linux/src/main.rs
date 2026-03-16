mod bridge;
mod cursor;
mod hyprland;
mod io;
mod protocol;
mod sysinfo;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use clap::Parser;
use glib::prelude::*;
use gtk4::prelude::*;
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use webkit6::prelude::*;

use protocol::{InboundMsg, OutboundMsg};

#[derive(Parser, Debug)]
#[command(name = "glimpse")]
struct Args {
    #[arg(long, default_value_t = 800)]
    width: i32,
    #[arg(long, default_value_t = 600)]
    height: i32,
    #[arg(long, default_value = "Glimpse")]
    title: String,
    #[arg(long)]
    x: Option<i32>,
    #[arg(long)]
    y: Option<i32>,
    #[arg(long)]
    frameless: bool,
    #[arg(long)]
    floating: bool,
    #[arg(long)]
    transparent: bool,
    #[arg(long = "click-through")]
    click_through: bool,
    #[arg(long = "follow-cursor")]
    follow_cursor: bool,
    #[arg(long = "follow-mode", default_value = "snap")]
    follow_mode: String,
    #[arg(long = "cursor-anchor")]
    cursor_anchor: Option<String>,
    #[arg(long = "cursor-offset-x")]
    cursor_offset_x: Option<f64>,
    #[arg(long = "cursor-offset-y")]
    cursor_offset_y: Option<f64>,
    #[arg(long)]
    hidden: bool,
    #[arg(long = "auto-close")]
    auto_close: bool,
}

impl Args {
    fn effective_offset_x(&self) -> f64 {
        self.cursor_offset_x
            .unwrap_or(if self.cursor_anchor.is_some() { 0.0 } else { 20.0 })
    }
    fn effective_offset_y(&self) -> f64 {
        self.cursor_offset_y
            .unwrap_or(if self.cursor_anchor.is_some() { 0.0 } else { -20.0 })
    }
}

fn linux_follow_cursor_supported() -> bool {
    hyprland::is_supported()
}

fn linux_follow_cursor_reason() -> &'static str {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        return hyprland::support_reason();
    }
    let session_type = std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if std::env::var_os("WAYLAND_DISPLAY").is_some() || session_type == "wayland" {
        return "Wayland follow-cursor needs a compositor-specific backend";
    }
    if std::env::var_os("DISPLAY").is_some() || session_type == "x11" {
        return "X11 backend is not implemented yet";
    }
    "no supported cursor-tracking backend detected"
}

fn main() {
    let mut args = Args::parse();
    if args.follow_cursor && !linux_follow_cursor_supported() {
        eprintln!(
            "[glimpse] follow-cursor disabled on Linux: {}",
            linux_follow_cursor_reason()
        );
        args.follow_cursor = false;
    }
    let args = Rc::new(args);

    let app = gtk4::Application::new(None::<&str>, gio::ApplicationFlags::FLAGS_NONE);

    let args_clone = args.clone();
    app.connect_activate(move |app| {
        activate(app, &args_clone);
    });

    // GTK Application expects argv but we've already parsed with clap
    app.run_with_args::<String>(&[]);
}

fn activate(app: &gtk4::Application, args: &Rc<Args>) {
    let display = gdk4::Display::default().unwrap();

    // ── Content window ──────────────────────────────────────────────────
    let window = gtk4::ApplicationWindow::new(app);
    window.init_layer_shell();
    window.set_layer(Layer::Overlay);
    window.set_exclusive_zone(-1);
    window.set_title(Some(&args.title));
    window.set_default_size(args.width, args.height);

    if args.click_through {
        window.set_keyboard_mode(KeyboardMode::None);
    } else {
        window.set_keyboard_mode(KeyboardMode::OnDemand);
    }

    // Position: anchor top-left + margins
    window.set_anchor(Edge::Top, true);
    window.set_anchor(Edge::Left, true);

    let offset_x = args.effective_offset_x();
    let offset_y = args.effective_offset_y();
    let initial_cursor = hyprland::current_cursor_pos().ok();
    let (init_x, init_y) = if args.follow_cursor {
        if let Some(cursor_pos) = initial_cursor {
            let (x, y) = cursor::compute_target(
                cursor_pos.x as f64,
                cursor_pos.y as f64,
                args.width as f64,
                args.height as f64,
                args.cursor_anchor.as_deref(),
                offset_x,
                offset_y,
            );
            (x.round() as i32, y.round() as i32)
        } else {
            resolve_initial_position(args, &display)
        }
    } else {
        resolve_initial_position(args, &display)
    };
    place_window_at_global_position(&window, &display, (init_x as f64, init_y as f64));

    // Transparent background
    if args.transparent {
        let provider = gtk4::CssProvider::new();
        provider.load_from_string("window { background: transparent; }");
        gtk4::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }

    // ── WebView ─────────────────────────────────────────────────────────
    let manager = webkit6::UserContentManager::new();

    // Inject bridge JS
    let bridge_script = webkit6::UserScript::new(
        bridge::BRIDGE_JS,
        webkit6::UserContentInjectedFrames::TopFrame,
        webkit6::UserScriptInjectionTime::Start,
        &[],
        &[],
    );
    manager.add_script(&bridge_script);

    let webview = webkit6::WebView::builder()
        .user_content_manager(&manager)
        .build();

    if args.transparent {
        webview.set_background_color(&gdk4::RGBA::new(0.0, 0.0, 0.0, 0.0));
    }

    window.set_child(Some(&webview));

    // ── Message handler (window.glimpse.send / .close) ──────────────────
    let auto_close = args.auto_close;
    let app_for_msg = app.clone();
    manager.register_script_message_handler("glimpse", None);
    manager.connect_script_message_received(
        Some("glimpse"),
        move |_manager, value| {
            let json_str = value.to_str();
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if parsed.get("__glimpse_close").and_then(|v| v.as_bool()) == Some(true) {
                    io::emit(&OutboundMsg::Closed);
                    app_for_msg.quit();
                    return;
                }
                io::emit(&OutboundMsg::Message { data: parsed });
                if auto_close {
                    io::emit(&OutboundMsg::Closed);
                    app_for_msg.quit();
                }
            }
        },
    );

    // ── Ready event on page load ────────────────────────────────────────
    let display_for_ready = display.clone();
    let hidden = Rc::new(RefCell::new(args.hidden));
    let hidden_for_ready = hidden.clone();
    let window_for_ready = window.clone();
    let cursor_anchor = Rc::new(RefCell::new(args.cursor_anchor.clone()));
    let follow_mode = Rc::new(RefCell::new(args.follow_mode.clone()));
    let follow_enabled = Arc::new(AtomicBool::new(args.follow_cursor));
    let current_cursor = Rc::new(RefCell::new(initial_cursor));
    let current_cursor_tip = Rc::new(RefCell::new(compute_cursor_tip_state(
        args,
        args.follow_cursor,
        args.cursor_anchor.as_deref(),
        offset_x,
        offset_y,
    )));

    let current_cursor_for_ready = current_cursor.clone();
    let current_cursor_tip_for_ready = current_cursor_tip.clone();
    webview.connect_load_changed(move |_wv, event| {
        if event == webkit6::LoadEvent::Finished {
            if *hidden_for_ready.borrow() {
                window_for_ready.set_visible(false);
            }
            let info = sysinfo::collect(
                &display_for_ready,
                *current_cursor_for_ready.borrow(),
                *current_cursor_tip_for_ready.borrow(),
            );
            io::emit(&OutboundMsg::Ready { info });
        }
    });

    // Load blank page to trigger initial ready
    webview.load_html("<html><body></body></html>", None);

    // ── Follow cursor ───────────────────────────────────────────────────
    let spring = Rc::new(RefCell::new(cursor::SpringState::new((
        init_x as f64,
        init_y as f64,
    ))));
    let spring_animating = Rc::new(RefCell::new(false));

    if linux_follow_cursor_supported() {
        setup_cursor_tracking(
            &window,
            &display,
            args,
            &cursor_anchor,
            &follow_mode,
            offset_x,
            offset_y,
            &spring,
            &spring_animating,
            &follow_enabled,
            &current_cursor,
        );
    }

    // ── Stdin reader (poll via glib timeout) ────────────────────────────
    let rx = io::spawn_stdin_reader();
    let window_for_stdin = window.clone();
    let webview_for_stdin = webview.clone();
    let app_for_stdin = app.clone();
    let display_for_stdin = display.clone();
    let hidden_for_stdin = hidden.clone();
    let cursor_anchor_for_stdin = cursor_anchor.clone();
    let follow_mode_for_stdin = follow_mode.clone();
    let follow_enabled_for_stdin = follow_enabled.clone();
    let current_cursor_for_stdin = current_cursor.clone();
    let current_cursor_tip_for_stdin = current_cursor_tip.clone();
    let spring_for_stdin = spring.clone();
    let spring_animating_for_stdin = spring_animating.clone();
    let args_for_stdin = args.clone();

    // Poll stdin channel every 10ms
    glib::timeout_add_local(Duration::from_millis(10), move || {
        while let Ok(msg) = rx.try_recv() {
            handle_message(
                msg,
                &app_for_stdin,
                &window_for_stdin,
                &webview_for_stdin,
                &display_for_stdin,
                &hidden_for_stdin,
                &args_for_stdin,
                &cursor_anchor_for_stdin,
                &follow_mode_for_stdin,
                &follow_enabled_for_stdin,
                &current_cursor_for_stdin,
                &current_cursor_tip_for_stdin,
                offset_x,
                offset_y,
                &spring_for_stdin,
                &spring_animating_for_stdin,
            );
        }
        glib::ControlFlow::Continue
    });

    // ── Show window ─────────────────────────────────────────────────────
    if !args.hidden {
        window.present();
    }
}

fn resolve_initial_position(args: &Args, display: &gdk4::Display) -> (i32, i32) {
    if let (Some(x), Some(y)) = (args.x, args.y) {
        return (x, y);
    }
    let monitors = display.monitors();
    if let Some(obj) = monitors.item(0) {
        if let Ok(monitor) = obj.downcast::<gdk4::Monitor>() {
            let geom = monitor.geometry();
            let x = geom.x() + (geom.width() - args.width) / 2;
            let y = geom.y() + (geom.height() - args.height) / 2;
            return (x.max(0), y.max(0));
        }
    }
    (0, 0)
}

fn first_monitor(display: &gdk4::Display) -> Option<gdk4::Monitor> {
    let monitors = display.monitors();
    monitors
        .item(0)
        .and_then(|obj| obj.downcast::<gdk4::Monitor>().ok())
}

fn monitor_at_global_position(
    display: &gdk4::Display,
    global_x: i32,
    global_y: i32,
) -> Option<gdk4::Monitor> {
    let monitors = display.monitors();
    let n = monitors.n_items();
    for i in 0..n {
        if let Some(obj) = monitors.item(i) {
            if let Ok(monitor) = obj.downcast::<gdk4::Monitor>() {
                let geom = monitor.geometry();
                let within_x = global_x >= geom.x() && global_x < geom.x() + geom.width();
                let within_y = global_y >= geom.y() && global_y < geom.y() + geom.height();
                if within_x && within_y {
                    return Some(monitor);
                }
            }
        }
    }
    None
}

fn current_global_position(window: &gtk4::ApplicationWindow) -> (f64, f64) {
    if let Some(monitor) = window.monitor() {
        let geom = monitor.geometry();
        return (
            f64::from(geom.x() + window.margin(Edge::Left)),
            f64::from(geom.y() + window.margin(Edge::Top)),
        );
    }

    (
        f64::from(window.margin(Edge::Left)),
        f64::from(window.margin(Edge::Top)),
    )
}

fn place_window_at_global_position(
    window: &gtk4::ApplicationWindow,
    display: &gdk4::Display,
    global_pos: (f64, f64),
) {
    let global_x = global_pos.0.round() as i32;
    let global_y = global_pos.1.round() as i32;

    if let Some(monitor) = monitor_at_global_position(display, global_x, global_y)
        .or_else(|| first_monitor(display))
    {
        let geom = monitor.geometry();
        window.set_monitor(Some(&monitor));
        window.set_margin(Edge::Left, global_x - geom.x());
        window.set_margin(Edge::Top, global_y - geom.y());
        return;
    }

    window.set_margin(Edge::Left, global_x);
    window.set_margin(Edge::Top, global_y);
}

fn compute_cursor_tip_state(
    args: &Args,
    follow_enabled: bool,
    anchor: Option<&str>,
    offset_x: f64,
    offset_y: f64,
) -> Option<protocol::CursorPos> {
    if !follow_enabled {
        return None;
    }

    cursor::compute_cursor_tip(
        args.width as f64,
        args.height as f64,
        anchor,
        offset_x,
        offset_y,
    )
    .map(|(x, y)| protocol::CursorPos { x, y })
}

fn write_cursor_tip_js(webview: &webkit6::WebView, tip: Option<protocol::CursorPos>) {
    let js = if let Some(tip) = tip {
        format!("window.glimpse.cursorTip = {{x: {}, y: {}}}", tip.x, tip.y)
    } else {
        "window.glimpse.cursorTip = null".to_string()
    };
    webview.evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |_| {});
}

fn set_follow_target(
    window: &gtk4::ApplicationWindow,
    display: &gdk4::Display,
    mode: &str,
    spring: &Rc<RefCell<cursor::SpringState>>,
    spring_animating: &Rc<RefCell<bool>>,
    target: (f64, f64),
) {
    if mode == "spring" {
        spring.borrow_mut().target = target;
        *spring_animating.borrow_mut() = true;
        return;
    }

    {
        let mut s = spring.borrow_mut();
        s.target = target;
        s.pos = target;
        s.vel = (0.0, 0.0);
    }
    *spring_animating.borrow_mut() = false;
    place_window_at_global_position(window, display, target);
}

fn setup_cursor_tracking(
    content_window: &gtk4::ApplicationWindow,
    display: &gdk4::Display,
    args: &Rc<Args>,
    cursor_anchor: &Rc<RefCell<Option<String>>>,
    follow_mode: &Rc<RefCell<String>>,
    offset_x: f64,
    offset_y: f64,
    spring: &Rc<RefCell<cursor::SpringState>>,
    spring_animating: &Rc<RefCell<bool>>,
    follow_enabled: &Arc<AtomicBool>,
    current_cursor: &Rc<RefCell<Option<protocol::CursorPos>>>,
) {
    let cursor_rx = match hyprland::spawn_cursor_poller(
        follow_enabled.clone(),
        Duration::from_millis(8),
    ) {
        Ok(rx) => rx,
        Err(err) => {
            eprintln!("[glimpse] failed to start Hyprland cursor tracker: {err}");
            return;
        }
    };

    let window = content_window.clone();
    let display = display.clone();
    let args = args.clone();
    let cursor_anchor = cursor_anchor.clone();
    let follow_mode = follow_mode.clone();
    let spring = spring.clone();
    let spring_animating = spring_animating.clone();
    let current_cursor = current_cursor.clone();
    let follow_enabled = follow_enabled.clone();

    glib::timeout_add_local(Duration::from_millis(8), move || {
        let mut latest_cursor = None;
        while let Ok(pos) = cursor_rx.try_recv() {
            latest_cursor = Some(pos);
        }

        if let Some(cursor_pos) = latest_cursor {
            *current_cursor.borrow_mut() = Some(cursor_pos);

            if follow_enabled.load(Ordering::Relaxed) {
                let anchor = cursor_anchor.borrow();
                let mode = follow_mode.borrow();
                let target = cursor::compute_target(
                    cursor_pos.x as f64,
                    cursor_pos.y as f64,
                    args.width as f64,
                    args.height as f64,
                    anchor.as_deref(),
                    offset_x,
                    offset_y,
                );
                set_follow_target(&window, &display, &mode, &spring, &spring_animating, target);
            }
        }

        if follow_enabled.load(Ordering::Relaxed)
            && follow_mode.borrow().as_str() == "spring"
            && *spring_animating.borrow()
        {
            let (settled, px, py) = {
                let mut state = spring.borrow_mut();
                let settled = state.tick();
                (settled, state.pos.0, state.pos.1)
            };
            place_window_at_global_position(&window, &display, (px, py));
            if settled {
                *spring_animating.borrow_mut() = false;
            }
        }

        glib::ControlFlow::Continue
    });
}

fn handle_message(
    msg: InboundMsg,
    _app: &gtk4::Application,
    window: &gtk4::ApplicationWindow,
    webview: &webkit6::WebView,
    display: &gdk4::Display,
    hidden: &Rc<RefCell<bool>>,
    args: &Rc<Args>,
    cursor_anchor: &Rc<RefCell<Option<String>>>,
    follow_mode: &Rc<RefCell<String>>,
    follow_enabled: &Arc<AtomicBool>,
    current_cursor: &Rc<RefCell<Option<protocol::CursorPos>>>,
    current_cursor_tip: &Rc<RefCell<Option<protocol::CursorPos>>>,
    offset_x: f64,
    offset_y: f64,
    spring: &Rc<RefCell<cursor::SpringState>>,
    spring_animating: &Rc<RefCell<bool>>,
) {
    match msg {
        InboundMsg::Html { html } => {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&html)
                .unwrap_or_default();
            let html_str = String::from_utf8_lossy(&decoded);
            webview.load_html(&html_str, None);
        }
        InboundMsg::Eval { js } => {
            webview.evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |_| {});
        }
        InboundMsg::File { path } => {
            let uri = format!("file://{path}");
            webview.load_uri(&uri);
        }
        InboundMsg::Show { title } => {
            if let Some(t) = title {
                window.set_title(Some(&t));
            }
            *hidden.borrow_mut() = false;
            window.set_visible(true);
            window.present();
        }
        InboundMsg::Close => {
            io::emit(&OutboundMsg::Closed);
            std::process::exit(0);
        }
        InboundMsg::GetInfo => {
            let live_cursor = hyprland::current_cursor_pos()
                .ok()
                .or(*current_cursor.borrow());
            if let Some(cursor_pos) = live_cursor {
                *current_cursor.borrow_mut() = Some(cursor_pos);
            }
            let info = sysinfo::collect(display, live_cursor, *current_cursor_tip.borrow());
            io::emit(&OutboundMsg::Info { info });
        }
        InboundMsg::FollowCursor {
            enabled,
            anchor,
            mode,
        } => {
            if let Some(anchor) = anchor {
                *cursor_anchor.borrow_mut() = Some(anchor);
            }
            if let Some(mode) = mode {
                let mut follow_mode_ref = follow_mode.borrow_mut();
                let switching_to_spring = mode == "spring" && follow_mode_ref.as_str() != "spring";
                *follow_mode_ref = mode;
                drop(follow_mode_ref);

                if switching_to_spring {
                    let (left, top) = current_global_position(window);
                    let mut spring_state = spring.borrow_mut();
                    spring_state.pos = (left, top);
                    spring_state.target = (left, top);
                    spring_state.vel = (0.0, 0.0);
                }
            }

            follow_enabled.store(enabled, Ordering::Relaxed);

            let tip = compute_cursor_tip_state(
                args,
                enabled,
                cursor_anchor.borrow().as_deref(),
                offset_x,
                offset_y,
            );
            *current_cursor_tip.borrow_mut() = tip;
            write_cursor_tip_js(webview, tip);

            if !enabled {
                *spring_animating.borrow_mut() = false;
                return;
            }

            if let Some(cursor_pos) = *current_cursor.borrow() {
                let target = cursor::compute_target(
                    cursor_pos.x as f64,
                    cursor_pos.y as f64,
                    args.width as f64,
                    args.height as f64,
                    cursor_anchor.borrow().as_deref(),
                    offset_x,
                    offset_y,
                );
                let mode = follow_mode.borrow().clone();
                set_follow_target(window, display, &mode, spring, spring_animating, target);
            }
        }
    }
}
