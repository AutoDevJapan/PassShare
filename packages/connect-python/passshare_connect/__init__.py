"""PassShare Connect API client (1Password Connect compatible)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def _normalize_base_url(host: str) -> str:
    trimmed = host.rstrip("/")
    return trimmed if trimmed.endswith("/v1") else f"{trimmed}/v1"


@dataclass
class ConnectClient:
    host: str
    token: str

    @classmethod
    def from_env(cls) -> "ConnectClient":
        host = os.environ.get("OP_CONNECT_HOST")
        token = os.environ.get("OP_CONNECT_TOKEN")
        if not host:
            raise RuntimeError("Missing OP_CONNECT_HOST")
        if not token:
            raise RuntimeError("Missing OP_CONNECT_TOKEN")
        return cls(host=host, token=token)

    @property
    def base_url(self) -> str:
        return _normalize_base_url(self.host)

    def list_vaults(self) -> list[dict[str, Any]]:
        return self._request("GET", "/vaults")

    def get_vault(self, vault_id: str) -> dict[str, Any]:
        return self._request("GET", f"/vaults/{vault_id}")

    def list_items(self, vault_id: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/vaults/{vault_id}/items")

    def get_item(self, vault_id: str, item_id: str) -> dict[str, Any]:
        return self._request("GET", f"/vaults/{vault_id}/items/{item_id}")

    def create_item(self, vault_id: str, item: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/vaults/{vault_id}/items", item)

    def replace_item(self, vault_id: str, item_id: str, item: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"/vaults/{vault_id}/items/{item_id}", item)

    def patch_item(self, vault_id: str, item_id: str, patch: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request(
            "PATCH",
            f"/vaults/{vault_id}/items/{item_id}",
            patch,
            content_type="application/json-patch+json",
        )

    def delete_item(self, vault_id: str, item_id: str) -> None:
        self._request("DELETE", f"/vaults/{vault_id}/items/{item_id}")

    def _request(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        content_type: str = "application/json",
    ) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = content_type
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request) as response:
                if response.status == 204:
                    return None
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            payload = error.read().decode("utf-8")
            raise RuntimeError(payload or str(error)) from error
