//! What files cannot express about the store, ported case for case from `packages/collector/test/store.test.ts`:
//! receipts, source rows, the metadata boundary, rejected options, read-time pricing and read-only readers, plus
//! the commit and projection invariants the golden cases rely on. Input a Rust type cannot hold (a number where
//! text belongs, `undefined`) has no test here; the parser state is JSON, so its malformed shapes are all kept.
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::Path;
use time::OffsetDateTime;
use time::macros::datetime;
use tokentracky_collector::store::{
    FileCheckpoint, PricedCost, PublicationOptions, QueryOptions, SourceConfiguration, StoreError, UsageStore,
};
use tokentracky_core::{
    CostParts, MAX_SAFE_INTEGER, SourceState, TOOL_IDS, TokenCounts, ToolId, UsageEvent, total_tokens,
};

/// `digest('')`: the prefix hash of an empty file.
const EMPTY_DIGEST: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// One valid Claude Code record, from the golden fixtures.
/// A price made of input cost only.
fn input_cost(input: u64) -> CostParts {
    CostParts {
        input,
        ..CostParts::default()
    }
}
fn event() -> UsageEvent {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/claude/cache-categories-disjoint/expected/events.json");
    let events: Vec<UsageEvent> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    events[0].clone()
}
fn new_parser_state() -> Value {
    json!({"sessionId": null, "project": null, "model": "unknown", "turnId": null, "previous": null, "baselines": [], "seenDeltaIds": []})
}
fn checkpoint() -> FileCheckpoint {
    FileCheckpoint {
        path: "/authorized/session.jsonl".to_owned(),
        tool: ToolId::Claude,
        identity: "1:2".to_owned(),
        offset: 0,
        prefix_hash: EMPTY_DIGEST.to_owned(),
        parser_version: 1,
        state: new_parser_state(),
        diagnostics: Vec::new(),
        file_size: None,
        mtime_ms: None,
        ctime_ms: None,
    }
}
fn at(path: &str) -> FileCheckpoint {
    FileCheckpoint {
        path: path.to_owned(),
        ..checkpoint()
    }
}
fn store() -> UsageStore {
    UsageStore::open(":memory:").unwrap()
}
fn all() -> QueryOptions {
    QueryOptions::default()
}
fn private() -> PublicationOptions {
    PublicationOptions::default()
}
/// The error code, as the TypeScript store throws it.
fn code<T>(result: Result<T, StoreError>) -> String {
    result.err().expect("expected an error").to_string()
}
/// `value` padded with `x` to exactly `units` UTF-16 units (`padEnd`).
fn pad(value: &str, units: usize) -> String {
    value.to_owned() + &"x".repeat(units - value.encode_utf16().count())
}
fn with(event: &UsageEvent, field: &str, value: Value) -> UsageEvent {
    let mut json = serde_json::to_value(event).unwrap();
    json[field] = value;
    serde_json::from_value(json).unwrap()
}
const NOW: OffsetDateTime = datetime!(2026-10-23 12:00 UTC);

mod durable_publication_receipts {
    use super::*;

    #[test]
    fn freezes_pending_content_until_every_upload_is_acknowledged_and_scopes_it_to_the_target() {
        let mut store = store();
        store.commit_file(&checkpoint(), &[event()], true).unwrap();
        let first = store.pending_publication("target-a", &private()).unwrap();
        let more = UsageEvent {
            event_id: "new-event".to_owned(),
            ..event()
        };
        store.commit_file(&checkpoint(), &[event(), more], true).unwrap();
        assert_eq!(store.pending_publication("target-a", &private()).unwrap(), first);
        assert_eq!(
            code(store.acknowledge_publication("target-a", "another-receipt")),
            "publication_receipt_mismatch"
        );
        store.acknowledge_publication("target-a", &first.receipt).unwrap();
        let next = store.pending_publication("target-a", &private()).unwrap();
        assert_eq!(next.base_receipt.as_deref(), Some(first.receipt.as_str()));
        assert_ne!(next.receipt, first.receipt);
        assert_eq!(next.buckets[0].tokens, first.buckets[0].tokens * 2);
        assert_eq!(
            store
                .pending_publication("replacement-device", &private())
                .unwrap()
                .base_receipt,
            None
        );
        // The hosted API accepts only UUID receipts and collector ids.
        for id in [&first.receipt, &first.collector_id] {
            assert!(
                uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.get_version_num() == 4),
                "{id}"
            );
        }
    }
    #[test]
    fn keeps_the_pending_batch_across_a_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.sqlite");
        let mut owner = UsageStore::open(&path).unwrap();
        owner.commit_file(&checkpoint(), &[event()], true).unwrap();
        let pending = owner.pending_publication("target", &private()).unwrap();
        owner.close().unwrap();
        let mut reopened = UsageStore::open(&path).unwrap();
        assert_eq!(reopened.pending_publication("target", &private()).unwrap(), pending);
        assert_eq!(reopened.publication_state().unwrap().collector_id, pending.collector_id);
    }
    #[test]
    fn carries_tokens_per_utc_hour_and_tool_for_the_last_24_whole_hours_and_the_hour_under_way() {
        use jiff::{SignedDuration, Timestamp};
        use tokentracky_core::{BucketTool, PublicHour};
        // Each event sits clear of the window's edges, so the batch is the same if an hour ends while this runs.
        let hour = Timestamp::from_second(Timestamp::now().as_second().div_euclid(3600) * 3600).unwrap();
        let at = |minutes: i64| format!("{:.3}", hour + SignedDuration::from_mins(minutes));
        let usage = |id: &str, minutes: i64| UsageEvent {
            event_id: id.to_owned(),
            occurred_at: Some(at(minutes)),
            ..event()
        };
        let events = [
            usage("too-old", -25 * 60 + 5),
            usage("oldest-hour", -23 * 60 + 5),
            usage("last-hour-a", -60 + 5),
            usage("last-hour-b", -60 + 20),
            usage("under-way", 0),
        ];
        let mut store = store();
        store.commit_file(&checkpoint(), &events, true).unwrap();
        let options = PublicationOptions {
            share_tools: true,
            ..private()
        };
        let tokens = total_tokens(&event().tokens);
        let hours = |minutes: i64, tokens: u64| PublicHour {
            hour: at(minutes),
            tool: BucketTool::Tool(ToolId::Claude),
            tokens,
        };
        assert_eq!(
            store.pending_publication("target", &options).unwrap().hours,
            [hours(-23 * 60, tokens), hours(-60, tokens * 2), hours(0, tokens)]
        );
        // Without the tool split, every tool's hour is one `all` total, as the day buckets are.
        let all = store.pending_publication("other-target", &private()).unwrap().hours;
        assert!(
            all.iter().all(|hour| hour.tool == BucketTool::All) && all.len() == 3,
            "{all:?}"
        );
    }
}

