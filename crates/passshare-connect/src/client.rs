use std::env;
use std::time::Duration;

use passshare_core::domain::item::Item;
use passshare_core::domain::vault::Vault;
use passshare_core::domain::ConnectId;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde_json::Value;

use crate::error::{ConnectError, ConnectResult};
use crate::ItemOverview;

/// 1Password Connect SDK compatible HTTP client.
#[derive(Debug, Clone)]
pub struct ConnectClient {
    base_url: String,
    token: String,
    http: Client,
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
        self.get_json(&format!("/vaults/{vault_id}")).await
    }

    pub async fn list_items(&self, vault_id: &str) -> ConnectResult<Vec<ItemOverview>> {
        self.get_json(&format!("/vaults/{vault_id}/items")).await
    }

    pub async fn get_item(&self, vault_id: &str, item_id: &str) -> ConnectResult<Item> {
        self.get_json(&format!("/vaults/{vault_id}/items/{item_id}"))
            .await
    }

    pub async fn create_item(&self, vault_id: &str, item: &Value) -> ConnectResult<Item> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CreatedItem {
            id: ConnectId,
        }

        let created: CreatedItem = self
            .post_json(&format!("/vaults/{vault_id}/items"), item)
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
            &format!("/vaults/{vault_id}/items/{item_id}"),
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
        let url = format!("{}{}", self.base_url, format!("/vaults/{vault_id}/items/{item_id}"));
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
        let url = format!("{}{}", self.base_url, format!("/vaults/{vault_id}/items/{item_id}"));
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

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> ConnectResult<T> {
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
