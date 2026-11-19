//! `share`: the member's public links and README embeds, for the alias this computer's credential publishes under.
use crate::args::Flags;
use crate::{CliError, Context};
use axum::http::{Method, header};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use tokentracky_local_api::{
    HOSTED_TIMEOUT, HttpClient, HttpRequest, ReqwestClient, cloud_origin, encode_uri_component,
};

/// The keys of `share --json`, in order.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinks {
    pub alias: String,
    pub profile: String,
    pub month: String,
    pub year: String,
    pub badge: String,
    pub heatmap: String,
    pub post_on_x: String,
}

impl ShareLinks {
    /// The links for `alias` at `origin`, with this month's and this year's wraps for `today` (`YYYY-MM-DD`).
    pub fn new(origin: &str, alias: &str, today: &str) -> Self {
        let profile = format!("{origin}/u/{alias}");
        let tagged = format!("{profile}?ref=readme");
        let text = format!("{alias} on the Tokentracky leaderboard");
        Self {
            alias: alias.to_owned(),
            month: format!("{origin}/wrapped/{alias}/{}", &today[..7]),
            year: format!("{origin}/wrapped/{alias}/{}", &today[..4]),
            badge: format!("[![Tokentracky]({origin}/badge/{alias}.svg)]({tagged})"),
            heatmap: format!("[![Tokentracky activity]({origin}/card/heatmap/{alias}.svg)]({tagged})"),
            post_on_x: format!(
                "https://x.com/intent/post?text={}&url={}",
                encode_uri_component(&text),
                encode_uri_component(&format!("{profile}?ref=share"))
            ),
            profile,
        }
    }

    fn text(&self) -> String {
        format!(
            "Profile: {}\n  Pasted into X, Discord, Slack or iMessage, it shows your card.\nThis month: {}\nThis year: {}\n\
             Post on X: {}\nREADME badge: {}\nREADME heatmap: {}\n",
            self.profile, self.month, self.year, self.post_on_x, self.badge, self.heatmap
        )
    }
}

/// The alias the hosted service publishes this credential under, from `/api/device-policy`.
async fn published_alias(origin: &str, token: &str) -> Option<String> {
    let request = HttpRequest::new(Method::GET, format!("{origin}/api/device-policy"), HOSTED_TIMEOUT)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let response = ReqwestClient::new().ok()?.send(request).await.ok()?;
    if !response.ok() {
        return None;
    }
    let data = serde_json::from_slice::<Value>(&response.body).ok()?;
    data.pointer("/publication/alias")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub async fn share(flags: &Flags, context: &mut Context) -> Result<i32, CliError> {
    let link = match &context.secret_store {
        Some(store) => store.get().await.ok().flatten(),
        None => None,
    };
    let Some(link) = link else {
        context.err("This computer is not on the leaderboard yet. `tokentracky login` joins it.\n");
        return Ok(1);
    };
    let origin = cloud_origin(&link.url)?;
    let Some(alias) = published_alias(&origin, &link.device_token).await else {
        context.err(&format!(
            "Could not read your profile from {origin}. Check the connection and try again.\n"
        ));
        return Ok(1);
    };
    let today = OffsetDateTime::now_utc().date().to_string();
    let links = ShareLinks::new(&origin, &alias, &today);
    let output = if flags.json {
        serde_json::to_string_pretty(&links).map_err(crate::other)? + "\n"
    } else {
        links.text()
    };
    context.out(&output);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_the_profile_wraps_embeds_and_an_x_post() {
        let links = ShareLinks::new("https://tokentracky.com", "cli-builder", "2026-11-19");
        assert_eq!(links.profile, "https://tokentracky.com/u/cli-builder");
        assert_eq!(links.month, "https://tokentracky.com/wrapped/cli-builder/2026-11");
        assert_eq!(links.year, "https://tokentracky.com/wrapped/cli-builder/2026");
        assert_eq!(
            links.badge,
            "[![Tokentracky](https://tokentracky.com/badge/cli-builder.svg)](https://tokentracky.com/u/cli-builder?ref=readme)"
        );
        assert_eq!(
            links.heatmap,
            "[![Tokentracky activity](https://tokentracky.com/card/heatmap/cli-builder.svg)](https://tokentracky.com/u/cli-builder?ref=readme)"
        );
        assert_eq!(
            links.post_on_x,
            "https://x.com/intent/post?text=cli-builder%20on%20the%20Tokentracky%20leaderboard&url=https%3A%2F%2Ftokentracky.com%2Fu%2Fcli-builder%3Fref%3Dshare"
        );
    }
}