mod source_statuses {
    use super::*;
    use tokentracky_core::TokenCounts;

    #[test]
    fn ordinary_history_counts_zero_corrections_and_copies_at_scale_without_lineage() {
        let mut store = store();
        let events: Vec<_> = (0..20_000)
            .map(|i| UsageEvent {
                event_id: format!("ordinary-{i}"),
                tokens: TokenCounts {
                    input: 1,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                    reasoning: None,
                    cache_write_1h: None,
                },
                ..event()
            })
            .collect();
        store.commit_file(&at("/ordinary.jsonl"), &events, true).unwrap();
        store.commit_file(&at("/copy.jsonl"), &events[..100], true).unwrap();
        let zero: Vec<_> = events[..50]
            .iter()
            .map(|event| UsageEvent {
                tokens: TokenCounts {
                    input: 0,
                    ..event.tokens.clone()
                },
                ..event.clone()
            })
            .collect();
        store.commit_file(&at("/ordinary.jsonl"), &zero, false).unwrap();
        assert_eq!(
            store
                .source_statuses()
                .unwrap()
                .iter()
                .find(|s| s.id == ToolId::Claude)
                .unwrap()
                .event_count,
            19_950
        );
        assert_eq!(store.events(&QueryOptions::default()).unwrap().len(), 19_950);
        store.ensure_publication_ready().unwrap();
    }

    #[test]
    fn counts_effective_deduplicated_events_by_tool() {
        let mut store = store();
        let original = event();
        store
            .commit_file(&at("/first.jsonl"), std::slice::from_ref(&original), true)
            .unwrap();
        store
            .commit_file(&at("/duplicate.jsonl"), std::slice::from_ref(&original), true)
            .unwrap();
        store
            .commit_file(
                &at("/other.jsonl"),
                &[UsageEvent {
                    event_id: "another-event".to_owned(),
                    ..original.clone()
                }],
                true,
            )
            .unwrap();
        let codex = UsageEvent {
            tool: ToolId::Codex,
            ..original
        };
        store
            .commit_file(
                &FileCheckpoint {
                    tool: ToolId::Codex,
                    ..at("/codex.jsonl")
                },
                &[codex],
                true,
            )
            .unwrap();
        let statuses = store.source_statuses().unwrap();
        let count = |tool| statuses.iter().find(|status| status.id == tool).unwrap().event_count;
        assert_eq!((count(ToolId::Claude), count(ToolId::Codex)), (1, 1));
    }
    #[test]
    fn publishes_the_same_capabilities_as_the_readme_matrix_for_every_tool() {
        let readme = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../README.md")).unwrap();
        let rows: Vec<Vec<&str>> = readme
            .lines()
            .filter(|line| line.starts_with("| "))
            .map(|line| line.split('|').map(str::trim).collect::<Vec<_>>())
            .map(|cells| cells[1..cells.len() - 1].to_vec())
            .collect();
        let statuses = store().source_statuses().unwrap();
        let mut ids: Vec<ToolId> = statuses.iter().map(|status| status.id).collect();
        ids.sort();
        let mut tools = TOOL_IDS.to_vec();
        tools.sort();
        assert_eq!(ids, tools);
        for status in statuses {
            let row = rows
                .iter()
                .find(|row| row[0] == status.name)
                .unwrap_or_else(|| panic!("{}", status.name));
            let c = status.capabilities;
            let words: Vec<&str> = [c.tokens, c.models, c.projects, c.costs, c.quotas]
                .map(|on| if on { "Yes" } else { "No" })
                .to_vec();
            assert_eq!(row[2..], words[..], "{}", status.name);
            let state = if c.tokens {
                SourceState::PermissionRequired
            } else {
                SourceState::Unsupported
            };
            assert_eq!(status.state, state, "{}", status.name);
        }
    }
    #[test]
    fn adds_a_source_row_for_each_new_tool_to_an_existing_database_without_touching_configured_sources() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.sqlite");
        let configured = SourceConfiguration {
            enabled: true,
            paths: vec!["/authorized".to_owned()],
        };
        let mut owner = UsageStore::open(&path).unwrap();
        owner.save_source_configuration(ToolId::Claude, &configured).unwrap();
        owner.close().unwrap();
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch("DELETE FROM sources WHERE tool NOT IN ('claude','codex','cursor','gemini')")
            .unwrap();
        raw.close().unwrap();
        let reopened = UsageStore::open(&path).unwrap();
        assert_eq!(reopened.source_statuses().unwrap().len(), TOOL_IDS.len());
        assert_eq!(reopened.get_source_configuration(ToolId::Claude).unwrap(), configured);
    }
    #[test]
    fn asks_for_permission_again_when_an_earlier_unsupported_gemini_source_is_upgraded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("upgraded.sqlite");
        UsageStore::open(&path).unwrap().close().unwrap();
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch(
            r#"UPDATE sources SET enabled=1,paths='["/old/unverified"]',state='unsupported' WHERE tool='gemini'"#,
        )
        .unwrap();
        raw.close().unwrap();
        let upgraded = UsageStore::open(&path).unwrap();
        assert_eq!(
            upgraded.get_source_configuration(ToolId::Gemini).unwrap(),
            SourceConfiguration::default()
        );
        let gemini = upgraded
            .source_statuses()
            .unwrap()
            .into_iter()
            .find(|source| source.id == ToolId::Gemini)
            .unwrap();
        assert_eq!(gemini.state, SourceState::PermissionRequired);
        assert!(gemini.capabilities.tokens && gemini.capabilities.models && !gemini.capabilities.projects);
    }
    #[test]
    fn saves_configuration_and_state_and_rejects_empty_or_nul_paths() {
        let mut store = store();
        for paths in [vec![String::new()], vec!["/bad\0path".to_owned()]] {
            let configuration = SourceConfiguration { enabled: true, paths };
            assert_eq!(
                code(store.save_source_configuration(ToolId::Claude, &configuration)),
                "invalid_source_configuration"
            );
        }
        let paused = SourceConfiguration {
            enabled: false,
            paths: vec!["/authorized".to_owned()],
        };
        store.save_source_configuration(ToolId::Codex, &paused).unwrap();
        store.save_source_configuration(ToolId::Cursor, &paused).unwrap();
        store
            .set_source_state(
                ToolId::Claude,
                SourceState::Current,
                "Authorized logs are current.",
                Some("2026-10-23T12:00:00.000Z"),
            )
            .unwrap();
        store
            .set_source_state(
                ToolId::Claude,
                SourceState::Error,
                "Some authorized logs could not be read.",
                None,
            )
            .unwrap();
        let statuses = store.source_statuses().unwrap();
        let status = |tool| statuses.iter().find(|status| status.id == tool).unwrap();
        assert_eq!(
            (status(ToolId::Codex).state, status(ToolId::Codex).message.as_str()),
            (SourceState::Paused, "Source paused.")
        );
        assert_eq!(status(ToolId::Cursor).state, SourceState::Unsupported);
        assert_eq!(status(ToolId::Claude).state, SourceState::Error);
        assert_eq!(
            status(ToolId::Claude).last_imported_at.as_deref(),
            Some("2026-10-23T12:00:00.000Z")
        );
        assert_eq!(store.last_scan_at().unwrap(), None);
        store.set_last_scan_at("2026-10-23T12:00:00.000Z").unwrap();
        assert_eq!(
            store.last_scan_at().unwrap().as_deref(),
            Some("2026-10-23T12:00:00.000Z")
        );
    }
}

