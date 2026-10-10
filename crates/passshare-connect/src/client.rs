use std::env;
use std::fmt;
use std::time::Duration;

use passshare_core::domain::connect_id::ConnectId;
use passshare_core::domain::item::Item;
use passshare_core::domain::vault::Vault;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde_json::Value;

use crate::error::{ConnectError, ConnectResult};
use crate::ItemOverview;

/// Percent-encode a single URL path segment. Vault/item identifiers are
/// interpolated into the request path; without encoding, a value containing
/// `/`, `?`, `#`, or `..` could alter the path (traversal / request smuggling).
/// Legitimate ConnectIds (`[a-z0-9]{26}`) pass through unchanged.
fn seg(segment: &str) -> String {
    utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string()
}

/// 1Password Connect SDK compatible HTTP client.
#[derive(Clone)]
pub struct ConnectClient {
    base_url: String,
    token: String,
    http: Client,
}

// Manual Debug so the bearer token never leaks via `{:?}`, logs, or panic backtraces.
impl fmt::Debug for ConnectClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectClient")
            .field("base_url", &self.base_url)
            .field("token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl ConnectClient {
    pub fn from_env() -> ConnectResult<Self> {
        let host = env::var("OP_CONNECT_HOST").map_err(|_| ConnectError::MissingHost)?;
        let token = env::var("OP_CONNECT_TOKEN").map_err(|_| ConnectError::MissingToken)?;
        Self::new(host, token)
    }

    pub fn new(host: impl Into<String>, token: impl Into<String>) -> ConnectResult<Self> {
        let mut base = host.into().trim_end_matches('/').to_string();
        if !base.ends_with("/v1") {
            base.push_str("/v1");
        }
        let http = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            base_url: base,
            token: token.into(),
            http,
        })
    }

    pub async fn list_vaults(&self) -> ConnectResult<Vec<Vault>> {
        self.get_json("/vaults").await
    }

    pub async fn get_vault(&self, vault_id: &str) -> ConnectResult<Vault> {
        self.get_json(&format!("/vaults/{}", seg(vault_id))).await
    }

    pub async fn list_items(&self, vault_id: &str) -> ConnectResult<Vec<ItemOverview>> {
        self.get_json(&format!("/vaults/{}/items", seg(vault_id)))
            .await
    }

    pub async fn get_item(&self, vault_id: &str, item_id: &str) -> ConnectResult<Item> {
        self.get_json(&format!("/vaults/{}/items/{}", seg(vault_id), seg(item_id)))
            .await
    }

    pub async fn create_item(&self, vault_id: &str, item: &Value) -> ConnectResult<Item> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CreatedItem {
            id: ConnectId,
        }

        let created: CreatedItem = self
            .post_json(&format!("/vaults/{}/items", seg(vault_id)), item)
            .await?;
        self.get_item(vault_id, created.id.as_str()).await
    }

    pub async fn replace_item(
        &self,
        vault_id: &str,
        item_id: &str,
        item: &Value,
    ) -> ConnectResult<Item> {
        self.put_json(
            &format!("/vaults/{}/items/{}", seg(vault_id), seg(item_id)),
            item,
        )
        .await
    }

    pub async fn patch_item(
        &self,
        vault_id: &str,
        item_id: &str,
        patch: &Value,
    ) -> ConnectResult<Item> {
        let url = format!(
            "{}/vaults/{}/items/{}",
            self.base_url,
            seg(vault_id),
            seg(item_id)
        );
        let response = self
            .http
            .patch(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(CONTENT_TYPE, "application/json-patch+json")
            .json(patch)
            .send()
            .await?;
        self.decode_response(response).await
    }

    pub async fn delete_item(&self, vault_id: &str, item_id: &str) -> ConnectResult<()> {
        let url = format!(
            "{}/vaults/{}/items/{}",
            self.base_url,
            seg(vault_id),
            seg(item_id)
        );
        let response = self
            .http
            .delete(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .send()
            .await?;
        if response.status().is_success() {
            return Ok(());
        }
        self.decode_error(response).await
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> ConnectResult<T> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .send()
            .await?;
        self.decode_response(response).await
    }

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> ConnectResult<T> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await?;
        self.decode_response(response).await
    }

    async fn put_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> ConnectResult<T> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .put(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await?;
        self.decode_response(response).await
    }

    async fn decode_response<T: serde::de::DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> ConnectResult<T> {
        if response.status().is_success() {
            return Ok(response.json().await?);
        }
        self.decode_error(response).await
    }

    async fn decode_error<T>(&self, response: reqwest::Response) -> ConnectResult<T> {
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or_default();
        let message = body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error")
            .to_string();
        Err(ConnectError::Api { status, message })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_redacts_token() {
        let client = ConnectClient::new("https://example.test", "super-secret-token").unwrap();
        let rendered = format!("{client:?}");
        assert!(
            !rendered.contains("super-secret-token"),
            "token must not appear in Debug"
        );
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn seg_passes_through_legitimate_connect_ids() {
        let id = "abcdefghijklmnopqrstuvwxyz"; // 26 lowercase alnum
        assert_eq!(seg(id), id);
    }

    #[test]
    fn seg_neutralizes_path_delimiters_and_traversal() {
        // A malicious id must not be able to change the request path.
        assert_eq!(seg("../../secrets"), "%2E%2E%2F%2E%2E%2Fsecrets");
        assert_eq!(seg("a/b"), "a%2Fb");
        assert_eq!(seg("a?b#c"), "a%3Fb%23c");
        for encoded in [seg("../x"), seg("a/b"), seg("a?b")] {
            assert!(!encoded.contains('/'));
            assert!(!encoded.contains('?'));
            assert!(!encoded.contains('#'));
        }
    }
}
