use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntelItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source: String, // "discussion" or "pr"
    pub author: String,
    pub body_preview: String,
    pub timestamp: String,
}

struct IntelCache {
    data: Option<(Vec<IntelItem>, std::time::Instant)>,
    ttl_seconds: u64,
}

impl IntelCache {
    fn get(&self) -> Option<&[IntelItem]> {
        self.data.as_ref().and_then(|(items, created)| {
            if created.elapsed().as_secs() < self.ttl_seconds {
                Some(items)
            } else {
                None
            }
        }).map(|v| &**v)
    }

    fn set(&mut self, items: Vec<IntelItem>) {
        self.data = Some((items, std::time::Instant::now()));
    }
}

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("blackwell-ops-intel/1.0")
        .build()
        .expect("failed to build reqwest client")
}

#[derive(Deserialize)]
struct GitHubUser {
    login: String,
}

fn scrub_markdown(text: &str) -> String {
    let mut result = text.to_string();

    // Remove image markdown ![alt](url)
    while let Some(start) = result.find("![") {
        if let Some(end_in_rest) = result[start + 2..].find(']') {
            let bracket_end = start + 2 + end_in_rest;
            if bracket_end + 1 < result.len() {
                // Find matching closing paren after the bracket
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

    // Remove code block fences but keep content — strip ``` lines
    let lines: Vec<&str> = result.lines().collect();
    let filtered: Vec<&str> = lines
        .iter()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("```")
        })
        .copied()
        .collect();
    result = filtered.join("\n");

    // Collapse multiple blank lines to at most one
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

async fn fetch_discussion_comments(client: &reqwest::Client) -> Vec<IntelItem> {
    // Fetch latest 5 active discussions with recent comments instead of a single hardcoded discussion
    let url = "https://api.github.com/repos/ggml-org/llama.cpp/discussions?per_page=10&sort=comments&direction=desc";

    #[derive(Deserialize)]
    struct DiscussionSummary {
        id: u64,
        title: String,
        html_url: String,
        comments: u32,
    }

    let items = match client.get(url).send().await {
        Ok(resp) => match resp.json::<Vec<DiscussionSummary>>().await {
            Ok(discussions) => discussions,
            Err(_) => return vec![],
        },
        Err(_) => return vec![],
    };

    // For each discussion with comments, fetch the latest comment body
    let mut results = Vec::new();
    for disc in items.iter().take(5).filter(|d| d.comments > 0) {
        let comment_url = format!(
            "https://api.github.com/repos/ggml-org/llama.cpp/discussions/{}/comments?per_page=1",
            disc.id
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
                        id: format!("disc-{}", disc.id),
                        title: disc.title.clone(),
                        url: disc.html_url.clone(),
                        source: "discussion".into(),
                        author: c.user.login.clone(),
                        body_preview: truncate_preview(&scrub_markdown(&c.body), 300),
                        timestamp: c.created_at.clone(),
                    });
                }
            }
        }
    }

    results
}

async fn fetch_recent_prs(client: &reqwest::Client) -> Vec<IntelItem> {
    // Fetch recent closed PRs — use labels that actually exist on llama.cpp repo
    let label_queries = [
        "server",
        "ggml",
        "cuda",
        "breaking-change",
    ];

    let mut all_items = Vec::new();
    let mut seen_numbers = std::collections::HashSet::new();

    for label in &label_queries {
        let url = format!(
            "https://api.github.com/search/issues?q=repo:ggml-org/llama.cpp+is:pr+is:closed+label:\"{}\"&sort=closed_at&order=desc&per_page=5",
            label
        );

        match client.get(&url).send().await {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(json) => {
                    if let Some(items) = json["items"].as_array() {
                        for item in items.iter() {
                            if let (Some(number), Some(title), Some(html_url)) = (
                                item["number"].as_u64(),
                                item["title"].as_str(),
                                item["html_url"].as_str(),
                            ) {
                                if seen_numbers.insert(number) {
                                    let body = item["body"].as_str().unwrap_or("");
                                    all_items.push(IntelItem {
                                        id: format!("pr-{}", number),
                                        title: title.to_string(),
                                        url: html_url.to_string(),
                                        source: "pr".into(),
                                        author: item["user"]["login"]
                                            .as_str()
                                            .unwrap_or("unknown")
                                            .to_string(),
                                        body_preview: truncate_preview(&scrub_markdown(body), 300),
                                        timestamp: item["closed_at"]
                                            .as_str()
                                            .map(String::from)
                                            .unwrap_or_else(|| {
                                                item["created_at"].as_str().unwrap_or("").to_string()
                                            }),
                                    });
                                }
                            }
                        }
                    }
                }
                Err(_) => continue,
            },
            Err(_) => continue,
        }

        // Small delay between label queries to avoid rate limiting
        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
    }

    all_items
}

#[command]
pub async fn fetch_github_intel() -> Result<serde_json::Value, String> {
    use tauri::async_runtime::Mutex as AsyncMutex;

    static CACHE: std::sync::LazyLock<std::sync::Arc<AsyncMutex<IntelCache>>> =
        std::sync::LazyLock::new(|| std::sync::Arc::new(AsyncMutex::new(IntelCache { data: None, ttl_seconds: 7200 })));

    let cache = &*CACHE;

    if let Some(cached) = {
        let guard = cache.lock().await;
        guard.get().map(|v| v.to_vec())
    } {
        return Ok(serde_json::to_value(&cached).unwrap_or_default());
    }

    let client = build_client();

    // Fetch discussion comments and recent PRs in parallel
    let (discussion_items, pr_items) = tokio::join!(
        fetch_discussion_comments(&client),
        fetch_recent_prs(&client)
    );

    let mut all_items: Vec<IntelItem> = discussion_items;
    all_items.extend(pr_items);

    // Sort by timestamp descending (newest first)
    all_items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    {
        let mut guard = cache.lock().await;
        guard.set(all_items.clone());
    }

    Ok(serde_json::to_value(&all_items).unwrap_or_default())
}
