//! Generic v2 example: `start` publishes clock.tick from a background thread;
//! `snapshot` reads the current counter after a reconnect or dropped events.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cadencr_tab_backend::{serve, Context, Error};
use serde_json::json;

fn main() -> std::process::ExitCode {
    let started = AtomicBool::new(false);
    let counter = Arc::new(AtomicU64::new(0));
    serve(move |cx: &Context| match cx.method() {
        "start" => {
            if !started.swap(true, Ordering::Relaxed) {
                let (counter, emitter) = (counter.clone(), cx.emitter());
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(250));
                    let tick = counter.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Err(error) = emitter.emit("clock.tick", json!({ "tick": tick })) {
                        eprintln!("clock publisher stopped: {error}");
                        break;
                    }
                });
            }
            Ok(json!({ "started": true }))
        }
        "snapshot" => Ok(json!({ "tick": counter.load(Ordering::Relaxed) })),
        method => Err(Error::unknown_method(method)),
    })
}
