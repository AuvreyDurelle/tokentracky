//! The menu bar, dashboard window and in-process `app://` scheme.
//!
//! An accessory app: no Dock icon. The title shows today's tokens and the menu the summary and actions. One instance
//! runs: a second launch opens the dashboard (`second-instance`), as does reopening the running app from Finder
//! (`activate`). A manual launch opens the dashboard once the collector is ready; the login item starts with
//! `--hidden` and does not. Wake from sleep refreshes when the last cycle is stale.
//!
//! The window loads `app://localhost/`, and the scheme handler passes every request to the local API router
//! in-process, which serves the React build and `/api/*` with its security headers; nothing listens on TCP.
//! Closing the window destroys the web view, and the teardown workarounds release WebKit's processes.
//!
//! Data lives where the CLI keeps it: `$TOKENTRACKY_HOME` when set, else `~/.tokentracky`,
//! with the database in `usage.sqlite`, so `tokentracky status` reads what the app collects and the single-writer lock
//! keeps `serve` and the app from running at once. The leaderboard credential is a private file there, also shared.
//!
//! For `scripts/measure-footprint.sh`: lines prefixed `[tokentracky]` on stderr (`title-set` with the startup times,
//! `page-load finished`, `window destroyed`), and a second launch with `--close-dashboard` closes the dashboard the
//! way the window's close button does (with `--open-dashboard`, or nothing, it opens it).
use crate::backend::{self, Backend};
use crate::menu::{self, Entry};
use crate::native;
use crate::popover;
use crate::security::{self, ORIGIN};
use crate::shell::{self, ShellRequest};
#[cfg(tokentracky_release_updater)]
use crate::updates;
use crate::updates::Updates;
use axum::body::Body;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};
use tauri::http::{Request, Response, StatusCode};
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{
    ActivationPolicy, AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, UriSchemeContext,
    UriSchemeResponder, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;
#[cfg(tokentracky_release_updater)]
use tauri_plugin_updater::UpdaterExt as _;
use tokentracky_local_api::{
    LocalOptions, LocalOverview, ReqwestClient, SecretStore, claude_config_file, detect_tools,
};
use tokentracky_secrets::FileSecretStore;
use tower::ServiceExt as _;

const DASHBOARD: &str = "dashboard";
const POPOVER: &str = "popover";
/// The popover's width and height in points.
const POPOVER_SIZE: (f64, f64) = (380.0, 640.0);
const TRAY: &str = "main";
/// Start in the menu bar without opening the dashboard: the login item's argument.
const HIDDEN: &str = "--hidden";
const CLOSE_DASHBOARD: &str = "--close-dashboard";

/// Fixed local actions only: no script evaluation, arbitrary URL, or navigation allowlist bypass.
fn control(app: &AppHandle, args: &[String]) {
    if args.iter().any(|arg| arg == "--quit") {
        log("graceful quit requested");
        app.exit(0);
    } else if args.iter().any(|arg| arg == CLOSE_DASHBOARD) {
        close_dashboard(app);
    } else if args.iter().any(|arg| arg == "--refresh") {
        with_service(app, |_, backend| async move {
            let result = backend.refresh().await;
            let (synced_at, sync_error) = backend.sync_status().await;
            log(&format!(
                "manual refresh finished ok={} sync_at={synced_at:?} sync_error={sync_error:?}",
                result.is_ok()
            ));
        });
    } else if let Some(paused) = args.iter().find_map(|arg| match arg.as_str() {
        "--pause" => Some(true),
        "--resume" => Some(false),
        _ => None,
    }) {
        with_service(app, move |_, backend| async move {
            backend.set_paused(paused).await;
            backend.publish().await;
            log(&format!("collection paused={paused}"));
        });
    } else if args.iter().any(|arg| arg == "--open-you" || arg == "--open-dashboard") {
        open_page(app, start_page(args.iter()));
    } else if args.iter().any(|arg| arg == "--open-popover") {
        // What a click on the icon opens, at the icon's current place.
        if let Some(tray) = app.tray_by_id(TRAY).and_then(|tray| tray.rect().ok().flatten()) {
            open_popover(app, tray);
        }
    } else {
        open_dashboard(app);
    }
}
const SLOGAN: &str = "Waste tokens, not time.";

#[cfg(tokentracky_release_updater)]
const UPDATER_ENABLED: bool = true;
#[cfg(not(tokentracky_release_updater))]
const UPDATER_ENABLED: bool = false;

/// The running service: empty while it starts, or if it could not.
#[derive(Default)]
struct Service(Mutex<Option<Arc<Backend>>>);
/// The overview the menu shows, kept to rebuild the menu after a launch-at-login change.
#[derive(Default)]
struct Shown(Mutex<Option<LocalOverview>>);
/// The updater is only enabled by the signed-release build path; development builds are explicit
/// about having no updater rather than trying an empty endpoint.
struct UpdateShown(Mutex<Updates>);

#[cfg(tokentracky_release_updater)]
#[derive(Default)]
struct UpdateTask(Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

static LAUNCHED: OnceLock<Instant> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn log(line: &str) {
    eprintln!("[tokentracky] {line}");
}

fn service(app: &AppHandle) -> Option<Arc<Backend>> {
    lock(&app.state::<Service>().0).clone()
}

pub fn run() {
    LAUNCHED.get_or_init(Instant::now);
    let hidden = std::env::args().any(|arg| arg == HIDDEN);
    let builder = tauri::Builder::default()
        // First: a second launch hands its arguments to the running app and exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || control(&handle, &args));
        }))
        // A launch agent, which passes `--hidden`; System Events' login items take no arguments.
        .plugin(tauri_plugin_autostart::Builder::new().arg(HIDDEN).build())
        // No injected link handler: links reach `on_navigation` and `on_new_window` natively, so the page needs no
        // IPC permission at all.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("app", serve)
        .manage(Service::default())
        .manage(Shown::default())
        .manage(UpdateShown(Mutex::new(Updates::new(UPDATER_ENABLED))))
        .on_window_event(|window, event| match event {
            // The popover is transient: it closes once anything else takes focus.
            WindowEvent::Focused(false) if window.label() == POPOVER => drop(window.close()),
            WindowEvent::Destroyed => {
                log("window destroyed");
                release_webkit(window.app_handle().clone());
            }
            _ => {}
        });
    #[cfg(tokentracky_release_updater)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(UpdateTask::default());
    builder
        .setup(move |app| {
            // A control-only launch with no running instance must not start a collector or open a window.
            if std::env::args().any(|arg| {
                matches!(
                    arg.as_str(),
                    "--quit" | "--close-dashboard" | "--refresh" | "--pause" | "--resume"
                )
            }) {
                app.handle().exit(0);
                return Ok(());
            }
            app.set_activation_policy(ActivationPolicy::Accessory);
            let handle = app.handle();
            // Launch at login starts on, once per Mac account; turning it off afterwards sticks.
            if let Ok(config) = app.path().app_config_dir() {
                shell::launch_at_login_once(&config.join(shell::LAUNCH_AT_LOGIN_SET), || {
                    handle.autolaunch().enable().is_ok()
                });
                #[cfg(tokentracky_release_updater)]
                {
                    lock(&handle.state::<UpdateShown>().0).reminder =
                        updates::Reminder::read(&config.join(updates::REMINDER_FILE));
                }
            }
            let tray = TrayIconBuilder::with_id(TRAY)
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)
                .tooltip(menu::tooltip(None))
                // A left click toggles the popover; the menu stays on a right click.
                .menu(&build_menu(handle, None)?)
                .show_menu_on_left_click(false)
                .on_menu_event(on_menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle(), rect);
                    }
                })
                .build(app)?;
            native::use_monospaced_digits(&tray);
            let waking = handle.clone();
            native::on_wake(move || {
                log("workspace wake received");
                if let Some(backend) = service(&waking) {
                    tauri::async_runtime::spawn(async move { backend.wake().await });
                }
            });
            start(handle.clone(), hidden);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Tauri app builds")
        .run(|app, event| match event {
            // The menu bar keeps running with no window open; only Quit exits.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Reopen { .. } => open_dashboard(app),
            RunEvent::Exit => shutdown(app),
            _ => {}
        });
}

