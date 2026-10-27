//! The leaderboard credential in a private file that the app and the CLI share.
//! Supabase still issues, checks and revokes the device token; this file is only this computer's copy. It holds the
//! same base64 JSON value the Keychain item held, in `cloud-link.json` in the data folder (`$TOKENTRACKY_HOME`, else
//! `~/.tokentracky`; `--data-dir` does not move it). A file, not the Keychain: an ad-hoc signed build has no team
//! identity, so the Keychain would ask for the password after every update and whenever the other binary reads it.
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use tokentracky_local_api::{BoxFuture, CloudLink, SecretError, SecretStore};

const FILE: &str = "cloud-link.json";
/// A link is a few hundred bytes; anything far larger is not one.
const MAX_BYTES: u64 = 64 * 1024;

fn unavailable() -> SecretError {
    "credential_unavailable".into()
}

/// The credential file. Every failure other than "no file" is `credential_unavailable`.
#[derive(Debug, Clone)]
pub struct FileSecretStore {
    path: PathBuf,
}

impl FileSecretStore {
    /// An explicit runtime-test namespace isolates both app and CLI from the user's cloud link.
    /// Invalid/empty values fail closed: never fall back to the production file during a test.
    pub fn from_env() -> Result<Self, SecretError> {
        let namespace = std::env::var_os("TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE")
            .map(|value| value.into_string().map_err(|_| unavailable()))
            .transpose()?;
        let home = std::env::var("TOKENTRACKY_HOME").ok().filter(|home| !home.is_empty());
        let folder = match &home {
            Some(home) => PathBuf::from(home),
            None => PathBuf::from(std::env::var_os("HOME").ok_or_else(unavailable)?).join(".tokentracky"),
        };
        let store = Self::with_test_namespace(&folder, namespace.as_deref())?;
        if let Some(fixture) = std::env::var_os("TOKENTRACKY_TEST_CLOUD_FIXTURE") {
            // A generated fake link can exercise sync without ever reading the user's credential. App and CLI
            // use separate test namespaces, so each reads back only the link it wrote.
            let link = Self::fixture_link(
                fixture.to_str(),
                namespace.as_deref(),
                home.as_deref(),
                &std::env::var("TOKENTRACKY_TEST_CLOUD_URL")?,
            )?;
            store.write(&link)?;
        }
        Ok(store)
    }

