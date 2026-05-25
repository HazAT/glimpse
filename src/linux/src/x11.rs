use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CString};
use std::mem::ManuallyDrop;

use gdk4::prelude::*;
use glib::translate::ToGlibPtr;
use gtk4::prelude::NativeExt;

use crate::protocol;

#[repr(C)]
struct XDisplay(c_void);

#[repr(C)]
union XClientMessageData {
    l: [c_long; 5],
}

#[repr(C)]
struct XClientMessageEvent {
    type_: c_int,
    serial: c_ulong,
    send_event: c_int,
    display: *mut XDisplay,
    window: c_ulong,
    message_type: c_ulong,
    format: c_int,
    data: XClientMessageData,
}

#[repr(C)]
union XEvent {
    type_: c_int,
    client_message: ManuallyDrop<XClientMessageEvent>,
}

#[link(name = "gtk-4")]
unsafe extern "C" {
    fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut XDisplay;
    fn gdk_x11_surface_get_xid(surface: *mut c_void) -> c_ulong;
}

#[link(name = "X11")]
unsafe extern "C" {
    fn XDefaultRootWindow(display: *mut XDisplay) -> c_ulong;
    fn XFlush(display: *mut XDisplay) -> c_int;
    fn XGrabKeyboard(
        display: *mut XDisplay,
        grab_window: c_ulong,
        owner_events: c_int,
        pointer_mode: c_int,
        keyboard_mode: c_int,
        time: c_ulong,
    ) -> c_int;
    fn XInternAtom(
        display: *mut XDisplay,
        atom_name: *const c_char,
        only_if_exists: c_int,
    ) -> c_ulong;
    fn XQueryPointer(
        display: *mut XDisplay,
        window: c_ulong,
        root_return: *mut c_ulong,
        child_return: *mut c_ulong,
        root_x_return: *mut c_int,
        root_y_return: *mut c_int,
        win_x_return: *mut c_int,
        win_y_return: *mut c_int,
        mask_return: *mut c_uint,
    ) -> c_int;
    fn XSendEvent(
        display: *mut XDisplay,
        window: c_ulong,
        propagate: c_int,
        event_mask: c_long,
        event_send: *mut XEvent,
    ) -> c_int;
    fn XUngrabKeyboard(display: *mut XDisplay, time: c_ulong) -> c_int;
}

const X_CURRENT_TIME: c_ulong = 0;
const X_GRAB_MODE_ASYNC: c_int = 1;
const X_GRAB_SUCCESS: c_int = 0;
const X_CLIENT_MESSAGE: c_int = 33;
const X_NET_WM_STATE_REMOVE: c_long = 0;
const X_NET_WM_STATE_ADD: c_long = 1;
const X_SUBSTRUCTURE_NOTIFY_MASK: c_long = 1 << 19;
const X_SUBSTRUCTURE_REDIRECT_MASK: c_long = 1 << 20;

fn display_for_display(display: &gdk4::Display) -> Option<*mut XDisplay> {
    if !display.backend().is_x11() {
        return None;
    }

    let display_ptr: *mut gdk4::ffi::GdkDisplay = display.to_glib_none().0;
    let xdisplay = unsafe { gdk_x11_display_get_xdisplay(display_ptr.cast::<c_void>()) };
    if xdisplay.is_null() {
        None
    } else {
        Some(xdisplay)
    }
}

fn display_for_window(window: &gtk4::ApplicationWindow) -> Option<*mut XDisplay> {
    let display = gtk4::prelude::WidgetExt::display(window);
    display_for_display(&display)
}

fn window_id(window: &gtk4::ApplicationWindow) -> Option<c_ulong> {
    let surface = window.surface()?;
    let surface_ptr: *mut gdk4::ffi::GdkSurface = surface.to_glib_none().0;
    let xid = unsafe { gdk_x11_surface_get_xid(surface_ptr.cast::<c_void>()) };
    if xid == 0 {
        None
    } else {
        Some(xid)
    }
}