/// Opens the collector off the main thread, then starts the cycle, shows the first overview and, unless `hidden`,
/// opens the dashboard.
fn start(app: AppHandle, hidden: bool) {
    tauri::async_runtime::spawn(async move {
        let secrets: Arc<dyn SecretStore> = match FileSecretStore::from_env() {
            Ok(store) => Arc::new(store),
            Err(_) => {
                log("invalid test Keychain namespace; refusing to start");
                app.exit(1);
                return;
            }
        };
        let configured = std::env::var("TOKENTRACKY_CLOUD_URL")
            .ok()
            .filter(|value| !value.is_empty());
        // The local API prefers a saved link at request time. Keep the fallback so unlinking
        // can join again in this same process, without a restart or shell configuration.
        let cloud_url = match security::configured_cloud_origin(configured.as_deref()) {
            Ok(origin) => Some(origin),
            Err(error) => {
                alert(&app, "Leaderboard configuration is invalid", error.message);
                None
            }
        };
        let opening = app.clone();
        let opened = tauri::async_runtime::spawn_blocking(move || open_backend(&opening, cloud_url, secrets)).await;
        let Ok(Some(backend)) = opened else {
            return alert(
                &app,
                "Tokentracky could not start",
                "The local collection service is unavailable.",
            );
        };
        let backend = Arc::new(backend);
        *lock(&app.state::<Service>().0) = Some(backend.clone());
        backend.publish().await;
        backend.start().await;
        #[cfg(tokentracky_release_updater)]
        start_automatic_updates(&app);
        if !hidden {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || open_page(&handle, start_page(std::env::args())));
        }
    });
}

