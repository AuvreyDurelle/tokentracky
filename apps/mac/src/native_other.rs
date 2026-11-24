//! What `native.rs` does with AppKit, on Windows and Linux: alerts, the update prompts and About as native message
//! dialogs (rfd), local times through jiff, the icon's scale from its monitor. Monospaced digits, wake notifications,
//! activation and the process start time have no counterpart and do nothing: the five-minute cycle covers a wake.
use jiff::Timestamp;
use jiff::tz::TimeZone;
use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
#[cfg(tokentracky_release_updater)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;
use tauri::tray::TrayIcon;

pub fn use_monospaced_digits(_tray: &TrayIcon) {}

/// The scale of the monitor under the icon, else of the primary monitor: Tauri reports the icon's rect in pixels.
pub fn tray_scale(tray: &TrayIcon) -> Option<f64> {
    let app = tray.app_handle();
    let under_icon = tray.rect().ok().flatten().and_then(|rect| {
        let (position, size) = (rect.position.to_physical::<f64>(1.0), rect.size.to_physical::<f64>(1.0));
        app.monitor_from_point(position.x + size.width / 2.0, position.y + size.height / 2.0)
            .ok()
            .flatten()
    });
    let monitor = under_icon.or_else(|| app.primary_monitor().ok().flatten())?;
    Some(monitor.scale_factor())
}

pub fn on_wake(_wake: impl Fn() + 'static) {}

/// An ISO timestamp as a local time of day.
pub fn local_time(iso: &str) -> String {
    short_time(iso, &TimeZone::system())
}

/// `iso` as hours and minutes on a 24-hour clock in `zone`: jiff knows the zone but not the user's clock format.
/// Unparsed, it stays as it is.
fn short_time(iso: &str, zone: &TimeZone) -> String {
    iso.parse::<Timestamp>().map_or_else(
        |_| iso.to_owned(),
        |at| at.to_zoned(zone.clone()).strftime("%H:%M").to_string(),
    )
}

pub fn activate_app() {}

/// A message dialog that holds nothing up, as tauri-plugin-dialog shows one: rfd runs it (on its own GTK thread on
/// Linux, a thread of its own on Windows) and a thread waits for the button chosen, then calls `done` with it.
fn show(title: &str, message: &str, buttons: MessageButtons, done: impl FnOnce(MessageDialogResult) + Send + 'static) {
    let shown = AsyncMessageDialog::new()
        .set_level(MessageLevel::Info)
        .set_title(title)
        .set_description(message)
        .set_buttons(buttons)
        .show();
    std::thread::spawn(move || done(tauri::async_runtime::block_on(shown)));
}

/// A failure the user should see. Not modal, as on macOS: collection and the menu keep working while it is open.
pub fn alert(title: &str, message: &str) {
    show(title, message, MessageButtons::Ok, drop);
}

/// A nonmodal choice between `yes` and Later; `response` learns whether `yes` was chosen. Shows nothing and returns
/// false while another prompt is open.
#[cfg(tokentracky_release_updater)]
pub fn confirm(title: &str, message: &str, yes: &str, response: impl FnOnce(bool) + Send + 'static) -> bool {
    static OPEN: AtomicBool = AtomicBool::new(false);
    if OPEN.swap(true, Ordering::SeqCst) {
        return false;
    }
    let buttons = MessageButtons::OkCancelCustom(yes.into(), "Later".into());
    let yes = yes.to_owned();
    show(title, message, buttons, move |chosen| {
        OPEN.store(false, Ordering::SeqCst);
        // Windows answers with the button's label, GTK with OK.
        response(match chosen {
            MessageDialogResult::Custom(label) => label == yes,
            other => other == MessageDialogResult::Ok,
        });
    });
    true
}

/// About: the app's name and version, and `credits`.
pub fn about(credits: &str) {
    let version = env!("CARGO_PKG_VERSION");
    show(
        "About Tokentracky",
        &format!("Tokentracky {version}\n\n{credits}"),
        MessageButtons::Ok,
        drop,
    );
}

pub fn process_start() -> Option<SystemTime> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::tz;

    #[test]
    fn shows_a_timestamp_as_hours_and_minutes_in_the_zone() {
        let berlin = TimeZone::fixed(tz::offset(2));
        assert_eq!(short_time("2026-06-01T13:05:09Z", &berlin), "15:05");
        assert_eq!(short_time("2026-06-01T23:30:00.250Z", &berlin), "01:30");
        assert_eq!(short_time("2026-06-01T13:05:09+02:00", &TimeZone::UTC), "11:05");
        assert_eq!(short_time("not a time", &TimeZone::UTC), "not a time");
    }
}
