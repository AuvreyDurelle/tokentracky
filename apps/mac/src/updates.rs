//! Update transitions shared by automatic checks and native menu actions. No network or AppKit calls here.
#![cfg_attr(not(tokentracky_release_updater), allow(dead_code))]

use crate::menu::UpdateState;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const STARTUP_DELAY: Duration = Duration::from_secs(30);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
pub const REMINDER_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
pub const REMINDER_FILE: &str = "update-reminder.json";

#[derive(Clone, Serialize, Deserialize)]
pub struct Reminder {
    version: String,
    shown_at: u64,
}

impl Reminder {
    pub fn read(path: &Path) -> Option<Self> {
        let mut contents = String::new();
        std::fs::File::open(path)
            .ok()?
            .take(4096)
            .read_to_string(&mut contents)
            .ok()?;
        serde_json::from_str(&contents).ok()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec(self)?)
    }

    fn due(&self, version: &str, now: u64) -> bool {
        self.version != version || now < self.shown_at || now - self.shown_at >= REMINDER_INTERVAL.as_secs()
    }
}

pub struct Updates {
    pub state: UpdateState,
    pub reminder: Option<Reminder>,
    prompt_open: bool,
}

impl Updates {
    pub fn new(enabled: bool) -> Self {
        Self {
            state: if enabled {
                UpdateState::Idle
            } else {
                UpdateState::Disabled
            },
            reminder: None,
            prompt_open: false,
        }
    }

    /// Claim a check atomically, including when a previously offered version was postponed.
    pub fn begin_check(&mut self) -> bool {
        if self.prompt_open || !matches!(self.state, UpdateState::Idle | UpdateState::Available(_)) {
            return false;
        }
        self.state = UpdateState::Checking;
        true
    }

    /// Late network responses cannot revive the updater after shutdown.
    pub fn finish_check(&mut self, version: Option<String>) -> bool {
        if self.state != UpdateState::Checking {
            return false;
        }
        self.state = version.map_or(UpdateState::Idle, UpdateState::Available);
        true
    }

    /// Manual checks bypass the reminder interval; automatic checks remind at most once a day per version.
    pub fn begin_prompt(&mut self, version: &str, manual: bool, now: SystemTime) -> Option<Reminder> {
        if self.prompt_open || self.state != UpdateState::Available(version.to_owned()) {
            return None;
        }
        let now = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        if !manual
            && self
                .reminder
                .as_ref()
                .is_some_and(|reminder| !reminder.due(version, now))
        {
            return None;
        }
        let reminder = Reminder {
            version: version.to_owned(),
            shown_at: now,
        };
        self.reminder = Some(reminder.clone());
        self.prompt_open = true;
        Some(reminder)
    }

    pub fn finish_prompt(&mut self, version: &str) -> bool {
        self.prompt_open = false;
        self.state == UpdateState::Available(version.to_owned())
    }

    /// The menu and prompt share this claim, so only one download/installation can run.
    pub fn begin_download(&mut self) -> Option<String> {
        if self.prompt_open {
            return None;
        }
        let UpdateState::Available(version) = &self.state else {
            return None;
        };
        let version = version.clone();
        self.state = UpdateState::Downloading(version.clone());
        Some(version)
    }

    pub fn finish_download(&mut self, version: &str, success: bool) -> bool {
        if self.state != UpdateState::Downloading(version.to_owned()) {
            return false;
        }
        self.state = if success {
            UpdateState::Ready(version.to_owned())
        } else {
            UpdateState::Idle
        };
        true
    }

    pub fn stop(&mut self) {
        self.state = UpdateState::Disabled;
        self.prompt_open = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn offer(updates: &mut Updates, version: &str) {
        assert!(updates.begin_check());
        assert!(updates.finish_check(Some(version.into())));
    }

    #[test]
    fn postponed_versions_are_rechecked_without_repeating_prompts_until_tomorrow() {
        let mut updates = Updates::new(true);
        offer(&mut updates, "1.1.0");
        assert!(updates.begin_prompt("1.1.0", false, at(100)).is_some());
        assert!(!updates.begin_check()); // A visible prompt must keep its selected version.
        assert!(updates.begin_download().is_none());
        assert!(updates.finish_prompt("1.1.0")); // Later leaves the menu action available.
        offer(&mut updates, "1.1.0");
        assert!(
            updates
                .begin_prompt("1.1.0", false, at(100 + CHECK_INTERVAL.as_secs()))
                .is_none()
        );
        assert!(
            updates
                .begin_prompt("1.1.0", false, at(100 + REMINDER_INTERVAL.as_secs()))
                .is_some()
        );
    }

    #[test]
    fn reminders_survive_relaunch_and_manual_checks_or_new_versions_can_prompt_sooner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings").join(REMINDER_FILE);
        let mut updates = Updates::new(true);
        offer(&mut updates, "1.1.0");
        updates
            .begin_prompt("1.1.0", false, at(100))
            .unwrap()
            .save(&path)
            .unwrap();

        let mut relaunched = Updates::new(true);
        relaunched.reminder = Reminder::read(&path);
        offer(&mut relaunched, "1.1.0");
        assert!(relaunched.begin_prompt("1.1.0", false, at(101)).is_none());
        assert!(relaunched.begin_prompt("1.1.0", true, at(101)).is_some());
        relaunched.finish_prompt("1.1.0");
        offer(&mut relaunched, "1.2.0");
        assert!(relaunched.begin_prompt("1.2.0", false, at(102)).is_some());
    }

    #[test]
    fn checks_downloads_and_shutdown_do_not_race() {
        let mut updates = Updates::new(false);
        assert!(!updates.begin_check());
        let mut updates = Updates::new(true);
        assert!(updates.begin_check());
        assert!(!updates.begin_check());
        assert!(updates.finish_check(None)); // No update or offline: next check can retry.
        offer(&mut updates, "1.1.0");
        assert_eq!(updates.begin_download().as_deref(), Some("1.1.0"));
        assert!(updates.begin_download().is_none());
        assert!(!updates.begin_check());
        assert!(!updates.finish_download("1.2.0", true));
        assert!(updates.finish_download("1.1.0", true));
        assert!(!updates.begin_check()); // Don't replace an installed update awaiting restart.
        updates.stop();
        assert!(!updates.finish_download("1.1.0", true));
        assert!(!updates.finish_check(Some("1.2.0".into())));
        assert!(!updates.begin_check());
    }

    #[test]
    fn invalid_reminder_files_and_backwards_clocks_do_not_disable_updates() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(REMINDER_FILE);
        assert!(Reminder::read(&path).is_none());
        std::fs::write(&path, "broken").unwrap();
        assert!(Reminder::read(&path).is_none());
        let mut updates = Updates::new(true);
        offer(&mut updates, "1.1.0");
        updates.begin_prompt("1.1.0", false, at(100)).unwrap();
        updates.finish_prompt("1.1.0");
        assert!(updates.begin_prompt("1.1.0", false, at(99)).is_some());
    }
}