/// `None` when the data directory, the web build or the collector cannot be opened (for example while `tokentracky
/// serve` owns the same data directory).
fn open_backend(app: &AppHandle, cloud_url: Option<String>, secrets: Arc<dyn SecretStore>) -> Option<Backend> {
    let env = |name| std::env::var(name).ok().filter(|value| !value.is_empty());
    let data_dir = match env("TOKENTRACKY_HOME") {
        Some(home) => PathBuf::from(home),
        None => app.path().home_dir().ok()?.join(".tokentracky"),
    };
    let home = std::env::home_dir().unwrap_or_default();
    let options = LocalOptions {
        database_path: data_dir.join(backend::DATABASE),
        web_root: app.path().resource_dir().ok()?.join("web"),
        cloud_url,
        secrets,
        client: Arc::new(ReqwestClient::new().ok()?),
        pricing_refresh: tokentracky_pricing::pricing_refresh_enabled(env("TOKENTRACKY_PRICING_REFRESH").as_deref()),
        initially_paused: false,
        refresh_interval_ms: None,
        on_refresh: None,
        detected: detect_tools(|key| std::env::var(key).ok(), &home),
        claude_config_file: Some(claude_config_file(|key| std::env::var(key).ok(), &home)),
    };
    let handle = app.clone();
    let publish = Arc::new(move |overview| {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || show(&app, overview));
    });
    Backend::open(options, publish).ok()
}

/// Stops the cycle and sync and closes the collector, for every way out (Quit, the app menu's Quit, log out), giving
/// up after 10 s as Electron did.
fn shutdown(app: &AppHandle) {
    lock(&app.state::<UpdateShown>().0).stop();
    #[cfg(tokentracky_release_updater)]
    if let Some(task) = lock(&app.state::<UpdateTask>().0).take() {
        task.abort();
    }
    let Some(backend) = lock(&app.state::<Service>().0).take() else {
        return;
    };
    tauri::async_runtime::block_on(async move {
        let closed = matches!(
            tokio::time::timeout(Duration::from_secs(10), backend.close()).await,
            Ok(true)
        );
        log(&format!("backend shutdown finished ok={closed}"));
    });
}

// ---- Menu bar ----

