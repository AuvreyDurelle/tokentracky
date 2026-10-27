//! AppKit, Foundation and libSystem calls for menu-bar text, wake notifications, alerts, the About panel,
//! and web-view teardown. Everything that touches AppKit runs on the main thread.
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
#[cfg(tokentracky_release_updater)]
use objc2::{DefinedClass, MainThreadOnly, define_class, msg_send};
use objc2::{MainThreadMarker, sel};
#[cfg(tokentracky_release_updater)]
use objc2_app_kit::NSButton;
use objc2_app_kit::{
    NSAboutPanelOptionCredits, NSAlert, NSApplication, NSEvent, NSEventModifierFlags, NSEventType,
    NSFloatingWindowLevel, NSFont, NSFontWeightRegular, NSWindowCollectionBehavior, NSWorkspace,
    NSWorkspaceDidWakeNotification,
};
use objc2_foundation::{
    NSAttributedString, NSDate, NSDateFormatter, NSDateFormatterStyle, NSDictionary, NSNotification, NSPoint, NSString,
};
#[cfg(tokentracky_release_updater)]
use objc2_foundation::{NSObject, NSObjectProtocol};
use std::cell::RefCell;
use std::ptr::NonNull;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::tray::TrayIcon;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Digits of equal width in the title, so it does not jiggle as the count changes (Electron's `monospacedDigit`).
pub fn use_monospaced_digits(tray: &TrayIcon) {
    let _ = tray.with_inner_tray_icon(|inner| {
        let (Some(mtm), Some(item)) = (MainThreadMarker::new(), inner.ns_status_item()) else {
            return;
        };
        if let Some(button) = item.button(mtm) {
            let size = button
                .font()
                .map_or_else(NSFont::systemFontSize, |font| font.pointSize());
            let font = NSFont::monospacedDigitSystemFontOfSize_weight(size, unsafe { NSFontWeightRegular });
            button.setFont(Some(&font));
        }
    });
}

/// The backing scale of the icon's screen: Tauri reports the icon's rect in pixels at it (the status item window's
/// `backingScaleFactor`). `None` while the icon has no window.
pub fn tray_scale(tray: &TrayIcon) -> Option<f64> {
    tray.with_inner_tray_icon(|inner| {
        let mtm = MainThreadMarker::new()?;
        let window = inner.ns_status_item()?.button(mtm)?.window()?;
        Some(window.backingScaleFactor())
    })
    .ok()
    .flatten()
}

/// Calls `wake` on every `NSWorkspaceDidWakeNotification`, for the life of the app. A notification, not a timer.
pub fn on_wake(wake: impl Fn() + 'static) {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| wake());
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &block)
    };
    std::mem::forget(observer);
}

/// An ISO timestamp as a short local time in the user's format (`toLocaleTimeString` with hours and minutes).
pub fn local_time(iso: &str) -> String {
    let Ok(at) = OffsetDateTime::parse(iso, &Rfc3339) else {
        return iso.to_owned();
    };
    let date = NSDate::dateWithTimeIntervalSince1970(at.unix_timestamp_nanos() as f64 / 1e9);
    NSDateFormatter::localizedStringFromDate_dateStyle_timeStyle(
        &date,
        NSDateFormatterStyle::NoStyle,
        NSDateFormatterStyle::ShortStyle,
    )
    .to_string()
}

/// A menu-bar app is not active until it is asked to be; windows and panels it shows must come to the front.
fn activate(mtm: MainThreadMarker) {
    // `activate` needs macOS 14; the app supports 13.
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
}

/// Makes the app active, so the window it shows next takes focus (and reports losing it). Main thread only.
pub fn activate_app() {
    if let Some(mtm) = MainThreadMarker::new() {
        activate(mtm);
    }
}

thread_local! {
    /// The alert on screen, kept alive until OK hides it or the next alert replaces it.
    static SHOWN: RefCell<Option<Retained<NSAlert>>> = const { RefCell::new(None) };
}

