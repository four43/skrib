"""Tests for plugin loader path traversal prevention."""
import os
import pytest

from skrib_plugin_sdk.loader import load_plugin_class


class TestPathTraversal:
    def test_rejects_path_outside_allowed_base(self, tmp_path):
        """Plugin dir outside allowed_base raises ValueError."""
        allowed = str(tmp_path / "plugins")
        os.makedirs(allowed)
        evil_dir = str(tmp_path / "evil")
        os.makedirs(evil_dir)

        with pytest.raises(ValueError, match="outside allowed base"):
            load_plugin_class(evil_dir, allowed_base=allowed)

    def test_rejects_traversal_via_dotdot(self, tmp_path):
        """Traversal via ../ is caught after realpath resolution."""
        allowed = str(tmp_path / "plugins")
        os.makedirs(allowed)
        traversal = os.path.join(allowed, "..", "evil")
        os.makedirs(str(tmp_path / "evil"))

        with pytest.raises(ValueError, match="outside allowed base"):
            load_plugin_class(traversal, allowed_base=allowed)

    def test_allows_path_within_base(self, tmp_path):
        """Plugin dir within allowed_base is accepted (fails later at backend/ check)."""
        allowed = str(tmp_path / "plugins")
        plugin_dir = os.path.join(allowed, "my.plugin")
        os.makedirs(plugin_dir)

        # Should get past path check but fail at "No backend/ directory"
        with pytest.raises(FileNotFoundError, match="No backend"):
            load_plugin_class(plugin_dir, allowed_base=allowed)

    def test_no_base_check_when_not_set(self, tmp_path):
        """Without allowed_base, any path is accepted (original behavior)."""
        plugin_dir = str(tmp_path / "any-dir")
        os.makedirs(plugin_dir)

        # Fails at backend/ check, not path check
        with pytest.raises(FileNotFoundError, match="No backend"):
            load_plugin_class(plugin_dir)
