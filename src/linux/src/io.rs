use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;

use crate::protocol::{InboundMsg, OutboundMsg};

pub fn spawn_stdin_reader() -> mpsc::Receiver<InboundMsg> {
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = BufReader::new(stdin.lock());
        for line in reader.lines() {
            match line {
                Ok(l) if l.trim().is_empty() => continue,
                Ok(l) => match serde_json::from_str::<InboundMsg>(&l) {
                    Ok(msg) => {
                        if tx.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(e) => eprintln!("[glimpse] bad message: {e}: {l}"),
                },
                Err(_) => break,
            }
        }
        // stdin EOF — signal close
        let _ = tx.send(InboundMsg::Close);
    });

    rx
}

pub fn emit(msg: &OutboundMsg) {
    let line = serde_json::to_string(msg).unwrap();
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{line}");
    let _ = handle.flush();
}
