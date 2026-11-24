//! The Tokentracky app on Linux and Windows: where it is installed, and starting it for `login` and `open`. A launch
//! opens its dashboard, and so does a second launch while it runs (the app hands it to the running one). macOS opens
//! the app in `main.rs`.
#![cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The file in the app's data folder where the app, run as an AppImage, records the AppImage's path.
pub const APPIMAGE_RECORD: &str = "app-path";

/// Starts the installed app; false when it is not installed, or cannot open a window here.
pub fn open() -> bool {
    installed_program().is_some_and(|program| launch(&program))
}

/// Whether [`open`] finds the app, without starting it.
pub fn installed() -> bool {
    installed_program().is_some()
}

fn installed_program() -> Option<PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    let home = std::env::home_dir().unwrap_or_default();
    places(std::env::consts::OS, var, &home)
        .into_iter()
        .find(|program| program.is_file())
}

/// Where the app may be, in the order to try: the per-user installer's folder on Windows (`%LOCALAPPDATA%\Tokentracky`,
/// unless chosen otherwise while installing); on Linux the .deb's program, then the AppImage the app last ran from,
/// recorded in its data folder (`$TOKENTRACKY_HOME`, else `~/.tokentracky`, as the app chooses it). A Linux session
/// without a display (over SSH, say) has none: the app could not open a window there.
fn places(os: &str, var: impl Fn(&str) -> Option<OsString>, home: &Path) -> Vec<PathBuf> {
    match os {
        "windows" => {
            let local = var("LOCALAPPDATA").map_or_else(|| home.join("AppData").join("Local"), PathBuf::from);
            vec![local.join("Tokentracky").join("tokentracky-mac.exe")]
        }
        "linux" if var("DISPLAY").is_some() || var("WAYLAND_DISPLAY").is_some() => {
            let data = var("TOKENTRACKY_HOME").map_or_else(|| home.join(".tokentracky"), PathBuf::from);
            std::iter::once(PathBuf::from("/usr/bin/tokentracky-mac"))
                .chain(recorded_appimage(&data))
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The AppImage path the app recorded in `data`: one absolute path, a trailing line break allowed.
fn recorded_appimage(data: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(data.join(APPIMAGE_RECORD)).ok()?;
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    #[cfg(unix)]
    let path = PathBuf::from(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(bytes));
    #[cfg(not(unix))]
    let path = PathBuf::from(String::from_utf8(bytes.to_vec()).ok()?);
    path.is_absolute().then_some(path)
}

/// Starts `program` on its own, so it outlives this terminal: on Windows detached from the console, on Linux in its own
/// process group, out of reach of the terminal's Ctrl-C and hangup.
fn launch(program: &Path) -> bool {
    let mut command = Command::new(program);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: Vec<(String, OsString)> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).into())).collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn finds_the_per_user_install_on_windows() {
        let home = Path::new(r"C:\Users\Ada");
        assert_eq!(
            places("windows", env(&[("LOCALAPPDATA", r"C:\Users\Ada\AppData\Local")]), home),
            [PathBuf::from(r"C:\Users\Ada\AppData\Local")
                .join("Tokentracky")
                .join("tokentracky-mac.exe")]
        );
        // Without the variable, the profile's usual place.
        assert_eq!(
            places("windows", env(&[]), home),
            [home
                .join("AppData")
                .join("Local")
                .join("Tokentracky")
                .join("tokentracky-mac.exe")]
        );
    }

    #[test]
    fn finds_the_deb_then_the_recorded_appimage_on_linux() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let appimage = root.path().join("Apps/Tokentracky.AppImage");
        std::fs::create_dir_all(home.join(".tokentracky")).unwrap();
        std::fs::write(
            home.join(".tokentracky").join(APPIMAGE_RECORD),
            format!("{}\n", appimage.display()),
        )
        .unwrap();
        assert_eq!(
            places("linux", env(&[("DISPLAY", ":0")]), &home),
            [PathBuf::from("/usr/bin/tokentracky-mac"), appimage.clone()]
        );
        // The app's data folder follows TOKENTRACKY_HOME, as the app does.
        let custom = root.path().join("custom");
        std::fs::create_dir_all(&custom).unwrap();
        let elsewhere = root.path().join("Tokentracky-x86_64.AppImage");
        std::fs::write(custom.join(APPIMAGE_RECORD), elsewhere.as_os_str().as_encoded_bytes()).unwrap();
        let custom = custom.to_str().unwrap();
        assert_eq!(
            places(
                "linux",
                env(&[("WAYLAND_DISPLAY", "wayland-0"), ("TOKENTRACKY_HOME", custom)]),
                &home
            ),
            [PathBuf::from("/usr/bin/tokentracky-mac"), elsewhere]
        );
    }

    #[test]
    fn opens_no_app_without_a_display_or_on_other_systems() {
        let home = Path::new("/home/ada");
        assert!(places("linux", env(&[]), home).is_empty());
        assert!(places("macos", env(&[("DISPLAY", ":0")]), home).is_empty());
    }

    #[test]
    fn ignores_a_missing_or_relative_appimage_record() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(recorded_appimage(data.path()), None);
        std::fs::write(data.path().join(APPIMAGE_RECORD), "Tokentracky.AppImage\n").unwrap();
        assert_eq!(recorded_appimage(data.path()), None);
    }
}
