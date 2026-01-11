"""Tests for Config class."""

import tempfile
from pathlib import Path

import pytest
from passshare.config import Config, get_default_config_path, get_default_store_path


class TestConfig:
    """Tests for Config class."""

    def test_default_paths(self) -> None:
        """Test default paths are set."""
        config_path = get_default_config_path()
        store_path = get_default_store_path()
        
        assert config_path is not None
        assert store_path is not None
        assert isinstance(config_path, Path)
        assert isinstance(store_path, Path)

    def test_defaults(self) -> None:
        """Test default configuration values."""
        config = Config()
        
        assert config.get("autoclip") is True
        assert config.get("cliptimeout") == 45
        assert config.get_bool("autosync") is True
        assert config.get_int("concurrency") == 10

    def test_get_nested(self) -> None:
        """Test getting nested configuration values."""
        config = Config()
        
        assert config.get("generate.length") == 24
        assert config.get_bool("generate.symbols") is True

    def test_set_value(self) -> None:
        """Test setting configuration values."""
        config = Config()
        
        config.set("autoclip", False)
        assert config.get_bool("autoclip") is False
        
        config.set("cliptimeout", 60)
        assert config.get_int("cliptimeout") == 60

    def test_set_nested(self) -> None:
        """Test setting nested configuration values."""
        config = Config()
        
        config.set("generate.length", 32)
        assert config.get("generate.length") == 32

    def test_mounts(self) -> None:
        """Test mount point management."""
        config = Config()
        
        config.add_mount("work", "/path/to/work")
        config.add_mount("personal", "/path/to/personal")
        
        mounts = config.mounts
        assert "work" in mounts
        assert "personal" in mounts
        assert mounts["work"] == "/path/to/work"
        
        result = config.remove_mount("work")
        assert result is True
        assert "work" not in config.mounts
        
        result = config.remove_mount("nonexistent")
        assert result is False

    def test_save_and_load(self) -> None:
        """Test saving and loading configuration."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config"
            
            # Create and save config
            config1 = Config(config_path)
            config1.set("autoclip", False)
            config1.set("cliptimeout", 120)
            config1.add_mount("test", "/path/to/test")
            config1.save()
            
            # Load into new config
            config2 = Config(config_path)
            config2.load()
            
            assert config2.get_bool("autoclip") is False
            assert config2.get_int("cliptimeout") == 120
            assert "test" in config2.mounts

    def test_store_path(self) -> None:
        """Test store path property."""
        config = Config()
        
        # Default store path
        store_path = config.store_path
        assert store_path is not None
        
        # Set custom path
        config.store_path = Path("/custom/path")
        assert config.store_path == Path("/custom/path")

    def test_get_bool_from_string(self) -> None:
        """Test boolean conversion from strings."""
        config = Config()
        
        config.set("test_true", "true")
        config.set("test_yes", "yes")
        config.set("test_1", "1")
        config.set("test_false", "false")
        
        assert config.get_bool("test_true") is True
        assert config.get_bool("test_yes") is True
        assert config.get_bool("test_1") is True
        assert config.get_bool("test_false") is False

    def test_get_int_from_string(self) -> None:
        """Test integer conversion from strings."""
        config = Config()
        
        config.set("test_num", "42")
        config.set("test_invalid", "not-a-number")
        
        assert config.get_int("test_num") == 42
        assert config.get_int("test_invalid") == 0

    def test_load_nonexistent_file(self) -> None:
        """Test loading from nonexistent file doesn't raise."""
        config = Config(Path("/nonexistent/path/config"))
        config.load()  # Should not raise
        
        # Should still have defaults
        assert config.get("autoclip") is True
