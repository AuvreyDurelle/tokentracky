//! Local-only request lineage. No counters participate in identity, and none of this metadata is published.
use std::collections::{HashMap, HashSet};
use tokentracky_core::{UsageEvent, total_tokens};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UsageOrigin {
    pub event_id: String,
    pub node: String,
    pub parent: Option<String>,
}

/// Prefer the actual request over its immutable fork snapshots, including when the request was corrected to zero.
/// Edges survive source deletion/pausing; a later observation can join previously disconnected nested histories.
pub(crate) fn reconcile(mut events: Vec<UsageEvent>, origins: &[UsageOrigin]) -> Vec<UsageEvent> {
    if origins.is_empty() {
        events.retain(|event| total_tokens(&event.tokens) != 0);
        events.sort_by(|a, b| a.event_id.cmp(&b.event_id));
        return events;
    }
    let selected: HashSet<String> = canonical_ids(events.iter().map(|event| event.event_id.as_str()), origins)
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut events: Vec<_> = events
        .into_iter()
        .filter(|event| selected.contains(event.event_id.as_str()) && total_tokens(&event.tokens) != 0)
        .collect();
    events.sort_by(|a, b| a.event_id.cmp(&b.event_id));
    events
}

/// Select identities without loading token payloads, for cheap source status queries.
pub(crate) fn canonical_ids<'a>(ids: impl Iterator<Item = &'a str>, origins: &[UsageOrigin]) -> HashSet<&'a str> {
    let by_event: HashMap<_, _> = origins
        .iter()
        .map(|origin| (origin.event_id.as_str(), origin))
        .collect();
    let parents: HashMap<_, _> = origins
        .iter()
        .filter_map(|origin| origin.parent.as_deref().map(|parent| (origin.node.as_str(), parent)))
        .collect();
    let mut selected: HashMap<String, (usize, &'a str)> = HashMap::new();
    for id in ids {
        let (mut node, mut depth) = by_event.get(id).map_or((id, 0), |origin| (origin.node.as_str(), 0));
        let mut seen = HashSet::new();
        while let Some(parent) = parents.get(node) {
            if !seen.insert(node) {
                node = id;
                depth = 0;
                break;
            }
            node = parent;
            depth += 1;
        }
        if selected.get(node).is_none_or(|old| (depth, id) < *old) {
            selected.insert(node.to_owned(), (depth, id));
        }
    }
    selected.into_values().map(|(_, id)| id).collect()
}

/// Keep the ancestry needed by selected event identities, including excluded ancestors if an eligible copy needs
/// them. Unrelated physical databases must not acquire one another's provisional checkpoint diagnostics.
pub(crate) fn relevant_lineage<'a>(origins: &[UsageOrigin], ids: impl Iterator<Item = &'a str>) -> Vec<UsageOrigin> {
    let ids: HashSet<_> = ids.collect();
    let mut needed: HashSet<String> = origins
        .iter()
        .filter(|o| ids.contains(o.event_id.as_str()))
        .map(|o| o.node.clone())
        .collect();
    loop {
        let mut changed = false;
        for origin in origins {
            if needed.contains(&origin.node)
                && let Some(parent) = &origin.parent
            {
                changed |= needed.insert(parent.clone());
            }
        }
        if !changed {
            break;
        }
    }
    origins.iter().filter(|o| needed.contains(&o.node)).cloned().collect()
}

/// Every copy must reach an observed original. Missing rows and cycles are provisional.
pub(crate) fn complete_lineage(origins: &[UsageOrigin]) -> bool {
    let mut nodes = HashMap::new();
    for origin in origins {
        // Upstream uniquely reserves (session,seq). Competing stores with different message IDs at the same
        // node cannot prove request identity, even when their parent fields happen to agree.
        if nodes
            .insert(
                origin.node.as_str(),
                (origin.event_id.as_str(), origin.parent.as_deref()),
            )
            .is_some_and(|old| old != (origin.event_id.as_str(), origin.parent.as_deref()))
        {
            return false;
        }
    }
    origins.iter().all(|origin| {
        let mut node = origin.node.as_str();
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(node) {
                return false;
            }
            match nodes.get(node) {
                Some((_, Some(parent))) => node = parent,
                Some((_, None)) => return true,
                None => return false,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicting_observations_of_a_node_are_incomplete_in_every_order() {
        let root = UsageOrigin {
            event_id: "original".into(),
            node: "a".into(),
            parent: None,
        };
        let copy = UsageOrigin {
            event_id: "copy".into(),
            node: "b".into(),
            parent: Some("a".into()),
        };
        let conflicting = UsageOrigin {
            event_id: "another-copy".into(),
            node: "b".into(),
            parent: None,
        };
        assert!(complete_lineage(&[root.clone(), copy.clone()]));
        assert!(!complete_lineage(&[root.clone(), copy.clone(), conflicting.clone()]));
        assert!(!complete_lineage(&[conflicting, copy, root]));
    }
}
