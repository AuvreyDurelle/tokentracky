//! The `tokentracky` command line. The binary and tests call [`run`] with a [`Context`] for process I/O,
//! storage and network dependencies. Commands support human-readable output and stable `--json` responses.
mod args;
mod commands;
mod control;
mod report;
mod serve;

use args::Command;
use std::ffi::OsString;
use std::future::Future;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use time::UtcOffset;
use tokentracky_collector::service::ServiceError;
use tokentracky_collector::store::StoreError;
use tokentracky_local_api::{LocalError, MemorySecretStore, OpenError, SecretStore};

pub use serve::ServeHandle;

pub const USAGE: &str = "Usage: tokentracky <command> [options]

Commands:
  serve               Open the private dashboard (prints a one-use link) and refresh every 5 minutes
  open                Open the dashboard of the Tokentracky running on this computer
  status [--json]     Token totals, sources and leaderboard link
  refresh [--json]    Run one refresh cycle now: scan, prices, sync
  doctor [--json]     Check the runtime, SQLite, the data folder, detected tools, link and last refresh
  login               Connect this computer to the leaderboard through your browser, then keep uploading
  unlink              Stop uploading from this computer and remove its credential
  uninstall [--yes]   Delete local Tokentracky data and the credential

Options:
  --data-dir <dir>    Data folder (default: $TOKENTRACKY_HOME or ~/.tokentracky)
  --cloud-url <url>   Hosted leaderboard origin (default: $TOKENTRACKY_CLOUD_URL or https://tokentracky.com)
  --port <port>       Port for serve (default: random loopback port)
  --background        For serve without a terminal, as login's background job runs it: opens no browser
  -h, --help          Show this help
  -v, --version       Show the version
";

/// Looks up an environment variable by name.
pub type Env = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Called once `serve` is listening; the server runs until the returned future finishes, then closes.
pub type OnServe = Box<dyn Fn(ServeHandle) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// What `login` leaves running on Linux and Windows, where no Mac app keeps uploading: `serve` on the data folder, from
/// a copy of this program that stays put, now and at each sign-in.
pub trait Background: Send + Sync {
    /// Copies this program into place and starts `serve --background --data-dir <data_dir>` from it, with
    /// `TOKENTRACKY_HOME` set to `home` (the credential's folder) when given.
    fn install(&self, data_dir: &Path, home: Option<&Path>) -> std::io::Result<()>;
    /// Stops it starting again and deletes the copy; with nothing installed, there is nothing to do. `uninstall` has
    /// already stopped a running `serve`.
    fn remove(&self) -> std::io::Result<()>;
}

/// Everything a command takes from the process around it (`CliContext`).
pub struct Context {
    pub version: String,
    /// Reads an environment variable.
    pub env: Env,
    /// The home directory; `None` is the current user's.
    pub home: Option<PathBuf>,
    pub stdout: Box<dyn Write + Send>,
    pub stderr: Box<dyn Write + Send>,
    /// The persistent leaderboard credential store: a private file in the shipped binary. Without one the credential
    /// lasts only as long as the process, and `login` refuses.
    pub secret_store: Option<Arc<dyn SecretStore>>,
    /// Opens a page in the browser; failures are the caller's to ignore.
    pub open_url: Arc<dyn Fn(&str) + Send + Sync>,
    /// Opens the Tokentracky menu-bar app's window; false when the app is not installed, and on other systems.
    pub open_app: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The dashboard build `serve` serves.
    pub web_root: PathBuf,
    pub interactive: bool,
    /// Asks a yes/no question on the terminal.
    pub confirm: Box<dyn Fn(&str) -> bool + Send + Sync>,
    /// How long `login` waits between checks for approval.
    pub poll_interval: Duration,
    /// The time zone of the expiry time `login` prints. Read before the first thread starts, as the `time` crate
    /// requires.
    pub utc_offset: UtcOffset,
    /// What `serve` does while it runs. Without one `serve` closes at once.
    pub on_serve: Option<OnServe>,
    /// Where `login` can keep uploading without a terminal; `None` on macOS, where the Mac app does.
    pub background: Option<Arc<dyn Background>>,
}

impl Context {
    fn out(&mut self, text: &str) {
        let _ = self.stdout.write_all(text.as_bytes());
        let _ = self.stdout.flush();
    }
    fn err(&mut self, text: &str) {
        let _ = self.stderr.write_all(text.as_bytes());
        let _ = self.stderr.flush();
    }
    fn var(&self, name: &str) -> Option<String> {
        (self.env)(name)
    }
    fn home(&self) -> PathBuf {
        self.home.clone().or_else(std::env::home_dir).unwrap_or_default()
    }
    /// Without a credential store the credential lives only as long as this process (the pre-CLI `npm run dev` behaviour).
    fn secrets(&self) -> Arc<dyn SecretStore> {
        self.secret_store
            .clone()
            .unwrap_or_else(|| Arc::new(MemorySecretStore::default()))
    }
    fn pricing_refresh(&self) -> bool {
        tokentracky_pricing::pricing_refresh_enabled(self.var("TOKENTRACKY_PRICING_REFRESH").as_deref())
    }
}

/// Why a command did not succeed. In TypeScript only errors with a `code` (a refusal of the local API, a system
/// error) show their message; any other becomes the generic line.
#[derive(Debug)]
pub(crate) enum CliError {
    /// Printed with the usage; exit code 2.
    Usage(String),
    Shown(String),
    /// Another process holds the data folder; the command says so.
    Locked,
    Other,
}

impl From<LocalError> for CliError {
    fn from(error: LocalError) -> Self {
        Self::Shown(error.message.to_owned())
    }
}
impl From<std::io::Error> for CliError {
    fn from(error: std::io::Error) -> Self {
        Self::Shown(error.to_string())
    }
}
impl From<&StoreError> for CliError {
    fn from(error: &StoreError) -> Self {
        match error {
            StoreError::CollectorDatabaseLocked(_) => Self::Locked,
            StoreError::Sqlite(error) => Self::Shown(error.to_string()),
            StoreError::Io(error) => Self::Shown(error.to_string()),
            _ => Self::Other,
        }
    }
}
impl From<StoreError> for CliError {
    fn from(error: StoreError) -> Self {
        (&error).into()
    }
}
impl From<ServiceError> for CliError {
    fn from(error: ServiceError) -> Self {
        match &error {
            ServiceError::Store(error) => (&**error).into(),
            ServiceError::Io(error) => Self::Shown(error.to_string()),
            ServiceError::Database(error) => Self::Shown(error.to_string()),
            _ => Self::Other,
        }
    }
}
impl From<OpenError> for CliError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::Collector(error) => error.into(),
            OpenError::CloudUrl(error) => error.into(),
            OpenError::Interval(_) | OpenError::Http(_) => Self::Other,
        }
    }
}
/// A failure of the credential store, the HTTP client or a refresh cycle: the generic line.
fn other<E>(_: E) -> CliError {
    CliError::Other
}