/// A failure the user should see, where Electron showed a notification. Not modal: a modal alert would hold back menu
/// actions and title updates until dismissed, and is lost if it runs while the app is still launching. Shown on every
/// Space, over a full-screen app too, since a menu-bar app has no window of its own to show it beside. Main thread only.
pub fn alert(title: &str, message: &str) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    let ok = alert.addButtonWithTitle(&NSString::from_str("OK"));
    let window = alert.window();
    // The button's own action ends a modal session; with none, OK just hides the panel.
    unsafe {
        ok.setTarget(Some(&window));
        ok.setAction(Some(sel!(orderOut:)));
    }
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    window.setLevel(NSFloatingWindowLevel);
    alert.layout();
    window.center();
    activate(mtm);
    window.makeKeyAndOrderFront(None);
    if let Some(previous) = SHOWN.replace(Some(alert)) {
        previous.window().orderOut(None);
    }
}

#[cfg(tokentracky_release_updater)]
type PromptResponse = Box<dyn FnOnce(bool)>;

#[cfg(tokentracky_release_updater)]
struct PromptIvars {
    response: RefCell<Option<PromptResponse>>,
}

#[cfg(tokentracky_release_updater)]
define_class!(
    // SAFETY: NSObject has no subclassing requirements; this class has no custom Drop implementation.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = PromptIvars]
    #[name = "TokentrackyUpdatePrompt"]
    struct PromptTarget;

    // SAFETY: NSObjectProtocol has no additional safety requirements.
    unsafe impl NSObjectProtocol for PromptTarget {}

    impl PromptTarget {
        #[unsafe(method(respond:))]
        fn respond(&self, sender: &NSButton) {
            let response = self.ivars().response.borrow_mut().take();
            // Keep both the alert and its weakly referenced button target alive through this action.
            let shown = UPDATE_PROMPT.take();
            if let Some((alert, _)) = &shown {
                alert.window().orderOut(None);
                for button in alert.buttons() {
                    // SAFETY: The alert is dismissed. Remove its non-owning action targets before
                    // releasing the retained target, even if AppKit still retains the window.
                    unsafe {
                        button.setTarget(None);
                        button.setAction(None);
                    }
                }
            }
            if let Some(response) = response {
                response(sender.tag() == 1);
            }
        }
    }
);

#[cfg(tokentracky_release_updater)]
thread_local! {
    static UPDATE_PROMPT: RefCell<Option<(Retained<NSAlert>, Retained<PromptTarget>)>> = const { RefCell::new(None) };
}

/// A nonmodal native choice: collection, menus and the main run loop continue while it is open.
#[cfg(tokentracky_release_updater)]
pub fn confirm(title: &str, message: &str, yes: &str, response: impl FnOnce(bool) + 'static) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    if UPDATE_PROMPT.with_borrow(Option::is_some) {
        return false;
    }
    let target = PromptTarget::alloc(mtm).set_ivars(PromptIvars {
        response: RefCell::new(Some(Box::new(response))),
    });
    // SAFETY: NSObject's init takes no arguments and returns the initialized retained object.
    let target: Retained<PromptTarget> = unsafe { msg_send![super(target), init] };
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    for (label, tag) in [(yes, 1), ("Later", 0)] {
        let button = alert.addButtonWithTitle(&NSString::from_str(label));
        button.setTag(tag);
        if tag == 0 {
            button.setKeyEquivalent(&NSString::from_str("\u{1b}"));
        }
        // SAFETY: PromptTarget implements respond: with an NSButton sender, and UPDATE_PROMPT
        // retains the target for as long as the alert's buttons can be used.
        unsafe {
            button.setTarget(Some(&target));
            button.setAction(Some(sel!(respond:)));
        }
    }
    let window = alert.window();
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    window.setLevel(NSFloatingWindowLevel);
    alert.layout();
    window.center();
    activate(mtm);
    window.makeKeyAndOrderFront(None);
    UPDATE_PROMPT.set(Some((alert, target)));
    true
}

