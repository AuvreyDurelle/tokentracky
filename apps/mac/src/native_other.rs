//! What `native.rs` does with AppKit, on Windows and Linux: alerts, the update prompts and About as message dialogs
//! (rfd on Windows, GTK on Linux), local times through jiff, the icon's scale from its monitor. Monospaced digits, wake
//! notifications, activation and the process start time have no counterpart and do nothing: the five-minute cycle
//! covers a wake.
#[cfg(target_os = "linux")]
use gtk::prelude::*;
use jiff::Timestamp;
use jiff::tz::TimeZone;
#[cfg(windows)]
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

/// A message dialog with OK, or with `yes` and Later, then `done` with whether `yes` was chosen. Not modal, as on
/// macOS: collection, the menu and the windows keep working while it is open. rfd runs it on a thread of its own and
/// another waits for the answer.
#[cfg(windows)]
fn show(title: &str, message: &str, yes: Option<&str>, done: impl FnOnce(bool) + Send + 'static) {
    let buttons = yes.map_or(MessageButtons::Ok, |yes| {
        MessageButtons::OkCancelCustom(yes.into(), "Later".into())
    });
    let yes = yes.map(str::to_owned);
    let shown = AsyncMessageDialog::new()
        .set_level(MessageLevel::Info)
        .set_title(title)
        .set_description(message)
        .set_buttons(buttons)
        .show();
    std::thread::spawn(move || {
        // The button's label answers.
        let chosen = tauri::async_runtime::block_on(shown);
        done(matches!(&chosen, MessageDialogResult::Custom(label) if Some(label) == yes.as_ref()));
    });
}

/// As on Windows, with GTK, on the main thread where every caller is. GTK runs the dialog with the app's own loop.
#[cfg(target_os = "linux")]
fn show(title: &str, message: &str, yes: Option<&str>, done: impl FnOnce(bool) + 'static) {
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::empty(),
        gtk::MessageType::Info,
        gtk::ButtonsType::None,
        title,
    );
    dialog.set_title(title);
    dialog.set_secondary_text(Some(message));
    // Over the windows, as the macOS alerts float.
    dialog.set_keep_above(true);
    match yes {
        Some(yes) => {
            dialog.add_button("Later", gtk::ResponseType::Cancel);
            dialog.add_button(yes, gtk::ResponseType::Accept);
        }
        None => drop(dialog.add_button("OK", gtk::ResponseType::Ok)),
    }
    let done = std::cell::Cell::new(Some(done));
    dialog.connect_response(move |dialog, response| {
        // SAFETY: the dialog is this function's own and nothing uses it after its answer.
        unsafe { dialog.destroy() };
        if let Some(done) = done.take() {
            done(response == gtk::ResponseType::Accept);
        }
    });
    dialog.show_all();
}

/// A failure the user should see. Not modal, as on macOS: collection and the menu keep working while it is open.
pub fn alert(title: &str, message: &str) {
    show(title, message, None, drop);
}

/// A nonmodal choice between `yes` and Later; `response` learns whether `yes` was chosen. Shows nothing and returns
/// false while another prompt is open.
#[cfg(tokentracky_release_updater)]
pub fn confirm(title: &str, message: &str, yes: &str, response: impl FnOnce(bool) + Send + 'static) -> bool {
    static OPEN: AtomicBool = AtomicBool::new(false);
    if OPEN.swap(true, Ordering::SeqCst) {
        return false;
    }
    show(title, message, Some(yes), move |accepted| {
        OPEN.store(false, Ordering::SeqCst);
        response(accepted);
    });
    true
}

/// About: the app's name and version, and `credits`.
pub fn about(credits: &str) {
    let version = env!("CARGO_PKG_VERSION");
    show(
        "About Tokentracky",
        &format!("Tokentracky {version}\n\n{credits}"),
        None,
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
