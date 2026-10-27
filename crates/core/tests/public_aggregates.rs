use serde_json::json;
use tokentracky_core::{CommunityStats, LeaderboardResponse};

#[test]
fn numeric_only_responses_remain_compatible_and_exact_companions_round_trip() {
    let legacy = json!({
        "items": [], "total": 0, "builders": 0, "page": 1, "pageSize": 20,
        "period": "all", "windowStart": null, "updatedAt": "2026-10-26T12:00:00Z",
        "totalTokens": 0, "totalCostMicrousd": null, "toolTotals": {}, "trend": []
    });
    let board: LeaderboardResponse = serde_json::from_value(legacy.clone()).unwrap();
    assert!(board.exact_aggregates.is_none());
    assert_eq!(serde_json::to_value(board).unwrap(), legacy);
    let huge = "1208925819614629174706176"; // 2^80; exact decimal values are not constrained by u64.
    let exact = json!({
        "totalTokens": huge, "totalCostMicrousd": huge,
        "toolTotals": {"claude": huge}, "trend": [{"day": "2026-10-26", "tokens": huge}],
        "breakdown": {"input": huge, "output": "0", "cacheRead": "0", "cacheWrite": "0", "reasoning": "0"}
    });
    let mut wide = legacy;
    wide["totalTokens"] = json!(9007199254740991_u64);
    wide["exactAggregates"] = exact.clone();
    let board: LeaderboardResponse = serde_json::from_value(wide.clone()).unwrap();
    assert_eq!(serde_json::to_value(board).unwrap(), wide);

    let mut community = json!({"builders": 0, "newBuilders": 0, "totalTokens": 0,
        "totalCostMicrousd": null, "toolTotals": {}, "trend": [], "breakdown": null,
        "updatedAt": "2026-10-26T12:00:00Z"});
    let old: CommunityStats = serde_json::from_value(community.clone()).unwrap();
    assert_eq!(serde_json::to_value(old).unwrap(), community);
    community["exactAggregates"] = exact;
    let new: CommunityStats = serde_json::from_value(community.clone()).unwrap();
    assert_eq!(serde_json::to_value(new).unwrap(), community);
    // The 12 months and the median, with exact companions above the safe range.
    community["monthly"] =
        json!([{"month": "2026-09", "tokens": 5}, {"month": "2026-10", "tokens": 9007199254740991_u64}]);
    community["medianTokens"] = json!(9007199254740991_u64);
    community["exactAggregates"]["monthly"] =
        json!([{"month": "2026-09", "tokens": "5"}, {"month": "2026-10", "tokens": huge}]);
    community["exactAggregates"]["medianTokens"] = json!(huge);
    let monthly: CommunityStats = serde_json::from_value(community.clone()).unwrap();
    assert_eq!(monthly.monthly.as_ref().map(Vec::len), Some(2));
    assert_eq!(serde_json::to_value(monthly).unwrap(), community);
}
