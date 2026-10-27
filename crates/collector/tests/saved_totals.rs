//! The saved totals each write keeps up to date read the same as totals built afresh from the events, and as the
//! events themselves.
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::macros::datetime;
use tokentracky_collector::store::{FileCheckpoint, PricedCost, Pricer, QueryOptions, UsageStore};
use tokentracky_core::{CostParts, TokenCounts, ToolId, UsageEvent, total_tokens};

const EMPTY_DIGEST: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOW: OffsetDateTime = datetime!(2026-10-26 13:30 UTC);
/// The Claude Code event an OmO request mirrors.
const MIRRORED: &str = "claude:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn checkpoint(path: &str, tool: ToolId) -> FileCheckpoint {
    FileCheckpoint {
        path: path.to_owned(),
        tool,
        identity: "1:2".to_owned(),
        offset: 0,
        prefix_hash: EMPTY_DIGEST.to_owned(),
        parser_version: 1,
        state: json!({"sessionId": null, "project": null, "model": "unknown", "turnId": null, "previous": null, "baselines": [], "seenDeltaIds": []}),
        diagnostics: Vec::new(),
        file_size: None,
        mtime_ms: None,
        ctime_ms: None,
    }
}
fn usage(id: &str, tool: ToolId, session: &str, at: Option<&str>, input: u64) -> UsageEvent {
    UsageEvent {
        event_id: id.to_owned(),
        claude_mirror_id: None,
        tool,
        model: if tool == ToolId::Codex {
            "gpt-5"
        } else {
            "claude-opus-4-5"
        }
        .to_owned(),
        occurred_at: at.map(str::to_owned),
        project: Some(format!("/work/{session}")),
        session_id: session.to_owned(),
        tokens: TokenCounts {
            input,
            output: 5,
            cache_read: 100,
            ..TokenCounts::default()
        },
        service_tier: None,
        cost_microusd: None,
        pricing_version: None,
    }
}
/// Prices every model but `unpriced` at `rate` per input token.
fn pricer(rate: u64) -> Pricer {
    Box::new(move |event: &UsageEvent| {
        (event.model != "unpriced").then(|| {
            let parts = CostParts {
                input: rate * event.tokens.input,
                output: event.tokens.output,
                ..CostParts::default()
            };
            PricedCost {
                cost_microusd: parts.total(),
                pricing_version: format!("rate-{rate}"),
                parts,
            }
        })
    })
}
/// Every query the saved totals answer, in UTC and in a zone a quarter hour off the hour.
fn read(store: &UsageStore) -> Value {
    let kathmandu = jiff::tz::TimeZone::get("Asia/Kathmandu").unwrap();
    let all = QueryOptions {
        now: Some(NOW),
        ..QueryOptions::default()
    };
    let local = QueryOptions {
        tz: Some(kathmandu.clone()),
        ..all.clone()
    };
    let counts: Vec<(ToolId, u64)> = store
        .source_statuses()
        .unwrap()
        .into_iter()
        .map(|source| (source.id, source.event_count))
        .collect();
    json!({
        "summary": store.summary(&all).unwrap(),
        "local": store.summary(&local).unwrap(),
        "sessions": store.sessions(&all).unwrap(),
        "breakdown": store.breakdown(&local).unwrap(),
        "projects": store.projects(&all).unwrap(),
        "period": store.period_totals(NOW, Some(&kathmandu)).unwrap(),
        "counts": counts,
    })
}
/// What the saved totals read now equals what they read once built again (a new price version builds them again),
/// and their totals are the events' own.
fn check(store: &mut UsageStore, step: &str, rate: u64, version: &mut u32) {
    let kept = read(store);
    *version += 1;
    store.set_pricer(Some(pricer(rate)), Some(&format!("v{version}")));
    assert_eq!(kept, read(store), "after {step}");
    let events = store.events(&QueryOptions::default()).unwrap();
    let summary = &kept["summary"];
    assert_eq!(
        summary["tokens"],
        json!(events.iter().map(|event| total_tokens(&event.tokens)).sum::<u64>()),
        "after {step}"
    );
    let costs: Option<u64> = events.iter().map(|event| event.cost_microusd).sum();
    assert_eq!(
        summary["costMicrousd"],
        json!(costs.filter(|_| !events.is_empty())),
        "after {step}"
    );
}

