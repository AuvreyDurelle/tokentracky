//! The installed executable owns its dashboard; filesystem overrides are explicitly for development.
use std::path::{Path, PathBuf};

#[cfg(all(not(debug_assertions), not(feature = "embed-web")))]
compile_error!("release CLI requires --features embed-web; first run npm run build --workspace=@tokentracky/web");

#[cfg(feature = "embed-web")]
include!(concat!(env!("OUT_DIR"), "/web_bundle.rs"));

pub struct WebRoot {
    path: PathBuf,
    // Keep the private directory alive until after the server/runtime stop. TempDir removes it on normal exit.
    #[cfg(feature = "embed-web")]
    _directory: Option<tempfile::TempDir>,
}

impl WebRoot {
    pub fn open() -> std::io::Result<Self> {
        Self::resolve(std::env::var_os("TOKENTRACKY_WEB_ROOT"))
    }

    fn resolve(override_root: Option<std::ffi::OsString>) -> std::io::Result<Self> {
        if let Some(path) = override_root {
            return Ok(Self {
                path: path.into(),
                #[cfg(feature = "embed-web")]
                _directory: None,
            });
        }
        #[cfg(feature = "embed-web")]
        {
            // Create an unpredictable, exclusively owned 0700 directory. Never reuse a shared cache
            // or follow externally supplied paths. No user can replace files beneath this private parent.
            // Windows' temporary folder is already the user's own.
            let mut builder = tempfile::Builder::new();
            builder.prefix("tokentracky-web-");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                builder.permissions(std::fs::Permissions::from_mode(0o700));
            }
            let directory = builder.tempdir()?;
            for (name, bytes) in FILES {
                let path = directory.path().join(name);
                std::fs::create_dir_all(path.parent().expect("bundled file has parent"))?;
                std::fs::write(path, bytes)?;
            }
            Ok(Self {
                path: directory.path().to_owned(),
                _directory: Some(directory),
            })
        }
        #[cfg(not(feature = "embed-web"))]
        Ok(Self {
            path: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_override_wins_even_when_missing() {
        let root = WebRoot::resolve(Some("/nonexistent/development-dashboard".into())).unwrap();
        assert_eq!(root.path(), Path::new("/nonexistent/development-dashboard"));
    }

    #[cfg(feature = "embed-web")]
    #[test]
    fn extraction_is_private_complete_and_lifetime_bound() {
        let root = WebRoot::resolve(None).unwrap();
        let path = root.path().to_owned();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
        }
        assert!(
            std::fs::read_to_string(path.join("index.html"))
                .unwrap()
                .contains("<html")
        );
        for (name, bytes) in FILES {
            assert_eq!(std::fs::read(path.join(name)).unwrap(), *bytes);
        }
        drop(root);
        assert!(!path.exists());
    }
}