    fn fixture_link(
        enabled: Option<&str>,
        namespace: Option<&str>,
        home: Option<&str>,
        origin: &str,
    ) -> Result<CloudLink, SecretError> {
        if enabled != Some("1")
            || namespace.is_none()
            || !home.is_some_and(|home| std::path::Path::new(home).is_absolute())
        {
            return Err("invalid_test_cloud_fixture".into());
        }
        Self::with_test_namespace(Path::new("/"), namespace)?;
        let url = tokentracky_local_api::cloud_origin(origin)?;
        if url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|port| port.parse::<u16>().ok())
            .is_none()
        {
            return Err("test_cloud_fixture_requires_loopback".into());
        }
        Ok(CloudLink {
            url,
            device_token: format!("synthetic-native-runtime-{}", namespace.unwrap_or_default()),
            history_start: None,
            share_tools: true,
            share_cost: true,
            share_models: true,
            generation: "11111111-2222-3333-4444-555555555555".into(),
        })
    }

    fn with_test_namespace(folder: &Path, namespace: Option<&str>) -> Result<Self, SecretError> {
        match namespace {
            None => Ok(Self::at(folder.join(FILE))),
            Some(value)
                if (8..=100).contains(&value.len())
                    && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') =>
            {
                Ok(Self::at(folder.join(format!("cloud-link.native-test.{value}.json"))))
            }
            Some(_) => Err("invalid_test_keychain_namespace".into()),
        }
    }

    /// The credential at an explicit path, for tests that must not touch the real file.
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }
    fn read(&self) -> Result<Option<CloudLink>, SecretError> {
        // O_NOFOLLOW: a symlink planted at the path is refused rather than followed.
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unavailable()),
        };
        let metadata = file.metadata().map_err(|_| unavailable())?;
        // Only the owner may read it; a file others can read may already have leaked the token.
        if !metadata.is_file() || metadata.mode() & 0o077 != 0 || metadata.len() > MAX_BYTES {
            return Err(unavailable());
        }
        let mut encoded = String::new();
        file.take(MAX_BYTES)
            .read_to_string(&mut encoded)
            .map_err(|_| unavailable())?;
        let bytes = STANDARD.decode(encoded.trim()).map_err(|_| unavailable())?;
        serde_json::from_slice(&bytes).map(Some).map_err(|_| unavailable())
    }
    fn write(&self, link: &CloudLink) -> Result<(), SecretError> {
        let encoded = STANDARD.encode(serde_json::to_vec(link).map_err(|_| unavailable())?);
        let folder = self.path.parent().ok_or_else(unavailable)?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(folder)
            .map_err(|_| unavailable())?;
        // A 0600 temporary file renamed over the old one: readers see the old link or the new one, never half.
        let mut temporary = tempfile::Builder::new()
            .prefix(".cloud-link.")
            .tempfile_in(folder)
            .map_err(|_| unavailable())?;
        temporary.write_all(encoded.as_bytes()).map_err(|_| unavailable())?;
        temporary.as_file().sync_all().map_err(|_| unavailable())?;
        temporary.persist(&self.path).map_err(|_| unavailable())?;
        if let Ok(folder) = File::open(folder) {
            let _ = folder.sync_all();
        }
        // Confirm by reading the file back, as the Keychain store did.
        (self.read()?.as_ref() == Some(link))
            .then_some(())
            .ok_or_else(unavailable)
    }
    fn remove(&self) -> Result<(), SecretError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self) -> BoxFuture<'_, Result<Option<CloudLink>, SecretError>> {
        Box::pin(async move { self.read() })
    }
    fn set(&self, link: CloudLink) -> BoxFuture<'_, Result<(), SecretError>> {
        Box::pin(async move { self.write(&link) })
    }
    fn clear(&self) -> BoxFuture<'_, Result<(), SecretError>> {
        Box::pin(async move { self.remove() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn link() -> CloudLink {
        CloudLink {
            url: "https://example.test".into(),
            device_token: "t".repeat(32),
            history_start: Some("2026-10-21T00:00:00.000Z".into()),
            share_tools: true,
            share_cost: false,
            share_models: true,
            generation: "11111111-2222-3333-4444-555555555555".into(),
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn test_namespace_cannot_select_the_real_file_or_fall_back() {
        let folder = Path::new("/synthetic/data");
        for invalid in [
            "",
            "short",
            "tokentracky/cloud-link",
            "white space",
            "éééé",
            "../../escape-1234",
        ] {
            assert!(FileSecretStore::with_test_namespace(folder, Some(invalid)).is_err());
        }
        let store = FileSecretStore::with_test_namespace(folder, Some("runtime-12345678")).unwrap();
        assert_eq!(store.path, folder.join("cloud-link.native-test.runtime-12345678.json"));
        let real = FileSecretStore::with_test_namespace(folder, None).unwrap();
        assert_eq!(real.path, folder.join(FILE));
    }

    #[test]
    fn synthetic_cloud_link_requires_explicit_isolation_and_loopback() {
        let fixture = |flag, namespace, home, url| FileSecretStore::fixture_link(flag, namespace, home, url);
        let namespace = Some("runtime-12345678");
        let home = Some("/synthetic/native-runtime/data");
        assert!(fixture(Some("1"), namespace, home, "http://127.0.0.1:54321").is_ok());
        for url in [
            "https://tokentracky.vercel.app",
            "http://example.test:123",
            "http://127.0.0.1:123/path",
            "http://user:pass@127.0.0.1:123",
        ] {
            assert!(fixture(Some("1"), namespace, home, url).is_err());
        }
        assert!(fixture(Some("1"), None, home, "http://127.0.0.1:123").is_err());
        assert!(fixture(Some("1"), namespace, None, "http://127.0.0.1:123").is_err());
        assert!(fixture(Some("1"), namespace, Some(""), "http://127.0.0.1:123").is_err());
        assert!(fixture(None, namespace, home, "http://127.0.0.1:123").is_err());
    }

    #[test]
    fn round_trips_a_private_link_and_clears_it() {
        let folder = tempfile::tempdir().unwrap();
        let data = folder.path().join("data");
        let store = FileSecretStore::at(data.join(FILE));
        assert_eq!(store.read().unwrap(), None);
        store.write(&link()).unwrap();
        assert_eq!(store.read().unwrap(), Some(link()));
        assert_eq!(mode(&data.join(FILE)), 0o600);
        assert_eq!(mode(&data), 0o700);

        let replaced = CloudLink {
            device_token: "u".repeat(32),
            ..link()
        };
        store.write(&replaced).unwrap();
        assert_eq!(store.read().unwrap(), Some(replaced));
        // Only the credential is left behind: no temporary file survives a write.
        let names: Vec<_> = std::fs::read_dir(&data)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE]);

        store.remove().unwrap();
        store.remove().unwrap();
        assert_eq!(store.read().unwrap(), None);
    }

    #[test]
    fn refuses_a_file_others_can_read() {
        let folder = tempfile::tempdir().unwrap();
        let store = FileSecretStore::at(folder.path().join(FILE));
        store.write(&link()).unwrap();
        for loose in [0o640, 0o604, 0o644] {
            std::fs::set_permissions(&store.path, std::fs::Permissions::from_mode(loose)).unwrap();
            assert!(store.read().is_err(), "mode {loose:o}");
        }
        // Writing again replaces the loose file with a private one.
        store.write(&link()).unwrap();
        assert_eq!(mode(&store.path), 0o600);
    }

    #[test]
    fn refuses_a_symlink_and_does_not_write_through_it() {
        let folder = tempfile::tempdir().unwrap();
        let target = folder.path().join("elsewhere.json");
        FileSecretStore::at(target.clone()).write(&link()).unwrap();
        let path = folder.path().join(FILE);
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let store = FileSecretStore::at(path.clone());
        assert!(store.read().is_err());

        let replaced = CloudLink {
            device_token: "u".repeat(32),
            ..link()
        };
        store.write(&replaced).unwrap();
        assert!(!std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert_eq!(FileSecretStore::at(target).read().unwrap(), Some(link()));
    }

    #[test]
    fn corrupt_or_oversized_content_is_unavailable_not_absent() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join(FILE);
        let store = FileSecretStore::at(path.clone());
        for content in [
            b"not base64 !".to_vec(),
            STANDARD.encode(b"{\"url\":1}").into_bytes(),
            vec![b'A'; MAX_BYTES as usize + 4],
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            file.write_all(&content).unwrap();
            assert!(store.read().is_err());
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(store.read().is_err());
    }
}