/// `path.resolve`: relative to the working directory, with `.` and `..` removed lexically and links left alone.
fn resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path)
        .or_else(|_| std::env::current_dir().map(|directory| directory.join(path)))
        .unwrap_or_else(|_| path.to_path_buf());
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(resolved.components().next_back(), Some(Component::Normal(_))) {
                    resolved.pop();
                }
            }
            other => resolved.push(other),
        }
    }
    resolved
}

fn data_directory(flags: &args::Flags, context: &Context) -> PathBuf {
    let chosen = flags
        .data_dir
        .clone()
        .or_else(|| context.var("TOKENTRACKY_HOME").map(PathBuf::from))
        .unwrap_or_else(|| context.home().join(".tokentracky"));
    resolve(&chosen)
}
fn database_path(directory: &Path) -> PathBuf {
    directory.join("usage.sqlite")
}
fn running(directory: &Path) -> String {
    format!(
        "Tokentracky is already running with {} (tokentracky serve). It refreshes every 5 minutes; use Refresh in its dashboard, or stop it first.",
        directory.display()
    )
}
/// `mkdir(directory, {recursive: true, mode: 0o700})`. Windows has no mode: the folder takes the user profile's
/// owner-only access.
fn create_directory(directory: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(directory)
}

/// Runs one command and returns the process exit code: 0 on success, 1 on failure, 2 on a usage error. `argv` is the
/// arguments after the program name.
pub async fn run<I, T>(argv: I, context: &mut Context) -> i32
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    match dispatch(argv, context).await {
        Ok(code) => code,
        Err(CliError::Usage(message)) => {
            context.err(&format!("{message}\n\n{USAGE}"));
            2
        }
        Err(CliError::Shown(message)) => {
            context.err(&format!("{message}\n"));
            1
        }
        Err(CliError::Locked | CliError::Other) => {
            context.err("Tokentracky could not complete this command.\n");
            1
        }
    }
}

async fn dispatch<I, T>(argv: I, context: &mut Context) -> Result<i32, CliError>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let (command, flags) = args::parse(argv)?;
    let Some(command) = command else {
        context.out(USAGE);
        return Ok(1);
    };
    let directory = data_directory(&flags, context);
    let result = match command {
        Command::Help => {
            context.out(USAGE);
            Ok(0)
        }
        Command::Version => {
            let version = format!("{}\n", context.version);
            context.out(&version);
            Ok(0)
        }
        Command::Serve => serve::serve(&directory, &flags, context).await,
        Command::Open => commands::open_dashboard(&directory, context).await,
        Command::Status => commands::status(&directory, &flags, context).await,
        Command::Refresh => commands::refresh(&directory, &flags, context).await,
        Command::Doctor => commands::doctor(&directory, &flags, context).await,
        Command::Login => commands::login(&directory, &flags, context).await,
        Command::Unlink => commands::unlink(context).await,
        Command::Uninstall => commands::uninstall(&directory, &flags, context).await,
    };
    match result {
        Err(CliError::Locked) => {
            context.err(&format!("{}\n", running(&directory)));
            Ok(1)
        }
        other => other,
    }
}
