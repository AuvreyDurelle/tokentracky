//! What Unix gives the service and Windows does not: `O_NOFOLLOW`, a file's `dev:ino` identity and `pread`.
use super::Stat;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FileBasicInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx,
};

/// 100-nanosecond intervals from 1601-01-01, where Windows file times start, to the Unix epoch.
const EPOCH: i64 = 116_444_736_000_000_000;

/// `pread`, as `std::os::unix::fs::FileExt` has it. `seek_read` also moves the file's cursor, which no positional
/// read here relies on.
pub(super) trait FileExt {
    fn read_at(&self, buffer: &mut [u8], offset: u64) -> io::Result<usize>;
    fn read_exact_at(&self, mut buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
        while !buffer.is_empty() {
            match self.read_at(buffer, offset) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(read) => {
                    buffer = &mut buffer[read..];
                    offset += read as u64;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}
impl FileExt for File {
    fn read_at(&self, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
        std::os::windows::fs::FileExt::seek_read(self, buffer, offset)
    }
}

/// `O_NOFOLLOW`: `path` itself, opened for reading. A link, or any other reparse point, is refused.
pub(super) fn open_no_follow(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("refused a reparse point"));
    }
    Ok(file)
}

/// `lstat`: `path` itself, a link or a folder included, opened only to read its attributes.
pub(super) fn lstat(path: &Path) -> io::Result<Stat> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    stat(&file)
}

/// `fstat`: the volume serial number and file index stand in for `dev:ino`, and the change time for `ctime`.
pub(super) fn stat(file: &File) -> io::Result<Stat> {
    let handle = file.as_raw_handle();
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is open for the call, which writes only the struct it is given.
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut basic = FILE_BASIC_INFO::default();
    let size = size_of::<FILE_BASIC_INFO>() as u32;
    // SAFETY: as above; `size` is the size of `basic`.
    if unsafe { GetFileInformationByHandleEx(handle, FileBasicInfo, (&raw mut basic).cast(), size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let wide = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    let ms = |ticks: i64| (ticks - EPOCH) as f64 / 10_000.0;
    Ok(Stat {
        identity: format!(
            "{}:{}",
            information.dwVolumeSerialNumber,
            wide(information.nFileIndexHigh, information.nFileIndexLow)
        ),
        size: wide(information.nFileSizeHigh, information.nFileSizeLow),
        mtime_ms: ms(basic.LastWriteTime),
        ctime_ms: ms(basic.ChangeTime),
    })
}
