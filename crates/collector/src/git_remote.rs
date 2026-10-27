//! The repository name of a local project folder, read only from its git metadata.
use crate::resolve;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use tokentracky_core::is_js_space;

/// Files longer than this many UTF-16 units (`text.length`) are not read.
const MAX_BYTES: usize = 64 * 1024;
/// What JavaScript's `.` does not match, and where its multiline `^` matches after.
const LINE_TERMINATORS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];

/// A small text file, decoded as lossy UTF-8; `None` when unreadable or too long.
fn small(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    // Every unit takes at most 3 bytes, so a longer read cannot change the answer.
    let limit = 3 * MAX_BYTES as u64 + 1;
    File::open(path).ok()?.take(limit).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    (text.encode_utf16().count() <= MAX_BYTES).then(|| text.into_owned())
}
/// `/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i`
fn url_path(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    let mut scheme = scheme.chars();
    let valid = scheme.next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    let (host, path) = rest.split_once('/')?;
    (valid && !host.is_empty() && !path.is_empty() && !path.contains(LINE_TERMINATORS)).then_some(path)
}
/// `/^[^@/\s]+@[^:/\s]+:(.+)$/`
fn scp_path(url: &str) -> Option<&str> {
    let (user, rest) = url.split_once('@')?;
    let (host, path) = rest.split_once(':')?;
    let plain = |part: &str| !part.is_empty() && !part.contains(|c| c == '/' || is_js_space(c));
    (plain(user) && plain(host) && !path.is_empty() && !path.contains(LINE_TERMINATORS)).then_some(path)
}

/// `owner/repo` from a remote URL: https, ssh and scp-style forms. Credentials and hosts are dropped.
pub fn repository_from_url(url: &str) -> Option<String> {
    let path = url_path(url).or_else(|| scp_path(url))?;
    // `/^\/?([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?\/?$/`
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_suffix('/').unwrap_or(path);
    let (owners, name) = path.rsplit_once('/')?;
    let word = |segment: &str| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    if !owners.split('/').all(word) || !word(name) {
        return None;
    }
    let name = name
        .strip_suffix(".git")
        .filter(|name| !name.is_empty())
        .unwrap_or(name);
    let owner = owners.rsplit('/').next()?;
    Some(format!("{owner}/{name}"))
}

/// `/^\s*\[\s*remote\s+"([^"]+)"\s*\]/`
fn remote_section(line: &str) -> Option<&str> {
    let rest = line
        .trim_start_matches(is_js_space)
        .strip_prefix('[')?
        .trim_start_matches(is_js_space)
        .strip_prefix("remote")?;
    let quoted = rest.trim_start_matches(is_js_space);
    if quoted.len() == rest.len() {
        return None;
    }
    let (name, rest) = quoted.strip_prefix('"')?.split_once('"')?;
    (!name.is_empty() && rest.trim_start_matches(is_js_space).starts_with(']')).then_some(name)
}
/// `/^\s*url\s*=\s*(\S+)\s*$/`
fn url_entry(line: &str) -> Option<&str> {
    let value = line
        .trim_start_matches(is_js_space)
        .strip_prefix("url")?
        .trim_start_matches(is_js_space)
        .strip_prefix('=')?
        .trim_matches(is_js_space);
    (!value.is_empty() && !value.contains(is_js_space)).then_some(value)
}

/// The `origin` remote, else the first remote, in a git config file.
pub fn remote_url(config: &str) -> Option<String> {
    let mut remote = None;
    let mut urls: Vec<(&str, &str)> = Vec::new();
    for line in config.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)) {
        if let Some(name) = remote_section(line) {
            remote = Some(name);
            continue;
        }
        if line.trim_start_matches(is_js_space).starts_with('[') {
            remote = None;
            continue;
        }
        if let Some(name) = remote
            && let Some(url) = url_entry(line)
            && !urls.iter().any(|(seen, _)| *seen == name)
        {
            urls.push((name, url));
        }
    }
    let origin = urls.iter().find(|(name, _)| *name == "origin");
    origin.or(urls.first()).map(|(_, url)| (*url).to_owned())
}

/// `/^gitdir:\s*(.+?)\s*$/m`: the value of the first line that starts `gitdir:`.
fn gitdir(pointer: &str) -> Option<&str> {
    let starts = std::iter::once(0).chain(
        pointer
            .match_indices(LINE_TERMINATORS)
            .map(|(at, terminator)| at + terminator.len()),
    );
    let rest = starts.filter_map(|at| pointer[at..].strip_prefix("gitdir:")).next()?;
    let value = rest
        .trim_start_matches(is_js_space)
        .split(LINE_TERMINATORS)
        .next()?
        .trim_end_matches(is_js_space);
    (!value.is_empty()).then_some(value)
}

/// Repository name for a local project folder. Reads only git metadata: `.git/config`, or for a linked worktree the
/// `.git` pointer file and the shared config it leads to. Never leaves this computer.
pub fn project_repository(project: &str) -> Option<String> {
    if !Path::new(project).is_absolute() {
        return None;
    }
    let project = resolve(Path::new(project));
    let config = match small(&project.join(".git/config")) {
        Some(config) => config,
        None => {
            let worktree = resolve(&project.join(gitdir(&small(&project.join(".git"))?)?));
            let common = small(&worktree.join("commondir"));
            let common = common.as_deref().map(|common| common.trim_matches(is_js_space));
            let shared = match common.filter(|common| !common.is_empty()) {
                Some(common) => resolve(&worktree.join(common)),
                None => worktree,
            };
            small(&shared.join("config"))?
        }
    };
    repository_from_url(&remote_url(&config)?)
}