mod commit_file_metadata_boundary {
    use super::*;

    /// Invalid text a Rust string can hold, for a field limited to `limit` UTF-16 units.
    fn invalid_text(limit: usize) -> Vec<Value> {
        [
            "",
            &"x".repeat(limit + 1),
            "bad\0value",
            "bad\nvalue",
            "bad\tvalue",
            "bad\u{1f}value",
        ]
        .map(Value::from)
        .to_vec()
    }
    fn unchanged(store: &UsageStore, saved: &FileCheckpoint, events: &[UsageEvent]) {
        assert_eq!(store.export_data(&all()).unwrap(), events);
        assert_eq!(store.checkpoint(&saved.path, None).unwrap().as_ref(), Some(saved));
    }

    #[test]
    fn rejects_invalid_event_text_before_replacing_persisted_data() {
        for (field, limit) in [
            ("eventId", 4096),
            ("sessionId", 512),
            ("model", 256),
            ("project", 4096),
            ("pricingVersion", 4096),
        ] {
            for value in invalid_text(limit) {
                let mut store = store();
                let (original, saved) = (event(), checkpoint());
                store
                    .commit_file(&saved, std::slice::from_ref(&original), true)
                    .unwrap();
                let mut changed = original.clone();
                changed.tokens.input = 1;
                let invalid = with(&original, field, value.clone());
                let result = store.commit_file(
                    &FileCheckpoint {
                        offset: 20,
                        ..saved.clone()
                    },
                    &[changed, invalid],
                    true,
                );
                assert_eq!(code(result), "invalid_usage_event", "{field} {value}");
                unchanged(&store, &saved, &[original]);
            }
        }
    }
    #[test]
    fn rejects_invalid_timestamp_metadata() {
        for value in [
            "invalid",
            "2026-10-20T12:00:00Z\n",
            "2026-13-01T00:00:00Z",
            "20 Oct 2026",
        ] {
            let mut store = store();
            let invalid = with(&event(), "occurredAt", json!(value));
            assert_eq!(
                code(store.commit_file(&checkpoint(), &[invalid], true)),
                "invalid_usage_event",
                "{value}"
            );
            assert_eq!(store.checkpoint(&checkpoint().path, None).unwrap(), None);
        }
    }
    #[test]
    fn rejects_empty_or_unbounded_service_tiers() {
        for value in [json!(""), json!("x".repeat(33)), json!("bad\ntier")] {
            let mut store = store();
            let invalid = with(&event(), "serviceTier", value.clone());
            assert_eq!(
                code(store.commit_file(&checkpoint(), &[invalid], true)),
                "invalid_usage_event",
                "{value}"
            );
        }
    }
    #[test]
    fn rejects_unsafe_and_inconsistent_counters() {
        let unsafe_count = MAX_SAFE_INTEGER + 1;
        let mut store = store();
        let mut cases = Vec::new();
        for edit in [
            (|e: &mut UsageEvent, n| e.cost_microusd = Some(n)) as fn(&mut UsageEvent, u64),
            |e, n| e.tokens.reasoning = Some(n),
            |e, n| e.tokens.input = n,
        ] {
            let mut invalid = event();
            edit(&mut invalid, unsafe_count);
            cases.push((invalid, "invalid_usage_event"));
        }
        let mut above = event();
        above.tokens.reasoning = Some(above.tokens.output + 1);
        cases.push((above, "invalid_usage_event"));
        // Each counter is safe, their total is not.
        let mut overflow = event();
        (overflow.tokens.input, overflow.tokens.output) = (MAX_SAFE_INTEGER, 1);
        cases.push((overflow, "aggregate_counter_overflow"));
        for (invalid, expected) in cases {
            assert_eq!(code(store.commit_file(&checkpoint(), &[invalid], true)), expected);
        }
        assert_eq!(store.checkpoint(&checkpoint().path, None).unwrap(), None);
    }
    #[test]
    fn rejects_invalid_checkpoint_state_text_without_changing_events_or_checkpoint() {
        for (field, limit) in [("sessionId", 512), ("project", 4096), ("model", 256), ("turnId", 512)] {
            let mut values = invalid_text(limit);
            values.extend([json!(123), json!({}), json!(["metadata"])]);
            if field == "model" {
                values.push(Value::Null);
            }
            for value in values.into_iter().map(Some).chain([None]) {
                let mut store = store();
                let saved = checkpoint();
                store.commit_file(&saved, &[event()], true).unwrap();
                let mut invalid = FileCheckpoint {
                    offset: 20,
                    ..saved.clone()
                };
                match &value {
                    Some(value) => invalid.state[field] = value.clone(),
                    None => drop(invalid.state.as_object_mut().unwrap().remove(field)),
                }
                assert_eq!(
                    code(store.commit_file(&invalid, &[], true)),
                    "invalid_checkpoint",
                    "{field} {value:?}"
                );
                unchanged(&store, &saved, &[event()]);
            }
        }
    }
    #[test]
    fn rejects_malformed_or_unbounded_parser_state() {
        let counts = json!({"input": 1, "cached": 0, "write": 0, "output": 1, "reasoning": 0});
        for (field, value) in [
            ("previous", None),
            ("previous", Some(json!({"content": "unexpected"}))),
            (
                "previous",
                Some(json!({"input": -1, "cached": 0, "write": 0, "output": 1, "reasoning": 0})),
            ),
            ("baselines", Some(json!({}))),
            ("baselines", Some(json!([null]))),
            ("baselines", Some(json!(vec![counts.clone(); 65]))),
            ("seenDeltaIds", Some(json!({}))),
            ("seenDeltaIds", Some(json!([{}]))),
            ("seenDeltaIds", Some(json!(["bad\ridentity"]))),
            ("seenDeltaIds", Some(json!(["x".repeat(4097)]))),
            ("seenDeltaIds", Some(json!([null]))),
            ("seenDeltaIds", Some(json!(vec!["id"; 257]))),
            ("serviceTier", Some(json!("x".repeat(33)))),
            ("serviceTier", Some(Value::Null)),
            ("serviceTier", Some(json!(1))),
        ] {
            let mut store = store();
            let mut invalid = checkpoint();
            match &value {
                Some(value) => invalid.state[field] = value.clone(),
                None => drop(invalid.state.as_object_mut().unwrap().remove(field)),
            }
            assert_eq!(
                code(store.commit_file(&invalid, &[], true)),
                "invalid_checkpoint",
                "{field} {value:?}"
            );
            assert_eq!(store.checkpoint(&invalid.path, None).unwrap(), None);
        }
        let mut store = store();
        let not_an_object = FileCheckpoint {
            state: json!("state"),
            ..checkpoint()
        };
        assert_eq!(code(store.commit_file(&not_an_object, &[], true)), "invalid_checkpoint");
    }
    #[test]
    fn rejects_invalid_checkpoint_scalars() {
        let unsafe_count = MAX_SAFE_INTEGER + 1;
        for invalid in [
            FileCheckpoint {
                prefix_hash: EMPTY_DIGEST.to_uppercase(),
                ..checkpoint()
            },
            FileCheckpoint {
                prefix_hash: EMPTY_DIGEST[1..].to_owned(),
                ..checkpoint()
            },
            FileCheckpoint {
                path: String::new(),
                ..checkpoint()
            },
            FileCheckpoint {
                identity: String::new(),
                ..checkpoint()
            },
            FileCheckpoint {
                offset: unsafe_count,
                ..checkpoint()
            },
            FileCheckpoint {
                parser_version: -(unsafe_count as i64),
                ..checkpoint()
            },
            FileCheckpoint {
                file_size: Some(unsafe_count),
                ..checkpoint()
            },
            FileCheckpoint {
                file_size: Some(1),
                mtime_ms: Some(f64::INFINITY),
                ..checkpoint()
            },
            FileCheckpoint {
                file_size: Some(1),
                ctime_ms: Some(f64::NAN),
                ..checkpoint()
            },
        ] {
            let mut store = store();
            assert_eq!(
                code(store.commit_file(&invalid, &[], true)),
                "invalid_checkpoint",
                "{invalid:?}"
            );
            assert_eq!(store.checkpoint(&checkpoint().path, None).unwrap(), None);
        }
    }
    #[test]
    fn filters_diagnostic_values_to_codes() {
        let mut store = store();
        let diagnostics = ["malformed_json", "invalid message", "Untrusted_code", ""]
            .map(str::to_owned)
            .to_vec();
        store
            .commit_file(
                &FileCheckpoint {
                    diagnostics,
                    ..checkpoint()
                },
                &[],
                true,
            )
            .unwrap();
        assert_eq!(
            store.checkpoint(&checkpoint().path, None).unwrap().unwrap().diagnostics,
            ["malformed_json"]
        );
    }
    #[test]
    fn preserves_valid_metadata_at_the_limits_without_imposing_an_identifier_format() {
        let id = pad("Session /路径 :@+=\"quoted\" ", 512);
        let model = pad("local model /版本:@+=", 256);
        let project = pad("/local project/路径 ", 4096);
        let valid = UsageEvent {
            event_id: pad("event:", 4096),
            session_id: id.clone(),
            model: model.clone(),
            project: Some(project.clone()),
            pricing_version: Some(pad("price:", 4096)),
            service_tier: Some("priority".to_owned()),
            ..event()
        };
        let counts = json!({"input": 1, "cached": 0, "write": 0, "output": 1, "reasoning": 0});
        let state = json!({"sessionId": id, "model": model, "project": project, "turnId": id, "previous": counts,
            "baselines": vec![counts.clone(); 64], "seenDeltaIds": vec![id.clone(); 256], "serviceTier": "priority"});
        let saved = FileCheckpoint {
            state: state.clone(),
            ..checkpoint()
        };
        let mut store = store();
        store.commit_file(&saved, std::slice::from_ref(&valid), true).unwrap();
        assert_eq!(store.export_data(&all()).unwrap(), [valid]);
        assert_eq!(store.checkpoint(&saved.path, None).unwrap().unwrap().state, state);
    }
    #[test]
    fn retains_explicit_field_allowlists_in_parser_state() {
        let counts = json!({"input": 1, "cached": 0, "write": 0, "output": 1, "reasoning": 0});
        let extra = json!({"input": 1, "cached": 0, "write": 0, "output": 1, "reasoning": 0, "unexpected": {"content": "EXCLUDED_CONTENT"}});
        let mut saved = checkpoint();
        saved.state["unexpected"] = json!({"content": "EXCLUDED_CONTENT"});
        saved.state["previous"] = extra.clone();
        saved.state["baselines"] = json!([extra]);
        let mut store = store();
        store.commit_file(&saved, &[event()], true).unwrap();
        let mut state = new_parser_state();
        state["previous"] = counts.clone();
        state["baselines"] = json!([counts]);
        assert_eq!(
            store.checkpoint(&saved.path, None).unwrap(),
            Some(FileCheckpoint { state, ..checkpoint() })
        );
        assert_eq!(store.export_data(&all()).unwrap(), [event()]);
    }
    #[test]
    fn keeps_only_the_bounded_figures_of_a_codex_rate_limit_snapshot() {
        let mut saved = checkpoint();
        saved.state["rateLimits"] = json!({"atMs": 1_792_490_640_000_i64, "limitName": "PRIVATE_LIMIT",
            "primary": {"usedPercent": 20.5, "windowMinutes": 300, "resetsAtMs": 1_792_504_800_000_i64, "planType": "PRIVATE_PLAN"},
            "secondary": {"usedPercent": 100}});
        let mut store = store();
        store.commit_file(&saved, &[], true).unwrap();
        let mut state = new_parser_state();
        state["rateLimits"] = json!({"atMs": 1_792_490_640_000_i64,
            "primary": {"usedPercent": 20.5, "windowMinutes": 300, "resetsAtMs": 1_792_504_800_000_i64},
            "secondary": {"usedPercent": 100.0}});
        assert_eq!(store.checkpoint(&saved.path, None).unwrap().unwrap().state, state);
    }
    #[test]
    fn rejects_a_malformed_or_unbounded_rate_limit_snapshot() {
        let window = |field: &str, value: Value| {
            let mut window = json!({"usedPercent": 1, "windowMinutes": 300, "resetsAtMs": 1});
            window[field] = value;
            json!({"atMs": 1, "primary": window})
        };
        let mut invalid = vec![
            json!("snapshot"),
            json!({"primary": {"usedPercent": 1}}),
            json!({"atMs": 0}),
            json!({"atMs": 8_640_000_000_000_001_i64}),
            json!({"atMs": 1.5}),
            json!({"atMs": 1, "secondary": null}),
        ];
        for (field, values) in [
            ("usedPercent", vec![json!(-0.5), json!(100.5), json!("1"), Value::Null]),
            (
                "windowMinutes",
                vec![json!(0), json!(-300), json!(1.5), json!(MAX_SAFE_INTEGER + 1)],
            ),
            (
                "resetsAtMs",
                vec![json!(0), json!(8_640_000_000_000_001_i64), json!("soon")],
            ),
        ] {
            invalid.extend(values.into_iter().map(|value| window(field, value)));
        }
        for limits in invalid {
            let mut checkpoint = checkpoint();
            checkpoint.state["rateLimits"] = limits.clone();
            let mut store = store();
            assert_eq!(
                code(store.commit_file(&checkpoint, &[], true)),
                "invalid_checkpoint",
                "{limits}"
            );
            assert_eq!(store.checkpoint(&checkpoint.path, None).unwrap(), None);
        }
    }
    #[test]
    fn keeps_file_times_only_beside_a_size() {
        let mut store = store();
        let timed = FileCheckpoint {
            mtime_ms: Some(1.5),
            ctime_ms: Some(2.5),
            ..checkpoint()
        };
        store.commit_file(&timed, &[], true).unwrap();
        let saved = store.checkpoint(&timed.path, Some(ToolId::Claude)).unwrap().unwrap();
        assert_eq!((saved.mtime_ms, saved.ctime_ms), (None, None));
        let sized = FileCheckpoint {
            file_size: Some(10),
            ..timed
        };
        store.commit_file(&sized, &[], true).unwrap();
        assert_eq!(
            store.checkpoint(&sized.path, Some(ToolId::Claude)).unwrap(),
            Some(sized)
        );
    }
    #[test]
    fn rejects_an_event_of_another_tool() {
        let mut store = store();
        let codex = UsageEvent {
            tool: ToolId::Codex,
            ..event()
        };
        assert_eq!(
            code(store.commit_file(&checkpoint(), &[codex], true)),
            "checkpoint_tool_mismatch"
        );
        assert_eq!(store.checkpoint(&checkpoint().path, None).unwrap(), None);
    }
}