#[test]
fn every_write_keeps_the_saved_totals_as_built_afresh() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("usage.sqlite");
    let mut store = UsageStore::open(&path).unwrap();
    let mut version = 0;
    store.set_pricer(Some(pricer(2)), Some("v0"));
    let (a, b, c, m) = (
        checkpoint("/logs/a.jsonl", ToolId::Claude),
        checkpoint("/logs/b.jsonl", ToolId::Codex),
        checkpoint("/logs/c.jsonl", ToolId::Claude),
        checkpoint("/logs/m.jsonl", ToolId::Omo),
    );
    let at = |time: &str| Some(format!("2026-10-25T{time}Z"));
    let first = [
        usage("e1", ToolId::Claude, "s1", at("18:10:00.000").as_deref(), 10),
        usage("e2", ToolId::Claude, "s1", at("18:20:00.000").as_deref(), 20),
        usage("e3", ToolId::Claude, "s2", at("18:20:00.000").as_deref(), 30),
        usage(MIRRORED, ToolId::Claude, "s3", at("23:59:59.999").as_deref(), 40),
        usage("undated", ToolId::Claude, "s3", None, 50),
    ];
    store.commit_file(&a, &first, true).unwrap();
    check(&mut store, "the first file", 2, &mut version);

    // An appended event beside one sent again unchanged, then a whole file read twice with one event changed, one
    // gone and one new.
    let appended = [
        first[1].clone(),
        usage("e4", ToolId::Claude, "s2", at("18:44:59.999").as_deref(), 60),
    ];
    store.commit_file(&a, &appended, false).unwrap();
    check(&mut store, "an append", 2, &mut version);
    let codex = [
        usage("c1", ToolId::Codex, "s4", at("08:00:00.000").as_deref(), 70),
        usage("c2", ToolId::Codex, "s4", at("08:15:00.000").as_deref(), 80),
    ];
    store.commit_file(&b, &codex, true).unwrap();
    let mut unpriced = usage("c3", ToolId::Codex, "s4", at("09:00:00.000").as_deref(), 90);
    unpriced.model = "unpriced".to_owned();
    let changed = [
        usage("c1", ToolId::Codex, "s4", at("08:00:00.000").as_deref(), 75),
        unpriced,
    ];
    store.commit_file(&b, &changed, true).unwrap();
    check(&mut store, "a replaced file", 2, &mut version);

    store
        .commit_file_withdrawing(&a, &[], false, &["e1".to_owned()])
        .unwrap();
    check(&mut store, "a withdrawal", 2, &mut version);

    // An OmO request hides the Claude Code event it mirrors, until it is gone again.
    let mut mirror = usage("omo:1", ToolId::Omo, "s5", at("23:59:59.999").as_deref(), 40);
    mirror.claude_mirror_id = Some(MIRRORED.to_owned());
    store.commit_file(&m, &[mirror], true).unwrap();
    check(&mut store, "a mirror", 2, &mut version);
    store.commit_file(&m, &[], true).unwrap();
    check(&mut store, "a mirror removed", 2, &mut version);

    // A correction of e3 in another file supersedes it, at a new revision.
    let mut corrected = usage("e3", ToolId::Claude, "s2", at("18:50:00.000").as_deref(), 33);
    corrected.project = Some("/work/elsewhere".to_owned());
    store.commit_file(&c, &[corrected], true).unwrap();
    check(&mut store, "a correction", 2, &mut version);

    store.forget_file("/logs/a.jsonl", ToolId::Claude).unwrap();
    check(&mut store, "a forgotten file", 2, &mut version);

    // New prices re-price every saved total.
    version += 1;
    store.set_pricer(Some(pricer(3)), Some(&format!("v{version}")));
    assert_eq!(read(&store)["sessions"][0]["costMicrousd"], json!(3 * 33 + 5));
    check(&mut store, "new prices", 3, &mut version);
}

#[test]
fn totals_saved_before_another_version_wrote_usage_are_built_again() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("usage.sqlite");
    let mut store = UsageStore::open(&path).unwrap();
    store.set_pricer(Some(pricer(2)), Some("v1"));
    let events = [
        usage("e1", ToolId::Claude, "s1", Some("2026-10-25T18:10:00.000Z"), 10),
        usage("c1", ToolId::Codex, "s2", Some("2026-10-25T18:10:00.000Z"), 20),
    ];
    store
        .commit_file(&checkpoint("/logs/a.jsonl", ToolId::Claude), &events[..1], true)
        .unwrap();
    store
        .commit_file(&checkpoint("/logs/b.jsonl", ToolId::Codex), &events[1..], true)
        .unwrap();
    assert_eq!(store.summary(&QueryOptions::default()).unwrap().tokens, 240);
    store.close().unwrap();

    // An older version forgets a file, knowing nothing of the saved totals.
    let older = rusqlite::Connection::open(&path).unwrap();
    older.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    older
        .execute("DELETE FROM files WHERE path='codex:/logs/b.jsonl'", [])
        .unwrap();
    older.close().unwrap();

    let mut store = UsageStore::open(&path).unwrap();
    store.set_pricer(Some(pricer(2)), Some("v1"));
    assert_eq!(store.summary(&QueryOptions::default()).unwrap().tokens, 115);
}
