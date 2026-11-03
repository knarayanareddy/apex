import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("cft_cold", Path(__file__).with_name("cft_cold.py"))
cold = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cold)


class CftColdTests(unittest.TestCase):
    def test_archive_rejects_traversal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "evil.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("chrome-linux64/../../outside", b"bad")
            with self.assertRaises(ValueError):
                cold.validate_archive(archive)
            link = zipfile.ZipInfo("chrome-linux64/link")
            link.create_system = 3
            link.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr(link, b"outside")
            with self.assertRaises(ValueError):
                cold.validate_archive(archive)
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("chrome-linux64/chrome", b"valid")
            cold.validate_archive(archive)

    def test_residency_threshold_uses_integer_arithmetic(self):
        self.assertTrue(cold.is_cold(1, 100))
        self.assertFalse(cold.is_cold(2, 100))
        self.assertTrue(cold.is_cold(0, 1))
        self.assertFalse(cold.is_cold(1, 0))

    def test_only_files_beneath_owned_directory_are_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "apex-cft"
            root.mkdir()
            (root / "chrome").write_bytes(b"owned")
            outside = Path(tmp) / "outside"
            outside.write_bytes(b"private")
            (root / "link").symlink_to(outside)
            with self.assertRaises(ValueError):
                cold.files_for_eviction(root, Path(tmp))
            self.assertEqual(outside.read_bytes(), b"private")

    def test_missing_or_wrong_owned_directory_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "wrong"
            root.mkdir()
            with self.assertRaises(ValueError):
                cold.files_for_eviction(root, Path(tmp))

    @unittest.skipUnless(cold.sys.platform == "linux", "Linux mincore and fadvise required")
    def test_linux_evicts_its_own_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "apex-cft"
            root.mkdir()
            target = root / "chrome"
            target.write_bytes(b"x" * (8 * 1024 * 1024))
            result = cold.evict_and_measure(cold.files_for_eviction(root, Path(tmp)))
            self.assertEqual(result["files"], 1)
            self.assertTrue(cold.is_cold(result["resident_pages"], result["pages"]))


if __name__ == "__main__":
    unittest.main()
