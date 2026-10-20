//! Logging: ring buffer for the GUI log plus the console in dev mode.
//! Messages are English and ASCII (the Windows console garbles UTF-8).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::model::{now_ms, LogEntry, LogLevel};

const MAX_BUFFER: usize = 500;

type Sink = Box<dyn Fn(&LogEntry) + Send + Sync>;

#[derive(Default)]
pub struct LogHub {
    buffer: Mutex<VecDeque<LogEntry>>,
    sink: Mutex<Option<Sink>>,
}

impl LogHub {
    pub fn new() -> Arc<LogHub> {
        Arc::new(LogHub::default())
    }

    /// Forward new entries live (the GUI bridge streams them to the frontend).
    pub fn set_sink(&self, sink: Sink) {
        *self.sink.lock().unwrap() = Some(sink);
    }

    pub fn history(&self) -> Vec<LogEntry> {
        self.buffer.lock().unwrap().iter().cloned().collect()
    }

    fn write(&self, scope: &str, level: LogLevel, message: String) {
        let entry = LogEntry { ts: now_ms(), scope: scope.to_string(), level, message };
        let marker = match level {
            LogLevel::Event => '>',
            LogLevel::Error => 'x',
            LogLevel::Warn => '!',
            LogLevel::Info => '.',
        };
        println!("{} [{}] {}", marker, entry.scope, entry.message);
        {
            let mut buf = self.buffer.lock().unwrap();
            buf.push_back(entry.clone());
            if buf.len() > MAX_BUFFER {
                buf.pop_front();
            }
        }
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink(&entry);
        }
    }
}

/// Logger with a fixed scope (e.g. "lcu", "champselect").
#[derive(Clone)]
pub struct Logger {
    scope: &'static str,
    hub: Arc<LogHub>,
}

impl Logger {
    pub fn new(hub: &Arc<LogHub>, scope: &'static str) -> Logger {
        Logger { scope, hub: hub.clone() }
    }

    pub fn info(&self, message: impl Into<String>) {
        self.hub.write(self.scope, LogLevel::Info, message.into());
    }

    pub fn warn(&self, message: impl Into<String>) {
        self.hub.write(self.scope, LogLevel::Warn, message.into());
    }

    pub fn error(&self, message: impl Into<String>) {
        self.hub.write(self.scope, LogLevel::Error, message.into());
    }

    /// Highlighted events (phase changes, hover, lock ...).
    pub fn event(&self, message: impl Into<String>) {
        self.hub.write(self.scope, LogLevel::Event, message.into());
    }
}
