//! The bundled snapshot and the daily refresh with its 24-hour disk cache.
use crate::{Json, PricingError, PricingTable, table::is_js_whitespace, trim_litellm};
use serde::Deserialize;
use std::{
    error::Error,
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

pub const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub const REFRESH_AFTER_MS: i64 = 24 * 3_600_000;
/// The largest download accepted; a [`Transport`] should stop reading at this size.
pub const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;

#[derive(Deserialize)]
struct Snapshot {
    source: SnapshotSource,
    models: Json,
}
#[derive(Deserialize)]
struct SnapshotSource {
    #[serde(rename = "fetchedAt")]
    fetched_at: String,
}

struct Bundled {
    table: Arc<PricingTable>,
    /// When the snapshot was fetched, in milliseconds since the Unix epoch.
    fetched_at: i64,
}

fn bundled() -> &'static Bundled {
    static BUNDLED: OnceLock<Bundled> = OnceLock::new();
    BUNDLED.get_or_init(|| {
        let snapshot: Snapshot = serde_json::from_str(include_str!("../data/litellm-prices.json"))
            .expect("the bundled pricing snapshot is valid JSON");
        Bundled {
            table: Arc::new(
                PricingTable::new(&snapshot.models).expect("the bundled pricing snapshot is a price table"),
            ),
            fetched_at: parse_ms(&snapshot.source.fetched_at).expect("the bundled snapshot has a fetch time"),
        }
    })
}

/// The offline snapshot shipped with the app (LiteLLM, MIT; see `data/LICENSE-litellm.txt`).
pub fn bundled_table() -> Arc<PricingTable> {
    bundled().table.clone()
}

/// `TOKENTRACKY_PRICING_REFRESH=off` keeps the bundled snapshot and makes no pricing download.
pub fn pricing_refresh_enabled(value: Option<&str>) -> bool {
    let value = value.unwrap_or("").trim_matches(is_js_whitespace).to_lowercase();
    !["off", "0", "false", "no"].contains(&value.as_str())
}

fn parse_ms(iso: &str) -> Option<i64> {
    OffsetDateTime::parse(iso, &Rfc3339).ok().map(unix_ms)
}

fn unix_ms(time: OffsetDateTime) -> i64 {
    time.unix_timestamp() * 1000 + i64::from(time.millisecond())
}

/// `Date.prototype.toISOString`.
fn iso(time: OffsetDateTime) -> String {
    let t = time.to_offset(UtcOffset::UTC);
    let (year, month, day) = (t.year(), u8::from(t.month()), t.day());
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

pub type TransportError = Box<dyn Error + Send + Sync>;

/// How the refresher downloads the table. The implementation owns the HTTP rules: one `GET` with
/// `Accept: application/json`, no redirects, a 20-second timeout, and the body capped at
/// [`MAX_DOWNLOAD_BYTES`] (check `Content-Length` first). A non-2xx status is an error.
pub trait Transport: Send + Sync {
    fn fetch(&self, url: &str) -> impl Future<Output = Result<String, TransportError>> + Send;
}

pub type Clock = Box<dyn Fn() -> OffsetDateTime + Send + Sync>;

pub struct RefresherOptions<T> {
    pub cache_path: PathBuf,
    pub enabled: bool,
    /// Defaults to [`LITELLM_URL`].
    pub url: Option<String>,
    pub transport: T,
    /// Defaults to the system clock.
    pub now: Option<Clock>,
}

#[derive(Deserialize)]
struct Cache {
    #[serde(rename = "fetchedAt")]
    fetched_at: Option<String>,
    models: Option<Json>,
}

/// Daily LiteLLM refresh with a 24-hour disk cache. The download is the only outbound pricing request and
/// carries no usage data; failures keep the current table.
pub struct PricingRefresher<T> {
    options: RefresherOptions<T>,
    table: Arc<PricingTable>,
    fetched_at: i64,
}

impl<T: Transport> PricingRefresher<T> {
    pub fn new(options: RefresherOptions<T>) -> Self {
        let bundled = bundled();
        let mut refresher = Self {
            table: bundled.table.clone(),
            fetched_at: bundled.fetched_at,
            options,
        };
        if refresher.options.enabled {
            refresher.load_cache();
        }
        refresher
    }

    pub fn current(&self) -> Arc<PricingTable> {
        self.table.clone()
    }

    fn now(&self) -> OffsetDateTime {
        self.options
            .now
            .as_ref()
            .map_or_else(OffsetDateTime::now_utc, |now| now())
    }

    /// Downloads only when the active table is more than 24 hours old. Returns true when prices changed.
    pub async fn refresh(&mut self) -> Result<bool, PricingError> {
        if !self.options.enabled || unix_ms(self.now()) - self.fetched_at < REFRESH_AFTER_MS {
            return Ok(false);
        }
        let url = self.options.url.as_deref().unwrap_or(LITELLM_URL);
        let text = self
            .options
            .transport
            .fetch(url)
            .await
            .map_err(PricingError::Transport)?;
        // `text.length` in TypeScript counts UTF-16 units.
        if text.encode_utf16().count() > MAX_DOWNLOAD_BYTES {
            return Err(PricingError::TooLarge);
        }
        let models = trim_litellm(&serde_json::from_str(&text)?)?;
        let table = Arc::new(PricingTable::new(&models)?);
        let fetched_at = self.now();
        write_cache(&self.options.cache_path, fetched_at, &models)?;
        let changed = table.version() != self.table.version();
        self.table = table;
        self.fetched_at = unix_ms(fetched_at);
        Ok(changed)
    }

    /// A missing or corrupt cache keeps the bundled snapshot.
    fn load_cache(&mut self) {
        let Ok(text) = fs::read_to_string(&self.options.cache_path) else {
            return;
        };
        let Ok(Cache {
            fetched_at: Some(fetched_at),
            models: Some(models),
        }) = serde_json::from_str(&text)
        else {
            return;
        };
        // A cache older than the snapshot shipped in an app update is stale by definition.
        let Some(fetched_at) = parse_ms(&fetched_at).filter(|&at| at > bundled().fetched_at) else {
            return;
        };
        if let Ok(table) = PricingTable::new(&models) {
            self.table = Arc::new(table);
            self.fetched_at = fetched_at;
        }
    }
}

/// Writes the cache through a temporary file and a rename, so a reader never sees half a file.
fn write_cache(path: &Path, fetched_at: OffsetDateTime, models: &Json) -> io::Result<()> {
    let mut directory = DirBuilder::new();
    directory.recursive(true);
    let mut file = OpenOptions::new();
    file.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        directory.mode(0o700);
        file.mode(0o600);
    }
    if let Some(parent) = path.parent() {
        directory.create(parent)?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let body = format!(
        "{{\"fetchedAt\":\"{}\",\"models\":{}}}",
        iso(fetched_at),
        models.to_json_string()
    );
    file.open(&temporary)?.write_all(body.as_bytes())?;
    fs::rename(temporary, path)
}
