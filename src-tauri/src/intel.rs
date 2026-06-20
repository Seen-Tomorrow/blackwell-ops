use crate::engine::AppContext;
use crate::types::ProviderConfig;
use reqwest::header::{HeaderMap, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::command;

const CACHE_TTL_SECONDS: u64 = 7200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntelChannelMeta {
    pub id: String,
    pub display_name: String,
    pub tab_label: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntelItem {
    pub id: String,
    pub title: String,
    pub url: String,
    /// discussion | pr | open_pr | release
    pub source: String,
    pub author: String,
    pub body_preview: String,
    pub timestamp: String,
    pub channel: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub is_breaking: bool,
    #[serde(default)]
    pub is_open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntelFeed {
    pub channels: Vec<IntelChannelMeta>,
    pub items: Vec<IntelItem>,
    pub fetched_at: String,
    pub cache_ttl_seconds: u64,
}

struct IntelCache {
    data: Option<(IntelFeed, std::time::Instant)>,
}

impl IntelCache {
    fn get(&self) -> Option<IntelFeed> {
        self.data.as_ref().and_then(|(feed, created)| {
            if created.elapsed().as_secs() < CACHE_TTL_SECONDS {
                Some(feed.clone())
            } else {
                None
            }
        })
    }

    fn set(&mut self, feed: IntelFeed) {
        self.data = Some((feed, std::time::Instant::now()));
    }
}

struct IntelChannel {
    id: String,
    display_name: String,
    tab_label: String,
    owner: String,
    repo: String,
}

fn build_client() -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent("blackwell-ops-intel/1.0");

    match std::env::var("GITHUB_TOKEN") {
        Ok(ref token) if !token.is_empty() => {
            log::debug!("[intel] GITHUB_TOKEN configured");
            let mut headers = HeaderMap::new();
            headers.insert(
                AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
            );
            builder = builder.default_headers(headers);
        }
        _ => {
            log::debug!("[intel] GITHUB_TOKEN not set — rate limited to 60/hr");
        }
    }

    builder.build().expect("failed to build reqwest client")
}

#[derive(Deserialize)]
struct GitHubUser {
    login: String,
}

fn scrub_markdown(text: &str) -> String {
    let mut result = text.to_string();

    while let Some(start) = result.find("![") {
        if let Some(end_in_rest) = result[start + 2..].find(']') {
            let bracket_end = start + 2 + end_in_rest;
            if bracket_end + 1 < result.len() {
                let after_bracket = &result[bracket_end + 1..];
                if let Some(paren_end) = after_bracket.find(')') {
                    let full_end = bracket_end + 1 + paren_end;
                    result.replace_range(start..=full_end, "");
                    continue;
                }
            }
        }
        break;
    }

    let lines: Vec<&str> = result.lines().collect();
    let filtered: Vec<&str> = lines
        .iter()
        .filter(|line| !line.trim().starts_with("```"))
        .copied()
        .collect();
    result = filtered.join("\n");

    while result.contains("\n\n\n") {
        result = result.replace("\n\n\n", "\n\n");
    }

    result.trim().to_string()
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}

fn parse_github_repo(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim().trim_end_matches(".git");
    let path = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    Some((owner, repo))
}

fn channel_tab_label(provider: &ProviderConfig) -> String {
    match provider.id.as_str() {
        "ggml-master" => "GGML".into(),
        "ggml-tom" => "TOM".into(),
        _ => {
            if !provider.display_name.is_empty() {
                provider.display_name.to_uppercase()
            } else {
                provider.id.to_uppercase()
            }
        }
    }
}

fn channels_from_providers(providers: &[ProviderConfig]) -> Vec<IntelChannel> {
    let mut channels = Vec::new();
    let mut seen_repos = HashSet::new();

    for provider in providers.iter().filter(|p| p.enabled && !p.git_url.is_empty()) {
        let Some((owner, repo)) = parse_github_repo(&provider.git_url) else {
            continue;
        };
        let repo_key = format!("{}/{}", owner, repo);
        if !seen_repos.insert(repo_key.clone()) {
            continue;
        }
        channels.push(IntelChannel {
            id: provider.id.clone(),
            display_name: provider.display_name.clone(),
            tab_label: channel_tab_label(provider),
            owner,
            repo,
        });
    }

    channels
}

fn is_labelless_repo(_owner: &str, _repo: &str) -> bool {
    false
}

fn pr_labels_for_repo(_owner: &str, _repo: &str) -> &'static [&'static str] {
    &["server", "ggml", "cuda", "breaking-change"]
}

fn extract_labels(item: &serde_json::Value) -> Vec<String> {
    item["labels"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn labels_are_breaking(labels: &[String]) -> bool {
    labels
        .iter()
        .any(|l| l.eq_ignore_ascii_case("breaking-change"))
}

fn keyword_classify(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tags = Vec::new();
    if lower.contains("breaking") || lower.contains("breaking change") {
        tags.push("breaking-change".into());
    }
    if lower.contains("cuda") || lower.contains("gpu") || lower.contains("vulkan") || lower.contains("rocm") || lower.contains("hip") {
        tags.push("cuda".into());
    }
    if lower.contains("server") || lower.contains("llama-server") || lower.contains("http") || lower.contains("api") {
        tags.push("server".into());
    }
    if lower.contains("ggml") {
        tags.push("ggml".into());
    }
    tags
}

fn pr_item_from_json(
    item: &serde_json::Value,
    channel_id: &str,
    source: &str,
    is_open: bool,
    use_keyword_classification: bool,
) -> Option<IntelItem> {
    let number = item["number"].as_u64()?;
    let title = item["title"].as_str()?.to_string();
    let html_url = item["html_url"].as_str()?.to_string();
    let body = item["body"].as_str().unwrap_or("");
    let raw_labels = extract_labels(item);

    let (labels, is_breaking) = if use_keyword_classification {
        let combined = format!("{} {}", title, body);
        let kw_labels = keyword_classify(&combined);
        let breaking = kw_labels.iter().any(|l| l.eq_ignore_ascii_case("breaking-change"));
        (kw_labels, breaking)
    } else {
        let breaking = labels_are_breaking(&raw_labels);
        (raw_labels, breaking)
    };

    let timestamp = if is_open {
        item["updated_at"]
            .as_str()
            .or_else(|| item["created_at"].as_str())
            .unwrap_or("")
            .to_string()
    } else {
        item["closed_at"]
            .as_str()
            .or_else(|| item["updated_at"].as_str())
            .or_else(|| item["created_at"].as_str())
            .unwrap_or("")
            .to_string()
    };

    Some(IntelItem {
        id: format!("{}-{}-{}", channel_id, source, number),
        title,
        url: html_url,
        source: source.into(),
        author: item["user"]["login"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        body_preview: truncate_preview(&scrub_markdown(body), 300),
        timestamp,
        channel: channel_id.to_string(),
        labels,
        is_breaking,
        is_open,
    })
}

async fn fetch_discussion_comments(
    client: &reqwest::Client,
    channel: &IntelChannel,
) -> Vec<IntelItem> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/discussions?per_page=10&sort=comments&direction=desc",
        channel.owner, channel.repo
    );

    #[derive(Deserialize)]
    struct DiscussionSummary {
        id: u64,
        title: String,
        html_url: String,
        comments: u32,
    }

    let discussions = match client.get(&url).send().await {
        Ok(resp) => resp.json::<Vec<DiscussionSummary>>().await.unwrap_or_default(),
        Err(_) => return vec![],
    };

    let mut results = Vec::new();
    for disc in discussions.iter().take(5).filter(|d| d.comments > 0) {
        let comment_url = format!(
            "https://api.github.com/repos/{}/{}/discussions/{}/comments?per_page=1",
            channel.owner, channel.repo, disc.id
        );

        #[derive(Deserialize)]
        struct CommentSummary {
            body: String,
            user: GitHubUser,
            created_at: String,
        }

        if let Ok(resp) = client.get(&comment_url).send().await {
            if let Ok(comments) = resp.json::<Vec<CommentSummary>>().await {
                if let Some(c) = comments.first() {
                    results.push(IntelItem {
                        id: format!("{}-disc-{}", channel.id, disc.id),
                        title: disc.title.clone(),
                        url: disc.html_url.clone(),
                        source: "discussion".into(),
                        author: c.user.login.clone(),
                        body_preview: truncate_preview(&scrub_markdown(&c.body), 300),
                        timestamp: c.created_at.clone(),
                        channel: channel.id.clone(),
                        labels: vec![],
                        is_breaking: false,
                        is_open: false,
                    });
                }
            }
        }
    }

    results
}

async fn fetch_prs_by_labels(
    client: &reqwest::Client,
    channel: &IntelChannel,
    labels: &[&str],
    is_open: bool,
    source: &str,
) -> Vec<IntelItem> {
    let state = if is_open { "open" } else { "closed" };
    let sort = if is_open { "updated" } else { "closed_at" };
    let mut all_items = Vec::new();
    let mut seen_numbers = HashSet::new();

    for label in labels {
        let url = format!(
            "https://api.github.com/search/issues?q=repo:{}/{}+is:pr+is:{}+label:\"{}\"&sort={}&order=desc&per_page=5",
            channel.owner, channel.repo, state, label, sort
        );

        match client.get(&url).send().await {
            Ok(resp) => {
                log::debug!(
                    "[intel] {} {} label={} status={} rate={}/{}",
                    channel.repo,
                    state,
                    label,
                    resp.status(),
                    resp.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()).unwrap_or("?"),
                    resp.headers().get("x-ratelimit-limit").and_then(|v| v.to_str().ok()).unwrap_or("?")
                );
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(items) = json["items"].as_array() {
                        for item in items {
                            if let Some(number) = item["number"].as_u64() {
                                if seen_numbers.insert(number) {
                                    if let Some(intel_item) =
                                        pr_item_from_json(item, &channel.id, source, is_open, false)
                                    {
                                        all_items.push(intel_item);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::debug!("[intel] {} {} label={} fetch error: {}", channel.repo, state, label, e);
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
    }

    all_items
}

async fn fetch_prs_without_labels(
    client: &reqwest::Client,
    channel: &IntelChannel,
    is_open: bool,
    source: &str,
) -> Vec<IntelItem> {
    let state = if is_open { "open" } else { "closed" };
    let sort = if is_open { "updated" } else { "closed_at" };
    let url = format!(
        "https://api.github.com/search/issues?q=repo:{}/{}+is:pr+is:{}&sort={}&order=desc&per_page=10",
        channel.owner, channel.repo, state, sort
    );

    let mut all_items = Vec::new();

    match client.get(&url).send().await {
        Ok(resp) => {
            log::debug!(
                "[intel] {} {} status={} rate={}/{}",
                channel.repo,
                state,
                resp.status(),
                resp.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()).unwrap_or("?"),
                resp.headers().get("x-ratelimit-limit").and_then(|v| v.to_str().ok()).unwrap_or("?")
            );
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(items) = json["items"].as_array() {
                    for item in items {
                        if let Some(intel_item) =
                            pr_item_from_json(item, &channel.id, source, is_open, true)
                        {
                            all_items.push(intel_item);
                        }
                    }
                }
            }
        }
        Err(e) => {
            log::debug!("[intel] {} {} fetch error: {}", channel.repo, state, e);
        }
    }

    all_items
}

async fn fetch_recent_releases(client: &reqwest::Client, channel: &IntelChannel) -> Vec<IntelItem> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=4",
        channel.owner, channel.repo
    );

    #[derive(Deserialize)]
    struct ReleaseSummary {
        id: u64,
        name: Option<String>,
        tag_name: String,
        html_url: String,
        body: Option<String>,
        published_at: Option<String>,
    }

    let releases = match client.get(&url).send().await {
        Ok(resp) => {
            log::debug!(
                "[intel] {} releases status={} rate={}/{}",
                channel.repo,
                resp.status(),
                resp.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()).unwrap_or("?"),
                resp.headers().get("x-ratelimit-limit").and_then(|v| v.to_str().ok()).unwrap_or("?")
            );
            resp.json::<Vec<ReleaseSummary>>().await.unwrap_or_default()
        }
        Err(e) => {
            log::debug!("[intel] {} releases fetch error: {}", channel.repo, e);
            return vec![];
        }
    };

    releases
        .into_iter()
        .map(|r| {
            let title = r
                .name
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| r.tag_name.clone());
            let body = r.body.unwrap_or_default();
            IntelItem {
                id: format!("{}-release-{}", channel.id, r.id),
                title,
                url: r.html_url,
                source: "release".into(),
                author: channel.tab_label.clone(),
                body_preview: truncate_preview(&scrub_markdown(&body), 300),
                timestamp: r.published_at.unwrap_or_default(),
                channel: channel.id.clone(),
                labels: vec![],
                is_breaking: false,
                is_open: false,
            }
        })
        .collect()
}

async fn fetch_channel_intel(client: &reqwest::Client, channel: &IntelChannel) -> Vec<IntelItem> {
    let labelless = is_labelless_repo(&channel.owner, &channel.repo);

    let (discussions, closed_prs, open_prs, releases) = if labelless {
        tokio::join!(
            fetch_discussion_comments(client, channel),
            fetch_prs_without_labels(client, channel, false, "pr"),
            fetch_prs_without_labels(client, channel, true, "open_pr"),
            fetch_recent_releases(client, channel),
        )
    } else {
        let labels = pr_labels_for_repo(&channel.owner, &channel.repo);
        tokio::join!(
            fetch_discussion_comments(client, channel),
            fetch_prs_by_labels(client, channel, labels, false, "pr"),
            fetch_prs_by_labels(
                client,
                channel,
                &["breaking-change", "cuda", "server"],
                true,
                "open_pr"
            ),
            fetch_recent_releases(client, channel),
        )
    };

    let mut items = discussions;
    items.extend(closed_prs);
    items.extend(open_prs);
    items.extend(releases);
    items
}

async fn build_intel_feed(providers: &[ProviderConfig]) -> IntelFeed {
    let channels = channels_from_providers(providers);
    let client = build_client();
    let mut all_items = Vec::new();

    for channel in &channels {
        let mut channel_items = fetch_channel_intel(&client, channel).await;
        all_items.append(&mut channel_items);
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }

    all_items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let channel_meta: Vec<IntelChannelMeta> = channels
        .iter()
        .map(|c| IntelChannelMeta {
            id: c.id.clone(),
            display_name: c.display_name.clone(),
            tab_label: c.tab_label.clone(),
            repo: format!("{}/{}", c.owner, c.repo),
        })
        .collect();

    IntelFeed {
        channels: channel_meta,
        items: all_items,
        fetched_at: chrono_lite_now(),
        cache_ttl_seconds: CACHE_TTL_SECONDS,
    }
}

fn chrono_lite_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

#[command]
pub async fn fetch_github_intel(
    force: Option<bool>,
    app: tauri::State<'_, AppContext>,
) -> Result<serde_json::Value, String> {
    use tauri::async_runtime::Mutex as AsyncMutex;

    static CACHE: std::sync::LazyLock<std::sync::Arc<AsyncMutex<IntelCache>>> =
        std::sync::LazyLock::new(|| {
            std::sync::Arc::new(AsyncMutex::new(IntelCache { data: None }))
        });

    let force_refresh = force.unwrap_or(false);
    let cache = &*CACHE;

    if !force_refresh {
        if let Some(cached) = {
            let guard = cache.lock().await;
            guard.get()
        } {
            return Ok(serde_json::to_value(&cached).unwrap_or_default());
        }
    }

    let providers = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };

    let feed = build_intel_feed(&providers).await;

    {
        let mut guard = cache.lock().await;
        guard.set(feed.clone());
    }

    Ok(serde_json::to_value(&feed).unwrap_or_default())
}