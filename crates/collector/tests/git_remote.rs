//! The repository name of a project folder, from its git metadata.
use std::fs;
use tokentracky_collector::git_remote::{project_repository, remote_url, repository_from_url};

#[test]
fn names_the_repository_from_common_remote_url_forms_without_credentials_or_hosts() {
    let named = |url| repository_from_url(url);
    assert_eq!(
        named("https://github.com/synthetic-owner/synthetic-repo.git").as_deref(),
        Some("synthetic-owner/synthetic-repo")
    );
    assert_eq!(
        named("https://user:secret@github.com/synthetic-owner/synthetic-repo").as_deref(),
        Some("synthetic-owner/synthetic-repo")
    );
    assert_eq!(
        named("git@github.com:synthetic-owner/synthetic-repo.git").as_deref(),
        Some("synthetic-owner/synthetic-repo")
    );
    assert_eq!(
        named("ssh://git@example.com:22/group/sub/synthetic-repo.git/").as_deref(),
        Some("sub/synthetic-repo")
    );
    for url in [
        "/srv/git/synthetic-repo.git",
        "file:///srv/synthetic-repo",
        "https://example.com/only",
        "",
    ] {
        assert_eq!(named(url), None, "{url}");
    }
}

#[test]
fn prefers_origin_then_the_first_remote() {
    let config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://example.com/a/up.git\n[remote \"origin\"]\n\tfetch = +refs/heads/*\n\turl = git@example.com:a/mine.git\n[branch \"main\"]\n\turl = nope\n";
    assert_eq!(remote_url(config).as_deref(), Some("git@example.com:a/mine.git"));
    assert_eq!(
        remote_url("[remote \"fork\"]\n  url = https://example.com/b/fork\n").as_deref(),
        Some("https://example.com/b/fork")
    );
    assert_eq!(remote_url("[core]\n"), None);
}

#[test]
fn reads_a_checkout_or_a_linked_worktree_and_nothing_for_other_folders() {
    let root = tempfile::Builder::new().prefix("tokentracky-git-").tempdir().unwrap();
    let root = root.path();
    let checkout = root.join("checkout");
    fs::create_dir_all(checkout.join(".git/worktrees/feature")).unwrap();
    fs::write(
        checkout.join(".git/config"),
        "[remote \"origin\"]\n\turl = https://github.com/synthetic-owner/synthetic-repo.git\n",
    )
    .unwrap();
    fs::write(checkout.join(".git/worktrees/feature/commondir"), "../..\n").unwrap();
    let worktree = root.join("feature");
    fs::create_dir(&worktree).unwrap();
    let pointer = format!("gitdir: {}\n", checkout.join(".git/worktrees/feature").display());
    fs::write(worktree.join(".git"), pointer).unwrap();
    let repository = |path: &std::path::Path| project_repository(&path.to_string_lossy());
    assert_eq!(repository(&checkout).as_deref(), Some("synthetic-owner/synthetic-repo"));
    assert_eq!(repository(&worktree).as_deref(), Some("synthetic-owner/synthetic-repo"));
    assert_eq!(repository(root), None);
    assert_eq!(project_repository("relative/project"), None);
}
