// The Mac shell of apps/chat. The window shows the chat that the box serves, so a web release needs no Mac build.
// Rust only wires the window, the menu and link handling; the chat itself lives in apps/chat.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_opener::OpenerExt;

/// The bundled start page in ../src. It checks that the box answers, then loads `to`, or shows a retry page.
const START_PAGE: &str = "tauri://localhost/index.html";

fn start_url(target: &Url) -> Url {
    let mut url = Url::parse(START_PAGE).expect("START_PAGE is a valid URL");
    url.query_pairs_mut().append_pair("to", target.as_str());
    url
}

/// The chat URL is the main window's `url` in tauri.conf.json.
fn box_url(app: &AppHandle) -> Url {
    let window = app.config().app.windows.iter().find(|w| w.label == "main").expect("tauri.conf.json has a main window");
    match &window.url {
        WebviewUrl::External(url) => url.clone(),
        other => panic!("the main window url must be the box's https URL, found {other:?}"),
    }
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(app, &name, true, &[
        &PredefinedMenuItem::about(app, None, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let view = Submenu::with_items(app, "View", true, &[
        &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::close_window(app, None)?,
    ])?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .menu(menu)
        .on_menu_event(|app, event| {
            if event.id() != "reload" {
                return;
            }
            let Some(window) = app.get_webview_window("main") else { return };
            let home = box_url(app);
            // Reload goes through the start page, so a box that stopped answering shows the retry page, not a blank window.
            let target = window.url().ok().filter(|url| url.origin() == home.origin()).unwrap_or(home);
            let _ = window.navigate(start_url(&target));
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let home = box_url(&handle);
            let mut config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window");
            config.url = WebviewUrl::CustomProtocol(start_url(&home));
            let (on_nav, on_new) = (handle.clone(), handle.clone());
            let origin = home.origin();
            WebviewWindowBuilder::from_config(&handle, &config)?
                .on_navigation(move |url| {
                    if url.origin() == origin || matches!(url.scheme(), "tauri" | "about" | "blob" | "data") {
                        return true;
                    }
                    open_outside(&on_nav, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    open_outside(&on_new, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Sieun Chat failed to start");
}
