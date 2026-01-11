"""Configuration management for PassShare.

Compatible with gopass config file format (~/.config/gopass/config).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

import yaml


def get_default_config_path() -> Path:
    """Get the default config file path.

    Returns:
        Path to the config file.
    """
    # Check environment variable first
    if env_path := os.environ.get("GOPASS_CONFIG"):
        return Path(env_path)

    # Use platform-specific default
    if os.name == "nt":  # Windows
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            return Path(appdata) / "gopass" / "config"
        return Path.home() / "AppData" / "Roaming" / "gopass" / "config"
    else:  # Linux/macOS
        xdg_config = os.environ.get("XDG_CONFIG_HOME", "")
        if xdg_config:
            return Path(xdg_config) / "gopass" / "config"
        return Path.home() / ".config" / "gopass" / "config"


def get_default_store_path() -> Path:
    """Get the default store path.

    Returns:
        Path to the root store.
    """
    # Check environment variable first
    if env_path := os.environ.get("PASSWORD_STORE_DIR"):
        return Path(env_path)

    # Use platform-specific default
    if os.name == "nt":  # Windows
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            return Path(appdata) / "gopass" / "stores" / "root"
        return Path.home() / "AppData" / "Roaming" / "gopass" / "stores" / "root"
    else:  # Linux/macOS
        xdg_data = os.environ.get("XDG_DATA_HOME", "")
        if xdg_data:
            return Path(xdg_data) / "gopass" / "stores" / "root"
        return Path.home() / ".local" / "share" / "gopass" / "stores" / "root"


class Config:
    """Configuration management class."""

    # Default values
    DEFAULTS: dict[str, Any] = {
        "autoclip": True,
        "autoimport": True,
        "autopush": True,
        "autosync": True,
        "clipctrl": "",
        "cliptimeout": 45,
        "concurrency": 10,
        "exportkeys": True,
        "nocolor": False,
        "noconfirm": False,
        "nopager": False,
        "notifications": True,
        "parsing": True,
        "safecontent": False,
        "generate": {
            "autoclip": True,
            "length": 24,
            "symbols": True,
            "strict": False,
        },
        "audit": {
            "hibp": False,
        },
        "edit": {
            "editor": "",
        },
    }

    def __init__(self, path: Optional[Path] = None) -> None:
        """Initialize config.

        Args:
            path: Path to config file. Uses default if not specified.
        """
        self._path = path or get_default_config_path()
        self._data: dict[str, Any] = {}
        self._mounts: dict[str, str] = {}
        self._store_path: Optional[Path] = None

    @property
    def path(self) -> Path:
        """Get the config file path."""
        return self._path

    @property
    def store_path(self) -> Path:
        """Get the root store path."""
        if self._store_path:
            return self._store_path
        path_str = self._data.get("path")
        if path_str:
            return Path(path_str)
        return get_default_store_path()

    @store_path.setter
    def store_path(self, value: Path) -> None:
        """Set the root store path."""
        self._store_path = value
        self._data["path"] = str(value)

    @property
    def mounts(self) -> dict[str, str]:
        """Get mount points."""
        return self._mounts.copy()

    def get(self, key: str, default: Any = None) -> Any:
        """Get a config value.

        Args:
            key: The config key (supports dot notation for nested keys).
            default: Default value if not found.

        Returns:
            The config value.
        """
        # Handle dot notation
        parts = key.split(".")
        value: Any = self._data

        for part in parts:
            if isinstance(value, dict) and part in value:
                value = value[part]
            else:
                # Try defaults
                default_value: Any = self.DEFAULTS
                for p in parts:
                    if isinstance(default_value, dict) and p in default_value:
                        default_value = default_value[p]
                    else:
                        return default
                return default_value

        return value

    def get_bool(self, key: str) -> bool:
        """Get a boolean config value.

        Args:
            key: The config key.

        Returns:
            The boolean value (False if not found).
        """
        value = self.get(key, False)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.lower() in ("true", "yes", "1", "on")
        return bool(value)

    def get_int(self, key: str) -> int:
        """Get an integer config value.

        Args:
            key: The config key.

        Returns:
            The integer value (0 if not found).
        """
        value = self.get(key, 0)
        if isinstance(value, int):
            return value
        try:
            return int(value)
        except (ValueError, TypeError):
            return 0

    def set(self, key: str, value: Any) -> None:
        """Set a config value.

        Args:
            key: The config key (supports dot notation).
            value: The value to set.
        """
        parts = key.split(".")

        if len(parts) == 1:
            self._data[key] = value
        else:
            current = self._data
            for part in parts[:-1]:
                if part not in current:
                    current[part] = {}
                current = current[part]
            current[parts[-1]] = value

    def add_mount(self, alias: str, path: str) -> None:
        """Add a mount point.

        Args:
            alias: The mount alias.
            path: The store path.
        """
        self._mounts[alias] = path

    def remove_mount(self, alias: str) -> bool:
        """Remove a mount point.

        Args:
            alias: The mount alias.

        Returns:
            True if removed, False if not found.
        """
        if alias in self._mounts:
            del self._mounts[alias]
            return True
        return False

    def load(self) -> None:
        """Load config from file."""
        if not self._path.exists():
            return

        with open(self._path, encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if data is None:
            return

        if isinstance(data, dict):
            # Extract mounts
            self._mounts = data.pop("mounts", {})
            self._data = data

    def save(self) -> None:
        """Save config to file."""
        # Ensure directory exists
        self._path.parent.mkdir(parents=True, exist_ok=True)

        # Combine data and mounts
        data = self._data.copy()
        if self._mounts:
            data["mounts"] = self._mounts

        with open(self._path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, allow_unicode=True)

    def __repr__(self) -> str:
        """Get string representation."""
        return f"Config(path={self._path}, mounts={list(self._mounts.keys())})"
