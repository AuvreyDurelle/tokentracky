//! Codex forks and subagents open with copies of their parent's counters. Where the parent's rollout is on disk, a copy
//! is a counter whose running total the parent wrote, whatever its time: subagent rollouts can carry the fork's one
//! timestamp on every line, their own work included. Synthetic rollouts, named as Codex names them.
use ruzstd::encoding::{CompressionLevel, compress_to_vec};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokentracky_collector::store::{QueryOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::{ToolId, total_tokens};

const PARENT: &str = "019f4a3d-0000-7000-8000-000000000001";
const CHILD: &str = "019f4bbd-0000-7000-8000-000000000002";
/// The parent's running totals as (input, output); each request adds the difference.
const PARENT_TOTALS: [(u64, u64); 4] = [(100, 10), (300, 30), (600, 60), (1000, 100)];
/// The child's own requests, continuing from the parent's last total.
const CHILD_TOTALS: [(u64, u64); 3] = [(1100, 110), (1300, 130), (1600, 160)];
/// The parent's 1,100 tokens and the child's own 660.
const ALL: u64 = 1_760;

fn line(value: serde_json::Value) -> String {
    format!("{value}\n")
}
fn meta(at: &str, id: &str, parent: Option<serde_json::Value>) -> String {
    let mut payload = json!({"id": id, "cwd": "/synthetic/codex-project"});
    if let Some(parent) = parent {
        payload
            .as_object_mut()
            .unwrap()
            .extend(parent.as_object().unwrap().clone());
    }
    line(json!({"timestamp": at, "type": "session_meta", "payload": payload}))
        + &line(json!({
            "timestamp": at, "type": "turn_context",
            "payload": {"turn_id": "turn-1", "cwd": "/synthetic/codex-project", "model": "gpt-5-codex"}
        }))
}
/// Token counts running through `totals` from `from`, each at `at(index)`.
fn counts(totals: &[(u64, u64)], from: (u64, u64), at: impl Fn(usize) -> String) -> String {
    let usage = |(input, output): (u64, u64)| {
        json!({"input_tokens": input, "cached_input_tokens": 0, "output_tokens": output,
               "reasoning_output_tokens": 0, "total_tokens": input + output})
    };
    let mut previous = from;
    let mut text = String::new();
    for (index, &total) in totals.iter().enumerate() {
        let last = (total.0 - previous.0, total.1 - previous.1);
        text += &line(json!({
            "timestamp": at(index), "type": "event_msg",
            "payload": {"type": "token_count", "info": {"last_token_usage": usage(last), "total_token_usage": usage(total)}}
        }));
        previous = total;
    }
    text
}
fn parent() -> String {
    meta("2026-07-10T10:00:00.000Z", PARENT, None)
        + &counts(&PARENT_TOTALS, (0, 0), |index| {
            format!("2026-07-10T10:0{index}:30.000Z")
        })
}
/// A subagent spawned from the parent: every line at the fork's instant, its copies then its own requests.
fn child(names_parent: serde_json::Value) -> (String, String) {
    const FORKED: &str = "2026-07-10T11:15:25.782Z";
    let copies = meta(FORKED, CHILD, Some(names_parent)) + &counts(&PARENT_TOTALS, (0, 0), |_| FORKED.to_owned());
    (copies, counts(&CHILD_TOTALS, PARENT_TOTALS[3], |_| FORKED.to_owned()))
}
fn spawned() -> serde_json::Value {
    json!({"source": {"subagent": {"thread_spawn": {"parent_thread_id": PARENT}}}, "forked_from_id": PARENT})
}
fn rollout(id: &str) -> String {
    format!("rollout-2026-07-10T19-15-21-{id}.jsonl")
}

/// Codex homes authorized as separate folders, with their store.
struct Homes {
    _temporary: tempfile::TempDir,
    roots: Vec<PathBuf>,
    store: Arc<Mutex<UsageStore>>,
    service: IngestionService,
}
impl Homes {
    fn new(count: usize) -> Self {
        let temporary = tempfile::Builder::new().prefix("synthetic-").tempdir().unwrap();
        let directory = fs::canonicalize(temporary.path()).unwrap();
        let roots: Vec<PathBuf> = (0..count)
            .map(|index| directory.join(format!("codex-{index}")))
            .collect();
        for root in &roots {
            fs::create_dir_all(root.join("sessions")).unwrap();
        }
        let store = Arc::new(Mutex::new(UsageStore::open(directory.join("usage.sqlite")).unwrap()));
        let service = IngestionService::new(store.clone(), IngestionOptions::default()).unwrap();
        let paths = roots.iter().map(|root| root.to_string_lossy().into_owned()).collect();
        service
            .configure_source(ToolId::Codex, &SourceConfiguration { enabled: true, paths })
            .unwrap();
        Self {
            _temporary: temporary,
            roots,
            store,
            service,
        }
    }
    fn write(&self, root: usize, name: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.roots[root].join("sessions/2026/07/10").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }
    /// One scan: the tokens of every event counted.
    fn scan(&self) -> u64 {
        self.service.scan().unwrap();
        let events = self.store.lock().unwrap().events(&QueryOptions::default()).unwrap();
        events.iter().map(|event| total_tokens(&event.tokens)).sum()
    }
}
fn append(path: &Path, text: &str) {
    let mut content = fs::read_to_string(path).unwrap();
    content += text;
    fs::write(path, content).unwrap();
}

#[test]
fn a_subagent_working_at_the_fork_instant_counts_its_own_requests() {
    let homes = Homes::new(1);
    homes.write(0, &rollout(PARENT), parent());
    let (copies, own) = child(spawned());
    homes.write(0, &rollout(CHILD), copies + &own);
    assert_eq!(homes.scan(), ALL);
}

#[test]
fn the_parent_may_be_in_another_codex_folder_or_compressed() {
    let homes = Homes::new(2);
    homes.write(
        1,
        &format!("{}.zst", rollout(PARENT)),
        compress_to_vec(parent().as_bytes(), CompressionLevel::Fastest),
    );
    let (copies, own) = child(spawned());
    homes.write(0, &rollout(CHILD), copies + &own);
    assert_eq!(homes.scan(), ALL);
}

#[test]
fn a_fork_named_only_by_forked_from_id_finds_its_parent() {
    let homes = Homes::new(1);
    homes.write(0, &rollout(PARENT), parent());
    let (copies, own) = child(json!({"forked_from_id": PARENT}));
    homes.write(0, &rollout(CHILD), copies + &own);
    assert_eq!(homes.scan(), ALL);
}

#[test]
fn a_subagent_read_while_it_copies_still_finds_its_parent() {
    let homes = Homes::new(1);
    homes.write(0, &rollout(PARENT), parent());
    let (copies, own) = child(spawned());
    let path = homes.write(0, &rollout(CHILD), copies);
    assert_eq!(homes.scan(), 1_100);
    append(&path, &own);
    assert_eq!(homes.scan(), ALL);
}

#[test]
fn without_its_parent_on_disk_a_subagent_keeps_the_one_second_rule() {
    let homes = Homes::new(1);
    let (copies, own) = child(spawned());
    homes.write(0, &rollout(CHILD), copies + &own);
    // Every line at the fork's instant reads as a copy: nothing is counted.
    assert_eq!(homes.scan(), 0);
}

#[test]
fn requests_sharing_a_turn_and_an_instant_each_count() {
    let homes = Homes::new(1);
    let at = |_| "2026-07-10T10:00:30.000Z".to_owned();
    homes.write(
        0,
        &rollout(PARENT),
        meta("2026-07-10T10:00:00.000Z", PARENT, None) + &counts(&PARENT_TOTALS, (0, 0), at),
    );
    assert_eq!(homes.scan(), 1_100);
}