fn show(app: &AppHandle, overview: LocalOverview) {
    log(&format!(
        "overview refresh={:?} refreshing={} paused={}",
        overview.refresh.last_refresh_at, overview.refresh.refreshing, overview.paused
    ));
    *lock(&app.state::<Shown>().0) = Some(overview);
    rebuild(app);
    static TITLE_SET: AtomicBool = AtomicBool::new(false);
    if !TITLE_SET.swap(true, Ordering::SeqCst) {
        let ms = |elapsed: Duration| format!("{:.1}", elapsed.as_secs_f64() * 1000.0);
        let exec = native::process_start().and_then(|start| SystemTime::now().duration_since(start).ok());
        log(&format!(
            "title-set pid={} main_to_title_ms={} exec_to_title_ms={}",
            std::process::id(),
            LAUNCHED
                .get()
                .map_or_else(|| "unknown".into(), |launched| ms(launched.elapsed())),
            exec.map_or_else(|| "unknown".into(), ms),
        ));
    }
}

/// Title, tooltip and menu from the overview shown.
fn rebuild(app: &AppHandle) {
    let overview = lock(&app.state::<Shown>().0).clone();
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let _ = tray.set_title(Some(menu::title(overview.as_ref())));
    let _ = tray.set_tooltip(Some(menu::tooltip(overview.as_ref())));
    if let Ok(built) = build_menu(app, overview.as_ref()) {
        let _ = tray.set_menu(Some(built));
    }
}

fn build_menu(app: &AppHandle, overview: Option<&LocalOverview>) -> tauri::Result<Menu<Wry>> {
    let launch_at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let update = lock(&app.state::<UpdateShown>().0).state.clone();
    native_menu(
        app,
        menu::entries(overview, launch_at_login, &update, native::local_time),
    )
}

fn native_menu(app: &AppHandle, entries: Vec<Entry>) -> tauri::Result<Menu<Wry>> {
    let built = Menu::new(app)?;
    for entry in entries {
        match entry {
            Entry::Line(text) => built.append(&MenuItem::new(app, text, false, None::<&str>)?)?,
            Entry::Separator => built.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Action { id, label, enabled } => {
                built.append(&MenuItem::with_id(app, id, label, enabled, None::<&str>)?)?
            }
            Entry::Check { id, label, checked } => {
                built.append(&CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>)?)?
            }
        }
    }
    Ok(built)
}

/// The gear menu at the pointer, over the window `label` that asked for it. Its items are handled by `on_menu`, which
/// the tray's handler receives for every menu.
fn gear_menu(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let overview = lock(&app.state::<Shown>().0).clone();
    let update = lock(&app.state::<UpdateShown>().0).state.clone();
    let launch_at_login = app.autolaunch().is_enabled().unwrap_or(false);
    if let Ok(built) = native_menu(app, menu::gear_entries(overview.as_ref(), launch_at_login, &update)) {
        let _ = window.popup_menu(&built);
    }
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        menu::REFRESH => with_service(app, |app, backend| async move {
            if backend.refresh().await.is_err() {
                alert(
                    &app,
                    "Tokentracky refresh failed",
                    "The local collection service could not refresh.",
                );
            }
        }),
        menu::OPEN => open_dashboard(app),
        menu::PAUSE => {
            // The item does what it says: "Pause collection" unless the menu shows collection paused.
            let paused = lock(&app.state::<Shown>().0).as_ref().is_some_and(|shown| shown.paused);
            with_service(app, move |_, backend| async move {
                backend.set_paused(!paused).await;
                backend.publish().await;
            })
        }
        menu::LOGIN => set_launch_at_login(app, !app.autolaunch().is_enabled().unwrap_or(false)),
        menu::CHECK_FOR_UPDATES => check_for_updates(app),
        menu::DOWNLOAD_UPDATE => download_update(app),
        menu::RESTART_TO_UPDATE => app.request_restart(),
        menu::SETTINGS => open_page(app, "/settings"),
        menu::ABOUT => native::about(SLOGAN),
        menu::QUIT => app.exit(0),
        _ => {}
    }
}

/// Turns the login item on or off, then shows it in the menu (at once on the main thread, else queued there).
fn set_launch_at_login(app: &AppHandle, enabled: bool) {
    let autolaunch = app.autolaunch();
    let _ = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || rebuild(&handle));
}

