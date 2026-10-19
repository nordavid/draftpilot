// Release-Build ohne Konsolenfenster.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod champions;
mod engine;
mod lcu;
mod log;
mod model;
mod settings;
mod state;

fn main() {
    app::run();
}
