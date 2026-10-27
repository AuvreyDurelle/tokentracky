//! Write a bundled snapshot from a downloaded LiteLLM JSON file and its full upstream commit SHA.
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokentracky_pricing::{Json, PricingTable, trim_litellm};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() != 2 || args[0].len() != 40 || !args[0].bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("Usage: update_snapshot <full-upstream-commit-sha> <downloaded-json-file>".into());
    }
    let raw: Json = serde_json::from_slice(&fs::read(&args[1])?)?;
    let models = trim_litellm(&raw)?;
    let table = PricingTable::new(&models)?;
    let snapshot_hash = hex::encode(Sha256::digest(models.to_json_string()));
    let source = Json::Object(vec![
        ("repository".into(), Json::String("BerriAI/litellm".into())),
        ("commit".into(), Json::String(args[0].clone())),
        (
            "file".into(),
            Json::String("model_prices_and_context_window.json".into()),
        ),
        ("license".into(), Json::String("MIT".into())),
        (
            "fetchedAt".into(),
            Json::String(OffsetDateTime::now_utc().format(&Rfc3339)?),
        ),
    ]);
    let snapshot = Json::Object(vec![("source".into(), source), ("models".into(), models)]);
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data/litellm-prices.json");
    fs::write(&output, snapshot.to_json_string() + "\n")?;
    println!(
        "Wrote {} priced models ({}) to {}",
        table.size(),
        table.version(),
        output.display()
    );
    println!("LiteLLM-only snapshot version: litellm:{}", &snapshot_hash[..12]);
    Ok(())
}