#[cfg(tokentracky_release_updater)]
fn update_state(app: &AppHandle) -> menu::UpdateState {
    lock(&app.state::<UpdateShown>().0).state.clone()
}

#[cfg(tokentracky_release_updater)]
fn rebuild_updates(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || rebuild(&handle));
}

#[cfg(tokentracky_release_updater)]
fn start_automatic_updates(app: &AppHandle) {
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(updates::STARTUP_DELAY).await;
        loop {
            run_update_check(&handle, false).await;
            tokio::time::sleep(updates::CHECK_INTERVAL).await;
        }
    });
    *lock(&app.state::<UpdateTask>().0) = Some(task);
}

#[cfg(tokentracky_release_updater)]
fn check_for_updates(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { run_update_check(&handle, true).await });
}

#[cfg(tokentracky_release_updater)]
async fn run_update_check(app: &AppHandle, manual: bool) {
    if !lock(&app.state::<UpdateShown>().0).begin_check() {
        return;
    }
    rebuild_updates(app);
    let result = match app.updater_builder().timeout(Duration::from_secs(30)).build() {
        Ok(updater) => updater.check().await.map(|update| update.map(|update| update.version)),
        Err(error) => Err(error),
    };
    let version = result.as_ref().ok().cloned().flatten();
    if !lock(&app.state::<UpdateShown>().0).finish_check(version) {
        return;
    }
    rebuild_updates(app);
    match result {
        Ok(Some(version)) => prompt_update(app, version, manual),
        Ok(None) if manual => alert(app, "Tokentracky is up to date", "No newer signed update is available."),
        Err(_) if manual => alert(
            app,
            "Tokentracky could not check for updates",
            "Continue working normally and try again when your connection is available.",
        ),
        _ => {} // Background checks are silent when up to date or offline.
    }
}

#[cfg(tokentracky_release_updater)]
fn prompt_update(app: &AppHandle, version: String, manual: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let reminder = lock(&handle.state::<UpdateShown>().0).begin_prompt(&version, manual, SystemTime::now());
        let Some(reminder) = reminder else { return };
        let action_app = handle.clone();
        let selected = version.clone();
        let shown = native::confirm(
            "A Tokentracky update is available",
            &format!(
                "Version {version} is available. Update now to download and install it. You choose when to restart."
            ),
            "Update now",
            move |accepted| {
                let current = lock(&action_app.state::<UpdateShown>().0).finish_prompt(&selected);
                if accepted && current {
                    download_update(&action_app);
                }
            },
        );
        if shown {
            if let Ok(config) = handle.path().app_config_dir() {
                let _ = reminder.save(&config.join(updates::REMINDER_FILE));
            }
        } else {
            lock(&handle.state::<UpdateShown>().0).finish_prompt(&version);
        }
    });
}

#[cfg(not(tokentracky_release_updater))]
fn check_for_updates(app: &AppHandle) {
    alert(
        app,
        "Updates unavailable in this build",
        "Unsigned development builds do not check for or install updates.",
    );
}

#[cfg(tokentracky_release_updater)]
fn download_update(app: &AppHandle) {
    let Some(expected_version) = lock(&app.state::<UpdateShown>().0).begin_download() else {
        return;
    };
    rebuild_updates(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Check again immediately before download. The version must match the one the user saw;
        // a changed or unavailable feed never installs an unexpected update.
        let result = match handle.updater_builder().timeout(Duration::from_secs(5 * 60)).build() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) if update.version == expected_version => update
                    .download_and_install(|_, _| {}, || {})
                    .await
                    .map_err(|error| error.to_string()),
                Ok(Some(_)) => Err("The available update changed; check again before downloading.".into()),
                Ok(None) => Err("The selected update is no longer available; check again.".into()),
                Err(error) => Err(error.to_string()),
            },
            Err(error) => Err(error.to_string()),
        };
        if !lock(&handle.state::<UpdateShown>().0).finish_download(&expected_version, result.is_ok()) {
            return;
        }
        rebuild_updates(&handle);
        match result {
            Ok(()) => {
                let action_app = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if update_state(&action_app) != menu::UpdateState::Ready(expected_version.clone()) {
                        return;
                    }
                    let restart_app = action_app.clone();
                    native::confirm(
                        "Tokentracky is ready to restart",
                        &format!("Version {expected_version} was verified and installed. Restart to finish updating."),
                        "Restart now",
                        move |accepted| {
                            if accepted && update_state(&restart_app) == menu::UpdateState::Ready(expected_version) {
                                restart_app.request_restart();
                            }
                        },
                    );
                });
            }
            Err(_) => {
                // `download_and_install` verifies before writing the replacement. An interrupted
                // download or invalid signature therefore leaves the running version intact.
                alert(
                    &handle,
                    "Tokentracky update failed",
                    "The update could not be completed. Keep the app running and retry; if restart fails, reinstall the verified release.",
                );
            }
        }
    });
}

