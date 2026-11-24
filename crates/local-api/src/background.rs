//! The CLI `login`'s background job on Linux and Windows: a copy of the CLI that stays put, running `serve` from now on
//! and at each sign-in. Linux runs it as a systemd user service. Windows starts it from the Run key through
//! `conhost --headless`, which gives it no window; that flag is how Windows' console host behaves, not documented API.
//! The Tokentracky app's launch at login uses the same Run value, so the job changes or deletes it only while it starts
//! the job's copy. The CLI installs and removes the job; the app removes it when it takes the data folder over.
#![cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(target_os = "linux")]
const SERVICE: &str = "tokentracky.service";
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg_attr(not(windows), allow(dead_code))]
const RUN_VALUE: &str = "Tokentracky";

/// Copies the running program into place and starts `serve --background --data-dir <data_dir>` from it, now and at
/// each sign-in, with `TOKENTRACKY_HOME` set to `home` (the credential's folder) when given.
#[cfg(target_os = "linux")]
pub fn install(data_dir: &Path, home: Option<&Path>) -> io::Result<()> {
    let program = folder("XDG_DATA_HOME", &[".local", "share"])?.join("tokentracky/bin/tokentracky");
    copy_self(&program)?;
    let file = unit_file()?;
    std::fs::create_dir_all(file.parent().expect("the unit has a folder"))?;
    std::fs::write(&file, unit(&program, data_dir, home)?)?;
    // `restart` starts it when stopped, and runs this copy in place of an older one.
    let started = systemctl(&["daemon-reload"])
        .and_then(|()| systemctl(&["enable", SERVICE]))
        .and_then(|()| systemctl(&["restart", SERVICE]));
    if started.is_err() {
        let _ = remove();
    }
    started
}

/// Stops the job starting again (on Linux, stops it now too) and deletes the copy; with nothing installed, there is
/// nothing to do.
#[cfg(target_os = "linux")]
pub fn remove() -> io::Result<()> {
    let file = unit_file()?;
    if file.exists() {
        let _ = systemctl(&["disable", "--now", SERVICE]);
        std::fs::remove_file(&file)?;
        let _ = systemctl(&["daemon-reload"]);
    }
    remove_copy(&folder("XDG_DATA_HOME", &[".local", "share"])?.join("tokentracky/bin/tokentracky"))
}

/// Whether the job, or what is left of it, is installed: its unit file or its copy is there.
#[cfg(target_os = "linux")]
pub fn installed() -> bool {
    unit_file().is_ok_and(|file| file.exists())
        || folder("XDG_DATA_HOME", &[".local", "share"]).is_ok_and(|data| data.join("tokentracky/bin").exists())
}

#[cfg(target_os = "linux")]
fn unit_file() -> io::Result<PathBuf> {
    Ok(folder("XDG_CONFIG_HOME", &[".config"])?
        .join("systemd/user")
        .join(SERVICE))
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> io::Result<()> {
    run("systemctl", ["--user"].iter().chain(args))
}

#[cfg(windows)]
pub fn install(data_dir: &Path, home: Option<&Path>) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    if home.is_some() {
        return Err(io::Error::other("the Run key cannot pass TOKENTRACKY_HOME on to it"));
    }
    if run_value().is_some_and(|command| !starts_the_copy(&command)) {
        return Err(io::Error::other("the Tokentracky app starts at sign-in in its place"));
    }
    let program = folder("LOCALAPPDATA", &["AppData", "Local"])?.join(r"tokentracky\bin\tokentracky.exe");
    copy_self(&program)?;
    let conhost = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
        .join(r"System32\conhost.exe");
    let command = run_command(&conhost, &program, data_dir);
    run(
        "reg",
        [
            "add",
            RUN_KEY,
            "/v",
            RUN_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            command.as_str(),
            "/f",
        ],
    )?;
    // Now as well as at each sign-in. Detached from this console, it outlives the terminal.
    Command::new(&conhost)
        .arg("--headless")
        .arg(&program)
        .args(["serve", "--background", "--data-dir"])
        .arg(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(drop)
}

#[cfg(windows)]
pub fn remove() -> io::Result<()> {
    if run_value().is_some_and(|command| starts_the_copy(&command)) {
        run("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])?;
    }
    remove_copy(&folder("LOCALAPPDATA", &["AppData", "Local"])?.join(r"tokentracky\bin\tokentracky.exe"))
}

/// Whether the job, or what is left of it, is installed: the Run value starts its copy, or the copy is there. The
/// app's launch at login may have taken the Run value over already.
#[cfg(windows)]
pub fn installed() -> bool {
    run_value().is_some_and(|command| starts_the_copy(&command))
        || folder("LOCALAPPDATA", &["AppData", "Local"]).is_ok_and(|local| local.join(r"tokentracky\bin").exists())
}

/// macOS has no background job: the app keeps uploading.
#[cfg(not(any(target_os = "linux", windows)))]
pub fn install(_data_dir: &Path, _home: Option<&Path>) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}
#[cfg(not(any(target_os = "linux", windows)))]
pub fn remove() -> io::Result<()> {
    Ok(())
}
#[cfg(not(any(target_os = "linux", windows)))]
pub fn installed() -> bool {
    false
}

/// The command in the Run value, `None` when there is none (`reg query` fails then).
#[cfg(windows)]
fn run_value() -> Option<String> {
    let output = Command::new("reg")
        .args(["query", RUN_KEY, "/v", RUN_VALUE])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| {
        value_data(&String::from_utf8_lossy(&output.stdout))
            .unwrap_or_default()
            .to_owned()
    })
}

