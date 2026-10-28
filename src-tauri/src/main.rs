// Release builds run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod champions;
mod engine;
mod lcu;
mod log;
mod model;
mod queue;
mod settings;
mod state;

fn main() {
    app::run();
}