mod commit_boundary {
    use super::*;

    #[test]
    fn replaces_or_merges_a_files_events_and_forgets_a_file() {
        let mut store = store();
        let second = UsageEvent {
            event_id: "second".to_owned(),
            ..event()
        };
        store
            .commit_file(&checkpoint(), &[event(), second.clone()], true)
            .unwrap();
        store.commit_file(&checkpoint(), &[event()], false).unwrap();
        assert_eq!(
            store.export_data(&all()).unwrap().len(),
            2,
            "a merge keeps what it does not mention"
        );
        store
            .commit_file(&checkpoint(), std::slice::from_ref(&second), true)
            .unwrap();
        assert_eq!(
            store.export_data(&all()).unwrap(),
            [second],
            "a replacement drops what it lost"
        );
        store.forget_file(&checkpoint().path, ToolId::Claude).unwrap();
        assert_eq!(store.export_data(&all()).unwrap(), []);
        assert_eq!(store.checkpoint(&checkpoint().path, None).unwrap(), None);
    }
    #[test]
    fn a_second_copy_of_a_record_cannot_supersede_its_correction() {
        let mut store = store();
        let original = event();
        let mut corrected = original.clone();
        corrected.tokens.output -= 10;
        store
            .commit_file(&at("/a.jsonl"), std::slice::from_ref(&original), true)
            .unwrap();
        store
            .commit_file(&at("/b.jsonl"), std::slice::from_ref(&original), true)
            .unwrap();
        assert_eq!(
            store.publication_state().unwrap().checkpoint,
            1,
            "an identical copy reuses the revision"
        );
        store.commit_file(&at("/a.jsonl"), &[corrected.clone()], true).unwrap();
        store
            .commit_file(&at("/b.jsonl"), std::slice::from_ref(&original), false)
            .unwrap();
        store
            .commit_file(&at("/c.jsonl"), std::slice::from_ref(&original), true)
            .unwrap();
        assert_eq!(store.export_data(&all()).unwrap(), [corrected]);
        assert_eq!(store.publication_state().unwrap().checkpoint, 2);
    }
    #[test]
    fn keeps_the_last_copy_of_a_repeated_event_id_in_one_commit() {
        let mut store = store();
        let mut later = event();
        later.tokens.input = 1;
        store
            .commit_file(&checkpoint(), &[event(), later.clone()], true)
            .unwrap();
        assert_eq!(store.export_data(&all()).unwrap(), [later]);
    }
}

