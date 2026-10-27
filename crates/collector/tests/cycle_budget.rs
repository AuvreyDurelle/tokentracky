//! Cost of one refresh cycle on a synthetic heavy Claude Code history. Ignored by default; run in release mode:
//! `cargo test --release -p tokentracky-collector --test cycle_budget -- --ignored --nocapture`.
//! `TOKENTRACKY_BENCH_SESSIONS` × `TOKENTRACKY_BENCH_REQUESTS` scale it (default 200 × 1,000 = 200,000 requests).
//! Claude Code's `.claude.json` is 8 MiB of synthetic project state around its usage reading (F6).
use jiff::tz::TimeZone;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex};
use time::OffsetDateTime;
use tokentracky_collector::store::{PublicationOptions, SourceConfiguration, UsageStore};
use tokentracky_collector::{IngestionOptions, IngestionService};
use tokentracky_core::ToolId;

/// Process CPU time, user and system, in milliseconds.
fn cpu_ms() -> f64 {
    // SAFETY: getrusage only writes the struct it is given.
    let usage = unsafe {
        let mut usage = std::mem::zeroed::<libc::rusage>();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage
    };
    let ms = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    ms(usage.ru_utime) + ms(usage.ru_stime)
}
fn env(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}
/// One request as Claude Code logs it: a tool result, then one assistant line per content block with the same id.
fn request(out: &mut impl Write, session: &str, id: &str, day: usize) {
    let at = format!("2026-10-{day:02}T12:00:00.000Z");
    let filler = "x".repeat(400);
    writeln!(out, r#"{{"type":"user","sessionId":"{session}","cwd":"/synthetic/p","timestamp":"{at}","message":{{"content":"{filler}"}}}}"#).unwrap();
    for block in ["thinking", "tool_use"] {
        writeln!(out, r#"{{"type":"assistant","sessionId":"{session}","cwd":"/synthetic/p","timestamp":"{at}","requestId":"r{id}","message":{{"id":"{id}","model":"claude-opus-4-5","content":[{{"type":"{block}"}}],"usage":{{"input_tokens":3,"cache_creation_input_tokens":400,"cache_read_input_tokens":40000,"output_tokens":200}}}}}}"#).unwrap();
    }
}
/// A synthetic `.claude.json` of about `bytes`: per-project history around Claude Code's cached usage reading.
fn claude_config(bytes: usize, fetched_at_ms: u64) -> String {
    let project = format!(
        r#"{{"history":[{{"display":"{}"}}],"allowedTools":[]}}"#,
        "x".repeat(4000)
    );
    let projects: Vec<String> = (0..bytes / 4040)
        .map(|at| format!(r#""/synthetic/p{at}":{project}"#))
        .collect();
    format!(
        r#"{{"numStartups":1,"oauthAccount":{{"accountUuid":"synthetic"}},"projects":{{{}}},"cachedUsageUtilization":{{"fetchedAtMs":{fetched_at_ms},"accountUuid":"synthetic","utilization":{{"five_hour":{{"utilization":10,"resets_at":"2026-10-25T15:00:00Z"}}}}}}}}"#,
        projects.join(",")
    )
}
/// Prints and returns the CPU milliseconds `run` took.
fn measure(label: &str, run: impl FnOnce()) -> f64 {
    let (cpu, wall) = (cpu_ms(), std::time::Instant::now());
    run();
    let spent = cpu_ms() - cpu;
    println!(
        "{label:<26} cpu {spent:>9.1} ms   wall {:>9.1} ms",
        wall.elapsed().as_secs_f64() * 1000.0
    );
    spent
}

#[test]
#[ignore = "benchmark: writes a large synthetic history"]
fn cycle_budget() {
    let (sessions, requests) = (
        env("TOKENTRACKY_BENCH_SESSIONS", 200),
        env("TOKENTRACKY_BENCH_REQUESTS", 1000),
    );
    let temporary = tempfile::Builder::new().prefix("synthetic-").tempdir().unwrap();
    let directory = fs::canonicalize(temporary.path()).unwrap();
    let source = directory.join("projects");
    for s in 0..sessions {
        let folder = source.join(format!("-synthetic-p{}", s % 20));
        fs::create_dir_all(&folder).unwrap();
        let file = fs::File::create(folder.join(format!("{s:08x}-0000-4000-8000-000000000000.jsonl"))).unwrap();
        let mut out = BufWriter::new(file);
        for r in 0..requests {
            request(&mut out, &format!("s{s}"), &format!("m{s}_{r}"), 1 + r % 24);
        }
    }
    let config = directory.join(".claude.json");
    fs::write(&config, claude_config(8 << 20, 1_792_929_600_000)).unwrap();
    let store = Arc::new(Mutex::new(UsageStore::open(directory.join("usage.sqlite")).unwrap()));
    let options = IngestionOptions {
        claude_config_file: Some(config.clone()),
        ..IngestionOptions::default()
    };
    let service = IngestionService::new(store.clone(), options).unwrap();
    let paths = vec![source.to_string_lossy().into_owned()];
    service
        .configure_source(ToolId::Claude, &SourceConfiguration { enabled: true, paths })
        .unwrap();
    // A refresh cycle's reads besides the scan: source counts, the menu-bar totals (in the local zone) and, when usage
    // changed, the upload projection (the app skips the upload otherwise, P5 Task 3.3).
    let cycle = |changed: bool| {
        let result = service.scan().unwrap();
        assert!(
            !result.diagnostics.iter().any(|code| code == "file_read_failed"),
            "{:?}",
            result.diagnostics
        );
        let mut store = store.lock().unwrap();
        store.source_statuses().unwrap();
        store
            .period_totals(OffsetDateTime::now_utc(), Some(&TimeZone::system()))
            .unwrap();
        if changed {
            store
                .project_public_buckets(&PublicationOptions {
                    history_start: None,
                    share_tools: true,
                    share_cost: true,
                    share_models: false,
                })
                .unwrap();
        }
    };
    println!("{sessions} sessions × {requests} requests");
    measure("first import", || cycle(true));
    assert_eq!(store.lock().unwrap().limits().unwrap().len(), 1);
    let unchanged = measure("cycle, nothing changed", || cycle(false));
    // 50 ms every 5 minutes is 0.017% CPU, inside the 0.05% idle gate with the app's own idle cost.
    assert!(unchanged <= 50.0, "an unchanged cycle took {unchanged:.1} ms of CPU");
    // Claude Code rewrites its settings file as it runs, so an active cycle parses it again.
    fs::write(&config, claude_config(8 << 20, 1_792_929_900_000)).unwrap();
    let reread = measure("cycle, .claude.json changed", || cycle(false));
    assert!(reread <= 500.0, "re-reading .claude.json took {reread:.1} ms of CPU");
    assert_eq!(store.lock().unwrap().limits().unwrap()[0].as_of_ms, 1_792_929_900_000);
    let live = source.join("-synthetic-p0/00000000-0000-4000-8000-000000000000.jsonl");
    let mut out = OpenOptions::new().append(true).open(&live).unwrap();
    for r in 0..50 {
        request(&mut out, "s0", &format!("live{r}"), 24);
    }
    fs::write(&config, claude_config(8 << 20, 1_792_930_200_000)).unwrap();
    let grew = measure("cycle, one session grew", || cycle(true));
    assert!(grew <= 500.0, "an active cycle took {grew:.1} ms of CPU");
}