/// `$variable` when it is an absolute folder, else `default` under the home folder.
fn folder(variable: &str, default: &[&str]) -> io::Result<PathBuf> {
    if let Some(value) = std::env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(value);
    }
    let home = std::env::home_dir().ok_or_else(|| io::Error::other("there is no home folder"))?;
    Ok(default.iter().fold(home, |path, part| path.join(part)))
}

/// Copies this program to `target`, replacing an older copy whole; nothing to do when this is that copy.
fn copy_self(target: &Path) -> io::Result<()> {
    let current = std::env::current_exe()?;
    if let (Ok(current), Ok(copy)) = (std::fs::canonicalize(&current), std::fs::canonicalize(target))
        && current == copy
    {
        return Ok(());
    }
    let folder = target.parent().expect("the copy has a folder");
    std::fs::create_dir_all(folder)?;
    let temporary = folder.join(format!(".tokentracky-{}.tmp", std::process::id()));
    let copied = std::fs::copy(&current, &temporary).and_then(|_| {
        #[cfg(unix)]
        std::fs::set_permissions(&temporary, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        std::fs::rename(&temporary, target)
    });
    if copied.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    copied
}

/// Deletes the copy's folder, and its parent when that is left empty; a copy already gone is fine.
fn remove_copy(program: &Path) -> io::Result<()> {
    let folder = program.parent().expect("the copy has a folder");
    match std::fs::remove_dir_all(folder) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    if let Some(parent) = folder.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

/// Runs `program` to the end with its output discarded; an error unless it succeeds.
fn run<A: AsRef<OsStr>>(program: &str, args: impl IntoIterator<Item = A>) -> io::Result<()> {
    let args: Vec<A> = args.into_iter().collect();
    let words = || {
        let args = args.iter().map(|arg| arg.as_ref().to_string_lossy());
        std::iter::once(program.into())
            .chain(args)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let status = Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| io::Error::other(format!("{}: {error}", words())))?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("{} failed ({status})", words())))
    }
}

/// The systemd user unit: `serve` on the data folder from the copy, restarted after a failure, its output (one-use
/// dashboard links) discarded, and the credential's folder when it is not the default. Tested on every system.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn unit(program: &Path, data_dir: &Path, home: Option<&Path>) -> io::Result<String> {
    let line = |value: &str| match value.chars().any(char::is_control) {
        true => Err(io::Error::other(format!(
            "{value:?} cannot be written into a service file"
        ))),
        false => Ok(value.to_owned()),
    };
    let path = |path: &Path| {
        let text = path
            .to_str()
            .ok_or_else(|| io::Error::other(format!("{} is not UTF-8", path.display())))?;
        line(text)
    };
    let command = [
        path(program)?,
        "serve".into(),
        "--background".into(),
        "--data-dir".into(),
        path(data_dir)?,
    ]
    .map(|argument| quote(&argument.replace('$', "$$")))
    .join(" ");
    let environment = match home {
        Some(home) => format!("Environment={}\n", quote(&format!("TOKENTRACKY_HOME={}", path(home)?))),
        None => String::new(),
    };
    Ok(format!(
        "[Unit]\nDescription=Tokentracky: uploads this computer's AI coding token totals\n\n[Service]\nExecStart={command}\n{environment}StandardOutput=null\nRestart=on-failure\nRestartSec=60\n\n[Install]\nWantedBy=default.target\n"
    ))
}

/// A systemd value in double quotes: `\` and `"` escaped, `%` (its specifiers) doubled.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn quote(value: &str) -> String {
    let escaped = value.replace('\\', r"\\").replace('"', "\\\"").replace('%', "%%");
    format!("\"{escaped}\"")
}

/// The Run key's command: the console host, headless, starting `serve` from the copy. Windows paths hold no `"`; a
/// trailing `\` is doubled so it does not escape the closing quote. Tested on every system.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_command(conhost: &Path, program: &Path, data_dir: &Path) -> String {
    let quote = |path: &Path| {
        let text = path.display().to_string();
        let trailing = text.len() - text.trim_end_matches('\\').len();
        format!("\"{text}{}\"", "\\".repeat(trailing))
    };
    format!(
        "{} --headless {} serve --background --data-dir {}",
        quote(conhost),
        quote(program),
        quote(data_dir)
    )
}

/// The Run value's data in `reg query`'s output: the text after its type on the value's line.
#[cfg_attr(not(windows), allow(dead_code))]
fn value_data(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix(RUN_VALUE)?;
        let rest = rest.strip_prefix(char::is_whitespace)?.trim_start();
        let data = rest
            .strip_prefix("REG_SZ")
            .or_else(|| rest.strip_prefix("REG_EXPAND_SZ"))?;
        Some(data.trim())
    })
}

