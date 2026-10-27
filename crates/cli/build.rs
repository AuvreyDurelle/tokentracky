//! Generate a bundle of regular files only. Missing/incomplete Vite output is a build error.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in fs::read_dir(directory).expect("build the dashboard with npm run build --workspace=@tokentracky/web") {
        let entry = entry.expect("read dashboard entry");
        let path = entry.path();
        let kind = entry.file_type().expect("read dashboard file type");
        assert!(!kind.is_symlink(), "dashboard bundle must not contain symlinks");
        if kind.is_dir() {
            collect(root, &path, files);
        } else {
            assert!(kind.is_file(), "dashboard bundle must contain regular files only");
            let relative = path.strip_prefix(root).expect("dashboard path below root");
            assert!(relative.to_str().is_some(), "dashboard paths must be UTF-8");
            files.push(relative.to_owned());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_EMBED_WEB").is_none() {
        return;
    }
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../apps/web/dist");
    let mut files = Vec::new();
    collect(&root, &root, &mut files);
    files.sort();
    let index = fs::read_to_string(root.join("index.html")).expect("dashboard bundle requires index.html");
    assert!(index.contains("<html"), "dashboard index.html must be nonempty HTML");
    // Vite's entry scripts/styles are root-relative. Refuse a partial build, even if index.html survived.
    let mut javascript = false;
    let mut stylesheet = false;
    for reference in index.split(['\"', '\'']).filter(|part| part.starts_with("/assets/")) {
        let path = Path::new(&reference[1..]);
        assert!(
            files.iter().any(|file| file == path),
            "missing dashboard asset: {reference}"
        );
        assert!(
            fs::metadata(root.join(path)).unwrap().len() > 0,
            "empty dashboard asset: {reference}"
        );
        javascript |= reference.ends_with(".js");
        stylesheet |= reference.ends_with(".css");
    }
    assert!(
        javascript && stylesheet,
        "dashboard index must reference built JavaScript and CSS"
    );
    let mut generated = String::from("const FILES: &[(&str, &[u8])] = &[\n");
    for file in files {
        println!("cargo:rerun-if-changed={}", root.join(&file).display());
        generated.push_str(&format!(
            "({:?}, include_bytes!({:?})),\n",
            file.to_str().unwrap(),
            root.join(&file)
        ));
    }
    generated.push_str("];\n");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("web_bundle.rs"),
        generated,
    )
    .expect("write dashboard bundle");
}
