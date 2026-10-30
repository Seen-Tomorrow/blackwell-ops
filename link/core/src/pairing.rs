//! Device pairing over the gateway's `/pair` endpoint.

use crate::identity::{save_token, Identity};
use oym_gateway::protocol::{PairRequest, PairResponse};
use std::path::Path;
use url::Url;

/// Convert the client-facing server URL into the HTTP(S) `/pair` endpoint.
pub fn pair_url(server: &str) -> Result<Url, String> {
    let mut url = Url::parse(server).map_err(|error| format!("server URL: {error}"))?;
    match url.scheme() {
        "wss" | "https" => {
            url.set_scheme("https").ok();
        }
        "ws" | "http" => {
            url.set_scheme("http").ok();
        }
        other => return Err(format!("unsupported server scheme: {other}")),
    }
    url.set_path("/pair");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[allow(clippy::too_many_arguments)]
pub async fn pair_device(
    server: &str,
    code: &str,
    name: &str,
    client_version: &str,
    pi_version: &str,
    integrity: &str,
) -> Result<(Identity, String), String> {
    let request = PairRequest {
        code: code.trim().to_string(),
        device_name: Some(name.to_string()),
        os: Some("Windows".into()),
        user: std::env::var("USERNAME").ok(),
        integrity: Some(integrity.to_string()),
        client_version: Some(client_version.to_string()),
        pi_version: Some(pi_version.to_string()),
    };
    let response = reqwest::Client::new()
        .post(pair_url(server)?)
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("pair request: {error:?}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("pairing rejected ({status}): {text}"));
    }
    let body: PairResponse = response
        .json()
        .await
        .map_err(|error| format!("pair response: {error}"))?;
    save_token(&body.device_id, &body.token)?;
    let identity = Identity {
        device_id: body.device_id,
        server: crate::status::link_url(server)?.to_string(),
        name: name.to_string(),
    };
    Ok((identity, body.token))
}

/// Persist a freshly paired identity next to the data dir (token stays in the
/// Credential Manager).
pub fn persist_identity(data_dir: &Path, identity: &Identity) -> Result<(), String> {
    crate::identity::save_identity(data_dir, identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_url_normalizes_ws_and_https() {
        assert_eq!(
            pair_url("wss://example.test/link?x=1").expect("wss").as_str(),
            "https://example.test/pair"
        );
        assert_eq!(
            pair_url("ws://127.0.0.1:7443/link").expect("ws").as_str(),
            "http://127.0.0.1:7443/pair"
        );
        assert!(pair_url("ftp://example.test").is_err());
    }
}