#[cfg(not(tokentracky_release_updater))]
fn download_update(app: &AppHandle) {
    check_for_updates(app);
}

/// Runs `action` with the service on the async runtime; without one, says the collection service is unavailable.
fn with_service<F: Future<Output = ()> + Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(AppHandle, Arc<Backend>) -> F,
) {
    match service(app) {
        Some(backend) => drop(tauri::async_runtime::spawn(action(app.clone(), backend))),
        None => alert(
            app,
            "Tokentracky collection unavailable",
            "The local collection service is unavailable.",
        ),
    }
}

fn alert(app: &AppHandle, title: impl Into<String>, message: impl Into<String>) {
    let (title, message) = (title.into(), message.into());
    let _ = app.run_on_main_thread(move || native::alert(&title, &message));
}

// ---- The app:// scheme ----

/// Every request of the window goes to the router in-process: the React build, `/api/*` and the JSON 404. The shell
/// routes (`shell.rs`) are answered here first, without the router.
fn serve(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    if let Some(parsed) = shell::parse(request.method().as_str(), request.uri().path(), request.body()) {
        let (app, label) = (ctx.app_handle().clone(), ctx.webview_label().to_owned());
        tauri::async_runtime::spawn(carry_out(app, label, parsed, responder));
        return;
    }
    let Some(backend) = service(ctx.app_handle()) else {
        let mut response = Response::new(Vec::new());
        *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
        return responder.respond(response);
    };
    tauri::async_runtime::spawn(async move {
        let Some(router) = backend.router().await else {
            let mut response = Response::new(Vec::new());
            *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
            return responder.respond(response);
        };
        let response = router
            .oneshot(request.map(Body::from))
            .await
            .unwrap_or_else(|never| match never {});
        responder.respond(collect(response).await);
    });
}

async fn collect(response: axum::response::Response) -> Response<Vec<u8>> {
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
    Response::from_parts(parts, bytes.to_vec())
}

/// Carries out a page's request (from the window `label`) with the menu's code, off WebKit's call: the scheme handler
/// runs on the main thread while WebKit waits, so a menu opened there would hold the answer, and a window opened
/// there would take focus from the page that asked inside the call. Launch at login and the update check change what
/// the answer reports and only queue their menu changes, so they run first; opening the dashboard, the gear menu and
/// quitting are queued on the main thread once the answer is sent.
async fn carry_out(
    app: AppHandle,
    label: String,
    request: Result<ShellRequest, shell::Refusal>,
    responder: UriSchemeResponder,
) {
    let answer = match request {
        Err(refusal) => Err(refusal),
        Ok(ShellRequest::OpenDashboard(_) | ShellRequest::GearMenu | ShellRequest::Quit) => Ok(None),
        Ok(request) => {
            match request {
                ShellRequest::LaunchAtLogin(enabled) => set_launch_at_login(&app, enabled),
                // A build without the updater answers its disabled state instead of the menu's alert.
                ShellRequest::CheckForUpdates if UPDATER_ENABLED => check_for_updates(&app),
                _ => {}
            }
            Ok(Some(shell_state(&app)))
        }
    };
    responder.respond(collect(shell::respond(answer)).await);
    let handle = app.clone();
    match request {
        Ok(ShellRequest::OpenDashboard(page)) => drop(app.run_on_main_thread(move || open_page(&handle, page))),
        Ok(ShellRequest::GearMenu) => drop(app.run_on_main_thread(move || gear_menu(&handle, &label))),
        Ok(ShellRequest::Quit) => app.exit(0),
        _ => {}
    }
}