fn atom(display: *mut XDisplay, name: &str) -> Option<c_ulong> {
    let name = CString::new(name).ok()?;
    let atom = unsafe { XInternAtom(display, name.as_ptr(), 0) };
    if atom == 0 {
        None
    } else {
        Some(atom)
    }
}

pub fn is_window(window: &gtk4::ApplicationWindow) -> bool {
    display_for_window(window).is_some()
}

pub fn set_keep_above(window: &gtk4::ApplicationWindow, enabled: bool) -> bool {
    let Some(display) = display_for_window(window) else {
        return false;
    };
    let Some(xid) = window_id(window) else {
        return false;
    };
    let Some(state_atom) = atom(display, "_NET_WM_STATE") else {
        return false;
    };
    let Some(above_atom) = atom(display, "_NET_WM_STATE_ABOVE") else {
        return false;
    };

    let action = if enabled {
        X_NET_WM_STATE_ADD
    } else {
        X_NET_WM_STATE_REMOVE
    };
    let mut event = XEvent {
        client_message: ManuallyDrop::new(XClientMessageEvent {
            type_: X_CLIENT_MESSAGE,
            serial: 0,
            send_event: 1,
            display,
            window: xid,
            message_type: state_atom,
            format: 32,
            data: XClientMessageData {
                l: [action, above_atom as c_long, 0, 1, 0],
            },
        }),
    };

    let root = unsafe { XDefaultRootWindow(display) };
    let status = unsafe {
        XSendEvent(
            display,
            root,
            0,
            X_SUBSTRUCTURE_REDIRECT_MASK | X_SUBSTRUCTURE_NOTIFY_MASK,
            &mut event,
        )
    };
    unsafe {
        XFlush(display);
    }

    status != 0
}

pub fn set_keyboard_grab(
    window: &gtk4::ApplicationWindow,
    enabled: bool,
) -> Option<Result<(), String>> {
    let display = display_for_window(window)?;

    if !enabled {
        unsafe {
            XUngrabKeyboard(display, X_CURRENT_TIME);
            XFlush(display);
        }
        return Some(Ok(()));
    }

    let Some(xid) = window_id(window) else {
        return Some(Err(
            "X11 keyboard grab requires a realized window".to_string()
        ));
    };

    let status = unsafe {
        XGrabKeyboard(
            display,
            xid,
            1,
            X_GRAB_MODE_ASYNC,
            X_GRAB_MODE_ASYNC,
            X_CURRENT_TIME,
        )
    };
    unsafe {
        XFlush(display);
    }

    if status == X_GRAB_SUCCESS {
        Some(Ok(()))
    } else {
        Some(Err(grab_status_reason(status)))
    }
}

pub fn cursor_position(display: &gdk4::Display) -> Option<protocol::CursorPos> {
    let xdisplay = display_for_display(display)?;
    let root = unsafe { XDefaultRootWindow(xdisplay) };
    let mut root_return = 0;
    let mut child_return = 0;
    let mut root_x = 0;
    let mut root_y = 0;
    let mut win_x = 0;
    let mut win_y = 0;
    let mut mask = 0;
    let ok = unsafe {
        XQueryPointer(
            xdisplay,
            root,
            &mut root_return,
            &mut child_return,
            &mut root_x,
            &mut root_y,
            &mut win_x,
            &mut win_y,
            &mut mask,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(protocol::CursorPos {
            x: root_x,
            y: root_y,
        })
    }
}

fn grab_status_reason(status: c_int) -> String {
    match status {
        1 => "X11 keyboard grab failed: already grabbed".to_string(),
        2 => "X11 keyboard grab failed: invalid timestamp".to_string(),
        3 => "X11 keyboard grab failed: window is not viewable yet".to_string(),
        4 => "X11 keyboard grab failed: keyboard is frozen".to_string(),
        other => format!("X11 keyboard grab failed with status {other}"),
    }
}