/// The standard About panel (name, version, icon) with `credits` under the version. Main thread only.
pub fn about(credits: &str) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    activate(mtm);
    let credits = NSAttributedString::from_nsstring(&NSString::from_str(credits));
    let credits: &AnyObject = &credits;
    let options = NSDictionary::from_slices(&[unsafe { NSAboutPanelOptionCredits }], &[credits]);
    unsafe { NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanelWithOptions(&options) };
}

/// Kernel start time of this process, so startup timing includes dyld and runtime set-up before `main`.
pub fn process_start() -> Option<SystemTime> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let pid = std::process::id() as libc::c_int;
    let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    (written == size).then(|| UNIX_EPOCH + Duration::new(info.pbi_start_tvsec, info.pbi_start_tvusec as u32 * 1000))
}

/// Tauri closes windows from a run-loop source, so the closed window and its WKWebView sit in AppKit's autorelease
/// pool until the next NSEvent. A menu-bar app can idle for hours without one, which keeps the WebContent process
/// alive. Posting a no-op event drains the pool now.
pub fn drain_autorelease_pool() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType::ApplicationDefined,
        NSPoint::ZERO,
        NSEventModifierFlags::empty(),
        0.0,
        0,
        None,
        0,
        0,
        0,
    );
    if let Some(event) = event {
        NSApplication::sharedApplication(mtm).postEvent_atStart(&event, false);
    }
}

unsafe extern "C" {
    /// libSystem: the process macOS holds responsible for `pid`. For WebKit's XPC helpers that is the app.
    fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
}

/// This app's WebKit helpers called `name`. Empty when LaunchServices did not start the app (for example from a
/// terminal or a test), because macOS then holds the parent responsible and the helpers cannot be told apart.
pub fn webkit_helpers(name: &str) -> Vec<libc::pid_t> {
    let me = std::process::id() as libc::pid_t;
    if unsafe { responsibility_get_pid_responsible_for_pid(me) } != me {
        return Vec::new();
    }
    let mut pids = vec![0 as libc::pid_t; 8192];
    let bytes = (pids.len() * size_of::<libc::pid_t>()) as libc::c_int;
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(count.max(0) as usize);
    pids.retain(|&pid| {
        let mut buffer = [0u8; 64];
        let length = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        pid != me
            && length > 0
            && &buffer[..length as usize] == name.as_bytes()
            && unsafe { responsibility_get_pid_responsible_for_pid(pid) } == me
    });
    pids
}

/// Ends this app's WebKit GPU process, which WebKit keeps 30 to 70 s after the last web view (14 to 19 MB). Call only
/// once WebContent has exited and no window is open. Fragile: WebKit records the exit as a GPU process crash, so drop
/// this once WebKit idles the process out sooner. Returns each helper's pid and whether the signal was sent.
pub fn end_gpu_process() -> Vec<(libc::pid_t, bool)> {
    let helpers = webkit_helpers("com.apple.WebKit.GPU");
    helpers
        .into_iter()
        .map(|pid| {
            // Recheck both name and responsibility immediately before signalling. Never signal a system view
            // service or another application's helper. PID reuse still prevents this private API from being a
            // supported compatibility guarantee across macOS releases.
            let owned = webkit_helpers("com.apple.WebKit.GPU").contains(&pid);
            (pid, owned && unsafe { libc::kill(pid, libc::SIGTERM) } == 0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cargo test` is started from a terminal, not by LaunchServices: the helper discovery must find nothing (and so
    /// end nothing), even with WebKit processes of other apps running.
    #[test]
    fn finds_no_helpers_when_launch_services_did_not_start_the_process() {
        let me = std::process::id() as libc::pid_t;
        assert_ne!(unsafe { responsibility_get_pid_responsible_for_pid(me) }, me);
        assert!(webkit_helpers("com.apple.WebKit.GPU").is_empty());
        assert!(webkit_helpers("com.apple.WebKit.WebContent").is_empty());
        assert!(end_gpu_process().is_empty());
    }

    #[test]
    fn knows_when_this_process_started() {
        let started = process_start().unwrap();
        assert!(started <= SystemTime::now());
        assert!(SystemTime::now().duration_since(started).unwrap() < Duration::from_secs(3600));
    }
}