mod publication_options {
    use super::*;

    // Non-boolean sharing options cannot be expressed in `PublicationOptions`; only history starts are checked.
    #[test]
    fn rejects_invalid_history_starts() {
        let mut store = store();
        store.commit_file(&checkpoint(), &[event()], true).unwrap();
        for start in ["2026-02-30", "2026-1-1", "yesterday"] {
            let options = PublicationOptions {
                history_start: Some(start.to_owned()),
                ..private()
            };
            assert_eq!(
                code(store.project_public_buckets(&options)),
                "invalid_history_start",
                "{start}"
            );
        }
    }
    #[test]
    fn revises_a_bucket_exactly_when_it_changes_and_keeps_a_zero_tombstone_for_a_removed_one() {
        let mut store = store();
        let shared = PublicationOptions {
            share_tools: true,
            share_cost: true,
            ..private()
        };
        let undated = UsageEvent {
            event_id: "undated".to_owned(),
            occurred_at: None,
            ..event()
        };
        store
            .commit_file(&checkpoint(), &[event(), undated.clone()], true)
            .unwrap();
        let first = store.project_public_buckets(&shared).unwrap();
        // `localeCompare` puts the undated bucket (key `:claude:`) before the dated one.
        assert_eq!(
            first.iter().map(|bucket| bucket.day.as_deref()).collect::<Vec<_>>(),
            [None, Some("2026-10-20")]
        );
        assert_eq!(
            store.project_public_buckets(&shared).unwrap(),
            first,
            "nothing changed, so nothing is revised"
        );
        store.commit_file(&checkpoint(), &[undated], true).unwrap();
        let second = store.project_public_buckets(&shared).unwrap();
        assert_eq!(second[0], first[0]);
        assert_eq!((second[1].tokens, second[1].cost_microusd), (0, None));
        assert_eq!(
            second[1].breakdown,
            Some(TokenCounts {
                reasoning: Some(0),
                ..TokenCounts::default()
            }),
            "a tombstone's kinds are zero too"
        );
        assert!(second[1].revision > first[1].revision);
        store.set_pricer(
            Some(Box::new(|_: &UsageEvent| {
                Some(PricedCost {
                    cost_microusd: 7,
                    parts: input_cost(7),
                    pricing_version: "v1".to_owned(),
                })
            })),
            Some("v1"),
        );
        let priced = store.project_public_buckets(&shared).unwrap();
        assert_eq!(
            (priced[0].cost_microusd, priced[1].revision),
            (Some(7), second[1].revision)
        );
        assert!(priced[0].revision > second[1].revision);
        let serialized = serde_json::to_value(&priced[0]).unwrap();
        let mut keys: Vec<&String> = serialized.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["breakdown", "costMicrousd", "day", "revision", "tokens", "tool"]);
        // Every kind, with reasoning; the one-hour cache-write part stays local.
        assert_eq!(
            serialized["breakdown"],
            json!({"input": 11, "output": 20, "cacheRead": 100, "cacheWrite": 30, "reasoning": 7})
        );
    }
    #[test]
    fn revises_a_bucket_whose_kinds_change_and_every_bucket_once_after_an_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.sqlite");
        let mut store = UsageStore::open(&path).unwrap();
        store.commit_file(&checkpoint(), &[event()], true).unwrap();
        let first = store.project_public_buckets(&private()).unwrap();
        let mut moved = event();
        moved.tokens.input -= 1;
        moved.tokens.output += 1;
        store.commit_file(&checkpoint(), &[moved], true).unwrap();
        let second = store.project_public_buckets(&private()).unwrap();
        assert_eq!(second[0].tokens, first[0].tokens, "the same total");
        assert!(second[0].revision > first[0].revision, "kinds alone revise a bucket");
        // A store from before kinds were kept: the column is added on open and holds nothing yet.
        store.close().unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE public_buckets DROP COLUMN kinds")
            .unwrap();
        let mut store = UsageStore::open(&path).unwrap();
        let upgraded = store.project_public_buckets(&private()).unwrap();
        assert_eq!(
            (upgraded[0].tokens, &upgraded[0].breakdown),
            (second[0].tokens, &second[0].breakdown)
        );
        assert!(
            upgraded[0].revision > second[0].revision,
            "re-uploaded once, with kinds"
        );
        assert_eq!(store.project_public_buckets(&private()).unwrap(), upgraded);
    }
}

