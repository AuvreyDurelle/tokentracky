//! `login`'s background job on Linux and Windows, as `tokentracky_local_api::background` installs and removes it (the
//! app removes it too when it takes the data folder over).
use std::io;
use std::path::Path;
use std::sync::Arc;
use tokentracky_cli::Background;
use tokentracky_local_api::background;

/// This system's background job; `None` on macOS, where the Mac app keeps uploading.
pub fn background() -> Option<Arc<dyn Background>> {
    cfg!(any(target_os = "linux", windows)).then(|| Arc::new(Job) as Arc<dyn Background>)
}

struct Job;

impl Background for Job {
    fn install(&self, data_dir: &Path, home: Option<&Path>) -> io::Result<()> {
        background::install(data_dir, home)
    }
    fn remove(&self) -> io::Result<()> {
        background::remove()
    }
}