/// Whether a Run value's command starts the job's copy (`%LOCALAPPDATA%\tokentracky\bin\tokentracky.exe`) rather than
/// the app (`%LOCALAPPDATA%\Tokentracky\tokentracky-mac.exe`). Only the folder's ASCII tail is compared: `reg` prints
/// in the console's code page, which may garble the user's name in the rest of the path.
#[cfg_attr(not(windows), allow(dead_code))]
fn starts_the_copy(command: &str) -> bool {
    command
        .to_ascii_lowercase()
        .contains(r"\tokentracky\bin\tokentracky.exe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_systemd_unit_that_survives_odd_paths() {
        let unit = unit(
            Path::new("/home/ada/.local/share/tokentracky/bin/tokentracky"),
            Path::new("/home/ada/My Data/100%/$HOME/\"q\"\\"),
            None,
        )
        .unwrap();
        assert_eq!(
            unit,
            "[Unit]\nDescription=Tokentracky: uploads this computer's AI coding token totals\n\n[Service]\nExecStart=\"/home/ada/.local/share/tokentracky/bin/tokentracky\" \"serve\" \"--background\" \"--data-dir\" \"/home/ada/My Data/100%%/$$HOME/\\\"q\\\"\\\\\"\nStandardOutput=null\nRestart=on-failure\nRestartSec=60\n\n[Install]\nWantedBy=default.target\n"
        );
    }

    #[test]
    fn passes_the_credential_folder_to_the_service() {
        let unit = unit(
            Path::new("/bin/t"),
            Path::new("/d"),
            Some(Path::new("/home/ada/token 50%")),
        )
        .unwrap();
        assert!(
            unit.contains("\nEnvironment=\"TOKENTRACKY_HOME=/home/ada/token 50%%\"\nStandardOutput=null\n"),
            "{unit}"
        );
    }

    #[test]
    fn refuses_paths_a_unit_file_cannot_hold() {
        assert!(unit(Path::new("/bin/t"), Path::new("/data\nExecStartPre=/evil"), None).is_err());
        assert!(
            unit(
                Path::new("/bin/t"),
                Path::new("/d"),
                Some(Path::new("/home\n[Install]"))
            )
            .is_err()
        );
    }

    #[test]
    fn starts_serve_headless_from_the_run_key() {
        assert_eq!(
            run_command(
                Path::new(r"C:\Windows\System32\conhost.exe"),
                Path::new(r"C:\Users\Ada Lovelace\AppData\Local\tokentracky\bin\tokentracky.exe"),
                Path::new(r"C:\Users\Ada Lovelace\.tokentracky"),
            ),
            r#""C:\Windows\System32\conhost.exe" --headless "C:\Users\Ada Lovelace\AppData\Local\tokentracky\bin\tokentracky.exe" serve --background --data-dir "C:\Users\Ada Lovelace\.tokentracky""#
        );
        assert!(run_command(Path::new("c"), Path::new("p"), Path::new(r"D:\")).ends_with(r#"--data-dir "D:\\""#));
    }

    #[test]
    fn reads_the_run_value_from_reg_query() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Tokentracky    REG_SZ    \"C:\\Users\\Ada\\AppData\\Local\\Tokentracky\\tokentracky-mac.exe\" --hidden\r\n\r\n";
        assert_eq!(
            value_data(output),
            Some(r#""C:\Users\Ada\AppData\Local\Tokentracky\tokentracky-mac.exe" --hidden"#)
        );
        assert_eq!(
            value_data("    Tokentracky    REG_EXPAND_SZ    %LOCALAPPDATA%\\x.exe\r\n"),
            Some(r"%LOCALAPPDATA%\x.exe")
        );
        // Another value whose name starts the same is not it.
        assert_eq!(value_data("    TokentrackyBeta    REG_SZ    beta.exe\r\n"), None);
        assert_eq!(value_data(""), None);
    }

    #[test]
    fn tells_the_jobs_run_value_from_the_apps() {
        let job = run_command(
            Path::new(r"C:\Windows\System32\conhost.exe"),
            Path::new(r"C:\Users\Zoë\AppData\Local\tokentracky\bin\tokentracky.exe"),
            Path::new(r"C:\Users\Zoë\.tokentracky"),
        );
        assert!(starts_the_copy(&job));
        // As `reg` may print it, the name garbled and the case as Windows keeps it.
        assert!(starts_the_copy(
            r#""C:\Windows\System32\conhost.exe" --headless "C:\Users\Zo?\AppData\Local\Tokentracky\Bin\Tokentracky.exe" serve"#
        ));
        // The app's launch at login, from its per-user install.
        assert!(!starts_the_copy(
            r#""C:\Users\Ada\AppData\Local\Tokentracky\tokentracky-mac.exe" --hidden"#
        ));
        assert!(!starts_the_copy(""));
    }
}