mod usage_epoch {
    use super::*;

    #[test]
    fn advances_only_when_usage_changes_and_cached_reads_follow_it() {
        let mut store = store();
        let now = datetime!(2026-10-23 12:00 UTC);
        store.commit_file(&checkpoint(), &[event()], false).unwrap();
        let (epoch, first) = (store.usage_epoch(), store.period_totals(now, None).unwrap());
        let counts = |store: &UsageStore| {
            store
                .source_statuses()
                .unwrap()
                .iter()
                .map(|s| s.event_count)
                .sum::<u64>()
        };
        assert_eq!(counts(&store), 1);
        // The same checkpoint and events again: nothing is written.
        store.commit_file(&checkpoint(), &[event()], false).unwrap();
        assert_eq!(store.usage_epoch(), epoch);
        assert_eq!(store.period_totals(now, None).unwrap(), first);
        let more = UsageEvent {
            event_id: "second".to_owned(),
            ..event()
        };
        store
            .commit_file(&checkpoint(), &[event(), more.clone()], false)
            .unwrap();
        assert!(store.usage_epoch() > epoch);
        assert_eq!(
            store.period_totals(now, None).unwrap().all_time,
            first.all_time + total_tokens(&more.tokens)
        );
        assert_eq!(counts(&store), 2);
        let before = store.usage_epoch();
        store.forget_file(&checkpoint().path, ToolId::Claude).unwrap();
        assert!(store.usage_epoch() > before);
        assert_eq!(
            (store.period_totals(now, None).unwrap().all_time, counts(&store)),
            (0, 0)
        );
    }
}

mod read_time_pricing {
    use super::*;

    #[test]
    fn falls_back_to_a_source_reported_cost_when_the_table_has_no_price() {
        let mut store = store();
        let reported = UsageEvent {
            event_id: "reported".to_owned(),
            session_id: "reported".to_owned(),
            cost_microusd: Some(42),
            pricing_version: Some("source".to_owned()),
            ..event()
        };
        store.commit_file(&checkpoint(), &[event(), reported], true).unwrap();
        store.set_pricer(
            Some(Box::new(|item: &UsageEvent| {
                (item.event_id != "reported").then(|| PricedCost {
                    cost_microusd: 1,
                    parts: input_cost(1),
                    pricing_version: "v1".to_owned(),
                })
            })),
            Some("v1"),
        );
        let sessions = store.sessions(&all()).unwrap();
        assert_eq!(
            sessions
                .iter()
                .find(|item| item.id == "reported")
                .unwrap()
                .cost_microusd,
            Some(42)
        );
        assert_eq!(store.summary(&all()).unwrap().cost_microusd, Some(43));
        // A reported cost has no split by kind, so the summary has none either.
        assert_eq!(store.summary(&all()).unwrap().cost_parts, None);
    }
}

