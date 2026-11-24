//! Where the Linux app's AppImage is. An AppImage can live anywhere, so the app records its path in the data folder each
//! time it starts from one, and the CLI's `login` and `open` start it from there.
use std::io;
use std::path::{Path, PathBuf};

/// The record's file in the data folder: the path alone, as bytes.
pub const RECORD: &str = "app-path";

/// Records `appimage` (the app's `$APPIMAGE`) in the data folder `directory`.
pub fn record(directory: &Path, appimage: &Path) -> io::Result<()> {
    std::fs::write(directory.join(RECORD), appimage.as_os_str().as_encoded_bytes())
}

/// The path recorded in `directory`: one absolute path, a trailing line break allowed.
pub fn recorded(directory: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(directory.join(RECORD)).ok()?;
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    #[cfg(unix)]
    let path = PathBuf::from(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(bytes));
    #[cfg(not(unix))]
    let path = PathBuf::from(String::from_utf8(bytes.to_vec()).ok()?);
    path.is_absolute().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_back_the_recorded_appimage() {
        let data = tempfile::tempdir().unwrap();
        let appimage = data.path().join("My Apps").join("Tokentracky_0.4.0_amd64.AppImage");
        record(data.path(), &appimage).unwrap();
        assert_eq!(recorded(data.path()), Some(appimage));
    }

    #[test]
    fn ignores_a_missing_or_relative_record() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(recorded(data.path()), None);
        std::fs::write(data.path().join(RECORD), "Tokentracky.AppImage\n").unwrap();
        assert_eq!(recorded(data.path()), None);
    }
}