/// What `GET /api/shell/state` answers.
fn shell_state(app: &AppHandle) -> serde_json::Value {
    let update = lock(&app.state::<UpdateShown>().0).state.clone();
    let launch_at_login = app.autolaunch().is_enabled().unwrap_or(false);
    shell::state(launch_at_login, &update, &app.package_info().version.to_string())
}

// ---- Dashboard window ----

/// Opens `url` in the browser if it is at the linked or configured hosted origin.
fn open_external(app: &AppHandle, url: &str) {
    let Some(backend) = service(app) else { return };
    let (app, url) = (app.clone(), url.to_owned());
    tauri::async_runtime::spawn(async move {
        if security::is_allowed_external_url(&url, backend.remote_origin().await.as_deref()) {
            let _ = app.opener().open_url(url, None::<&str>);
        }
    });
}

fn open_dashboard(app: &AppHandle) {
    // Finder activation should preserve the route the user is viewing.
    if let Some(window) = app.get_webview_window(DASHBOARD) {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        open_page(app, "/");
    }
}

/// `/you` with `--open-you`, else `/`.
fn start_page<A: AsRef<str>>(mut args: impl Iterator<Item = A>) -> &'static str {
    if args.any(|arg| arg.as_ref() == "--open-you") {
        "/you"
    } else {
        "/"
    }
}

/// The dashboard at `page`, a fixed path of the app's own origin: navigated there if open, else opened.
fn open_page(app: &AppHandle, page: &str) {
    let url = format!("{ORIGIN}{page}").parse().expect("a fixed app URL");
    if let Some(window) = app.get_webview_window(DASHBOARD) {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    if service(app).is_none() {
        return native::alert(
            "Tokentracky dashboard unavailable",
            "The local dashboard could not be opened.",
        );
    }
    let builder = WebviewWindowBuilder::new(app, DASHBOARD, WebviewUrl::CustomProtocol(url))
        .title("Tokentracky")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        // An ephemeral data store is released with the web view, so WebKit's Networking process can exit too. The
        // local UI keeps no web storage that must survive a window close; anything it persists goes through the API.
        .incognito(true);
    match secure_webview(app, builder, |_| {}).build() {
        Ok(window) => drop(window.set_focus()),
        Err(_) => native::alert(
            "Tokentracky dashboard unavailable",
            "The local dashboard could not be opened.",
        ),
    }
}

/// The URL boundary of every window (`security.rs`): only the app's own origin renders, links leave for the browser
/// only at the hosted origin, no new windows, downloads only of the app's own blobs. Logs each finished page load,
/// then calls `on_loaded`.
fn secure_webview<'a>(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
    on_loaded: impl Fn(&WebviewWindow) + Send + Sync + 'static,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let (navigating, opening) = (app.clone(), app.clone());
    builder
        .on_navigation(move |url| {
            let own = security::is_app_url(url.as_str());
            if !own {
                open_external(&navigating, url.as_str());
            }
            own
        })
        .on_new_window(move |url, _features| {
            open_external(&opening, url.as_str());
            NewWindowResponse::Deny
        })
        // Without a handler wry cancels every download. The CSV export's blob goes to ~/Downloads, WebKit's default
        // destination, with " (1)" suffixes and no save panel.
        .on_download(|_webview, event| match event {
            DownloadEvent::Requested { url, .. } => security::is_app_download(url.as_str()),
            _ => true,
        })
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                log(&format!("page-load finished path={}", payload.url().path()));
                on_loaded(&window);
            }
        })
}

fn toggle_popover(app: &AppHandle, tray: tauri::Rect) {
    match app.get_webview_window(POPOVER) {
        Some(popover) => drop(popover.close()),
        None => open_popover(app, tray),
    }
}