mod queries {
    use super::*;

    #[test]
    fn rejects_invalid_days_and_ranges() {
        let store = store();
        for days in [0, -1, MAX_SAFE_INTEGER as i64 + 1] {
            assert_eq!(
                code(store.events(&QueryOptions {
                    days: Some(days),
                    ..all()
                })),
                "invalid_query_days"
            );
        }
        let day = |value: &str| Some(value.to_owned());
        for (from, to) in [
            (day("2026-02-30"), None),
            (None, day("today")),
            (day("2026-10-23"), day("2026-10-22")),
        ] {
            assert_eq!(
                code(store.summary(&QueryOptions { from, to, ..all() })),
                "invalid_query_range"
            );
        }
    }
    // `ingestion.test.ts` at 2e2a1d3: two events this week, one undated and one from January.
    #[test]
    fn shifts_a_rolling_window_back_by_offset_days() {
        let mut store = store();
        let second = UsageEvent {
            event_id: "second".to_owned(),
            ..event()
        };
        let undated = UsageEvent {
            event_id: "undated".to_owned(),
            occurred_at: None,
            ..event()
        };
        let old = UsageEvent {
            event_id: "old".to_owned(),
            occurred_at: Some("2026-01-01T12:00:00.000Z".to_owned()),
            ..event()
        };
        store
            .commit_file(&checkpoint(), &[event(), second, undated, old], true)
            .unwrap();
        let week = |offset, now| QueryOptions {
            days: Some(7),
            offset,
            now: Some(now),
            ..all()
        };
        assert_eq!(store.summary(&week(None, NOW)).unwrap().tokens, 322);
        assert_eq!(store.summary(&week(Some(7), NOW)).unwrap().tokens, 0);
        let later = datetime!(2026-10-30 12:00 UTC);
        assert_eq!(store.summary(&week(Some(7), later)).unwrap().tokens, 322);
        assert_eq!(
            code(store.summary(&QueryOptions {
                days: Some(7),
                offset: Some(-1),
                ..all()
            })),
            "invalid_query_offset"
        );
        assert_eq!(
            code(store.summary(&QueryOptions {
                offset: Some(7),
                ..all()
            })),
            "invalid_query_offset",
            "an offset shifts a rolling window, so it needs days"
        );
    }
    #[test]
    fn an_exact_window_keeps_events_from_since_up_to_until() {
        let mut store = store();
        let at = |id: &str, occurred: &str| UsageEvent {
            event_id: id.to_owned(),
            occurred_at: Some(occurred.to_owned()),
            ..event()
        };
        let events = [
            at("before", "2026-10-20T09:59:59.999Z"),
            at("first", "2026-10-20T10:00:00.000Z"),
            at("last", "2026-10-20T10:59:59.999Z"),
            at("after", "2026-10-20T11:00:00.000Z"),
        ];
        store.commit_file(&checkpoint(), &events, true).unwrap();
        // 10:00 to 11:00 UTC on the 20th.
        let hour = QueryOptions {
            since: Some(1_792_490_400_000),
            until: Some(1_792_494_000_000),
            ..all()
        };
        assert_eq!(store.summary(&hour).unwrap().tokens, 322);
        let ids: Vec<String> = store
            .events(&hour)
            .unwrap()
            .into_iter()
            .map(|event| event.event_id)
            .collect();
        assert_eq!(ids, ["first", "last"]);
        let rows = store.breakdown(&hour).unwrap();
        assert_eq!(rows.iter().map(|row| row.tokens).sum::<u64>(), 322);
        assert_eq!(
            code(store.summary(&QueryOptions {
                since: hour.until,
                until: hour.since,
                ..all()
            })),
            "invalid_query_range"
        );
    }
    #[test]
    fn hours_count_from_since_by_tool_and_model() {
        let mut store = store();
        let at = |id: &str, occurred: &str, model: &str| UsageEvent {
            event_id: id.to_owned(),
            occurred_at: Some(occurred.to_owned()),
            model: model.to_owned(),
            ..event()
        };
        let sonnet = "claude-sonnet-4-6";
        let events = [
            at("early", "2026-10-20T09:29:59.999Z", sonnet),
            at("first", "2026-10-20T09:30:00.000Z", sonnet),
            at("second", "2026-10-20T10:29:59.999Z", sonnet),
            at("opus", "2026-10-20T10:30:00.000Z", "claude-opus-4-1"),
            at("third", "2026-10-20T10:45:00.000Z", sonnet),
            at("last", "2026-10-20T12:29:59.999Z", sonnet),
            at("late", "2026-10-20T12:30:00.000Z", sonnet),
        ];
        store.commit_file(&checkpoint(), &events, true).unwrap();
        // 09:30 to 12:30 UTC: three hours on the half hour, as in India, where 09:30 UTC is 15:00.
        let window = QueryOptions {
            since: Some(1_792_488_600_000),
            until: Some(1_792_499_400_000),
            ..all()
        };
        let rows: Vec<(String, String, u64)> = store
            .hours(&window)
            .unwrap()
            .into_iter()
            .map(|row| (row.hour, row.model, row.tokens))
            .collect();
        let row = |hour: &str, model: &str, tokens| (format!("2026-10-20T{hour}:00.000Z"), model.to_owned(), tokens);
        assert_eq!(
            rows,
            [
                row("09:30", sonnet, 322),
                row("10:30", "claude-opus-4-1", 161),
                row("10:30", sonnet, 161),
                row("11:30", sonnet, 161),
            ]
        );
    }
}

mod database {
    use super::*;

