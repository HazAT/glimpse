use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::CursorPos;

pub fn is_supported() -> bool {
    socket_path().is_some()
}

pub fn support_reason() -> &'static str {
    if env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        return "Hyprland session not detected";
    }
    if socket_path().is_none() {
        return "Hyprland IPC socket not found";
    }
    "Hyprland cursor tracking available"
}

pub fn current_cursor_pos() -> Result<CursorPos, String> {
    let path = socket_path().ok_or_else(|| support_reason().to_string())?;
    request_cursor_pos(&path)
}

pub fn spawn_cursor_poller(
    enabled: Arc<AtomicBool>,
    interval: Duration,
) -> Result<mpsc::Receiver<CursorPos>, String> {
    let path = socket_path().ok_or_else(|| support_reason().to_string())?;
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || loop {
        let started = Instant::now();

        if enabled.load(Ordering::Relaxed) {
            if let Ok(pos) = request_cursor_pos(&path) {
                if tx.send(pos).is_err() {
                    break;
                }
            }
        }

        if let Some(remaining) = interval.checked_sub(started.elapsed()) {
            thread::sleep(remaining);
        }
    });

    Ok(rx)
}

fn socket_path() -> Option<PathBuf> {
    let signature = env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;

    let mut candidates = Vec::new();
    if let Some(runtime_dir) = env::var_os("XDG_RUNTIME_DIR") {
        candidates.push(PathBuf::from(runtime_dir).join("hypr").join(&signature).join(".socket.sock"));
    }
    if let Some(uid) = env::var_os("UID") {
        candidates.push(
            PathBuf::from("/run/user")
                .join(uid)
                .join("hypr")
                .join(&signature)
                .join(".socket.sock"),
        );
    }
    candidates.push(
        PathBuf::from("/tmp")
            .join("hypr")
            .join(&signature)
            .join(".socket.sock"),
    );

    candidates.into_iter().find(|path| path.exists())
}

fn request_cursor_pos(path: &PathBuf) -> Result<CursorPos, String> {
    let mut stream = UnixStream::connect(path)
        .map_err(|err| format!("failed to connect to {}: {err}", path.display()))?;
    stream
        .write_all(b"cursorpos")
        .map_err(|err| format!("failed to write cursorpos request: {err}"))?;

    let mut buf = [0_u8; 256];
    let len = stream
        .read(&mut buf)
        .map_err(|err| format!("failed to read cursor position: {err}"))?;
    if len == 0 {
        return Err("Hyprland IPC returned EOF".to_string());
    }

    parse_cursor_pos(std::str::from_utf8(&buf[..len]).map_err(|err| err.to_string())?.trim())
}

fn parse_cursor_pos(input: &str) -> Result<CursorPos, String> {
    let parts = input
        .split(|c: char| c == ',' || c.is_ascii_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.len() < 2 {
        return Err(format!("invalid cursor position payload: {input}"));
    }

    let x = parts[0]
        .parse::<f64>()
        .map_err(|err| format!("invalid x coordinate '{0}': {err}", parts[0]))?;
    let y = parts[1]
        .parse::<f64>()
        .map_err(|err| format!("invalid y coordinate '{0}': {err}", parts[1]))?;

    Ok(CursorPos {
        x: x.round() as i32,
        y: y.round() as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_cursor_pos;
    use crate::protocol::CursorPos;

    #[test]
    fn parses_comma_separated_payload() {
        assert_eq!(
            parse_cursor_pos("4606,1252").unwrap(),
            CursorPos { x: 4606, y: 1252 }
        );
    }

    #[test]
    fn parses_whitespace_separated_payload() {
        assert_eq!(
            parse_cursor_pos("4606 1252").unwrap(),
            CursorPos { x: 4606, y: 1252 }
        );
    }

    #[test]
    fn rounds_float_payload() {
        assert_eq!(
            parse_cursor_pos("4606.4,1252.6").unwrap(),
            CursorPos { x: 4606, y: 1253 }
        );
    }
}