/// The popover under the icon at `tray`, unless it is open: a short-lived web view of `/popover`, destroyed when it
/// closes so no WebKit runs while it is closed.
fn open_popover(app: &AppHandle, tray: tauri::Rect) {
    if let Some(popover) = app.get_webview_window(POPOVER) {
        // Still loading, it logs "popover visible" once it is shown.
        if popover.is_visible().unwrap_or(false) {
            log("popover already open");
        }
        return;
    }
    if service(app).is_none() {
        return native::alert(
            "Tokentracky popover unavailable",
            "The menu bar popover could not be opened.",
        );
    }
    let Some((x, y)) = popover_position(app, tray) else {
        return log("popover has no screen");
    };
    let url = format!("{ORIGIN}/popover").parse().expect("a fixed app URL");
    let effects = EffectsBuilder::new()
        .effect(Effect::Popover)
        .state(EffectState::Active)
        .radius(14.0)
        .build();
    let builder = WebviewWindowBuilder::new(app, POPOVER, WebviewUrl::CustomProtocol(url))
        .inner_size(POPOVER_SIZE.0, POPOVER_SIZE.1)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(true)
        .effects(effects)
        .incognito(true);
    if secure_webview(app, builder, show_popover).build().is_err() {
        native::alert(
            "Tokentracky popover unavailable",
            "The menu bar popover could not be opened.",
        );
    }
}

/// Shows the popover, built hidden, once its page has loaded, so it never appears empty. An accessory app is not
/// active: activate it, so the popover takes focus and loses it on a click elsewhere.
fn show_popover(popover: &WebviewWindow) {
    let _ = popover.run_on_main_thread(native::activate_app);
    let _ = popover.show();
    let _ = popover.set_focus();
    log("popover visible");
}

/// The popover's top left in points, on the screen that holds the icon. The tray reports `tray` in pixels at that
/// screen's scale, and each monitor its frame in pixels at its own, so the icon's scale comes from the icon itself.
fn popover_position(app: &AppHandle, tray: tauri::Rect) -> Option<(f64, f64)> {
    let rect = |position: PhysicalPosition<f64>, size: PhysicalSize<f64>| popover::Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let scale = native::tray_scale(&app.tray_by_id(TRAY)?)?;
    let icon = rect(tray.position.to_physical(scale), tray.size.to_physical(scale)).points(scale);
    let screens: Vec<_> = app
        .available_monitors()
        .ok()?
        .iter()
        .map(|monitor| {
            let visible = monitor.work_area();
            popover::Screen {
                frame: rect(monitor.position().cast(), monitor.size().cast()),
                visible: rect(visible.position.cast(), visible.size.cast()),
                scale: monitor.scale_factor(),
            }
        })
        .collect();
    let screen = popover::tray_screen(icon, &screens)?;
    Some(popover::popover_origin(
        icon,
        POPOVER_SIZE,
        screen.visible.points(screen.scale),
    ))
}

fn close_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(DASHBOARD) {
        // The close button's path: CloseRequested, then the window and web view are destroyed.
        let _ = window.close();
    }
}

/// After a close: drain the autorelease pool, which holds the closed web view, for a second (the runtime may drop the
/// web view after the Destroyed event, so one drain can come too early). While another window is open that is all:
/// it keeps its own WebContent process and the GPU process. After the last window, keep draining until WebContent has
/// exited, then, if no window has reopened, end the GPU process WebKit would keep 30 to 70 s longer. A thread that
/// lives at most 10 s, not a timer.
fn release_webkit(app: AppHandle) {
    std::thread::spawn(move || {
        let mut released = false;
        for attempt in 0..100 {
            let _ = app.run_on_main_thread(native::drain_autorelease_pool);
            std::thread::sleep(Duration::from_millis(100));
            if attempt < 9 {
                continue;
            }
            if !app.webview_windows().is_empty() {
                return log("gpu helper kept window_open=true");
            }
            if native::webkit_helpers("com.apple.WebKit.WebContent").is_empty() {
                released = true;
                break;
            }
        }
        if !released {
            return log("gpu helper kept web_content_released=false");
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if handle.webview_windows().is_empty() && native::webkit_helpers("com.apple.WebKit.WebContent").is_empty() {
                for (pid, ended) in native::end_gpu_process() {
                    log(&format!("gpu helper ended pid={pid} ok={ended}"));
                }
            }
        });
    });
}