    #[test]
    fn read_only_readers_read_alongside_the_owning_collector_and_cannot_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("data").join("usage.sqlite");
        assert!(UsageStore::open_read_only(&path).is_err());
        let mut owner = UsageStore::open(&path).unwrap();
        owner.commit_file(&checkpoint(), &[event()], true).unwrap();
        assert_eq!(code(UsageStore::open(&path)), "collector_database_locked");
        let mut reader = UsageStore::open_read_only(&path).unwrap();
        assert_eq!(reader.period_totals(NOW, None).unwrap().all_time, 161);
        assert_eq!(
            reader.source_statuses().unwrap().len(),
            owner.source_statuses().unwrap().len()
        );
        assert!(reader.set_last_scan_at("2026-10-23T00:00:00.000Z").is_err());
        reader.close().unwrap();
        owner.close().unwrap();
        UsageStore::open(&path).unwrap().close().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(
                mode(&directory.path().join("data/usage.sqlite.collector-lock.sqlite")),
                0o600
            );
            assert_eq!(mode(&directory.path().join("data")), 0o700);
        }
    }
    #[test]
    fn refuses_a_database_from_a_newer_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.sqlite");
        UsageStore::open(&path).unwrap().close().unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA user_version=2")
            .unwrap();
        assert_eq!(code(UsageStore::open(&path)), "unsupported_database_version");
        assert_eq!(code(UsageStore::open_read_only(&path)), "unsupported_database_version");
    }
}

mod usage_limits {
    use super::*;
    use tokentracky_collector::limits::{LimitReading, LimitWindow};

    fn window(name: &str, used_percent: f64) -> LimitWindow {
        LimitWindow {
            name: name.to_owned(),
            used_percent,
            window_minutes: Some(300),
            resets_at_ms: Some(1_792_504_800_000),
        }
    }
    fn reading(tool: ToolId, as_of_ms: i64, windows: Vec<LimitWindow>) -> LimitReading {
        LimitReading {
            tool,
            as_of_ms,
            windows,
        }
    }

    #[test]
    fn keeps_the_latest_codex_reading_and_whatever_claude_code_holds_now() {
        let mut store = store();
        assert_eq!(store.limits().unwrap(), []);
        let later = reading(
            ToolId::Codex,
            20,
            vec![window("primary", 12.5), window("secondary", 2.0)],
        );
        store.update_limits(&later).unwrap();
        // An older snapshot, as another rollout read later may hold, does not replace it; an equal or later one does.
        store
            .update_limits(&reading(ToolId::Codex, 10, vec![window("primary", 90.0)]))
            .unwrap();
        assert_eq!(store.limits().unwrap(), [later]);
        let latest = reading(ToolId::Codex, 30, vec![window("secondary", 3.0)]);
        store.update_limits(&latest).unwrap();
        let claude = reading(
            ToolId::Claude,
            5,
            vec![window("seven_day_opus", 0.0), window("five_hour", 100.0)],
        );
        store.replace_limits(ToolId::Claude, Some(&claude)).unwrap();
        // In tool order, each reading's windows in their order.
        let mut sorted = claude.clone();
        sorted.windows.reverse();
        assert_eq!(store.limits().unwrap(), [sorted.clone(), latest.clone()]);
        store
            .replace_limits(
                ToolId::Claude,
                Some(&reading(ToolId::Claude, 1, vec![window("seven_day", 1.0)])),
            )
            .unwrap();
        assert_eq!(store.limits().unwrap()[0].windows, [window("seven_day", 1.0)]);
        store.replace_limits(ToolId::Claude, None).unwrap();
        assert_eq!(store.limits().unwrap(), [latest]);
    }
    #[test]
    fn keeps_limits_out_of_usage_and_the_upload_projection() {
        let mut store = store();
        store.commit_file(&checkpoint(), &[event()], true).unwrap();
        let epoch = store.usage_epoch();
        let buckets = store.public_buckets().unwrap();
        store
            .update_limits(&reading(ToolId::Codex, 1, vec![window("primary", 50.0)]))
            .unwrap();
        store
            .replace_limits(
                ToolId::Claude,
                Some(&reading(ToolId::Claude, 1, vec![window("five_hour", 50.0)])),
            )
            .unwrap();
        assert_eq!(store.usage_epoch(), epoch);
        assert_eq!(store.public_buckets().unwrap(), buckets);
        assert_eq!(store.export_data(&all()).unwrap(), [event()]);
    }
    #[test]
    fn rejects_readings_outside_the_allowlist_and_keeps_the_last() {
        let mut store = store();
        let kept = reading(ToolId::Codex, 1, vec![window("primary", 1.0)]);
        store.update_limits(&kept).unwrap();
        let with = |change: fn(&mut LimitReading)| {
            let mut reading = reading(ToolId::Codex, 2, vec![window("primary", 1.0)]);
            change(&mut reading);
            reading
        };
        for invalid in [
            with(|r| r.tool = ToolId::Gemini),
            with(|r| r.windows.clear()),
            with(|r| r.windows[0].name = "five_hour".to_owned()),
            with(|r| r.windows[0].name = "PRIVATE_NAME".to_owned()),
            with(|r| r.windows.push(window("primary", 2.0))),
            with(|r| r.as_of_ms = 0),
            with(|r| r.as_of_ms = 8_640_000_000_000_001),
            with(|r| r.windows[0].used_percent = -0.1),
            with(|r| r.windows[0].used_percent = 100.1),
            with(|r| r.windows[0].used_percent = f64::NAN),
            with(|r| r.windows[0].window_minutes = Some(0)),
            with(|r| r.windows[0].window_minutes = Some(MAX_SAFE_INTEGER + 1)),
            with(|r| r.windows[0].resets_at_ms = Some(0)),
            with(|r| r.windows[0].resets_at_ms = Some(8_640_000_000_000_001)),
        ] {
            assert_eq!(
                code(store.update_limits(&invalid)),
                "invalid_usage_limits",
                "{invalid:?}"
            );
            assert_eq!(
                code(store.replace_limits(ToolId::Codex, Some(&invalid))),
                "invalid_usage_limits"
            );
        }
        let claude = reading(ToolId::Claude, 1, vec![window("five_hour", 1.0)]);
        assert_eq!(
            code(store.replace_limits(ToolId::Codex, Some(&claude))),
            "invalid_usage_limits"
        );
        assert_eq!(store.limits().unwrap(), [kept]);
    }
    #[test]
    fn a_read_only_reader_of_an_older_database_has_no_limits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.sqlite");
        UsageStore::open(&path).unwrap().close().unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("DROP TABLE usage_limits")
            .unwrap();
        assert_eq!(UsageStore::open_read_only(&path).unwrap().limits().unwrap(), []);
    }
}
