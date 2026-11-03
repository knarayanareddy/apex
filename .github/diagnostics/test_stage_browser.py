import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("stage_browser", Path(__file__).with_name("stage_browser.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


class StageBrowserTests(unittest.TestCase):
    def test_copy_is_independent_and_resources_point_to_original(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "original"
            source.mkdir()
            browser = source / "chrome"
            browser.write_bytes(b"executable fixture")
            browser.chmod(0o755)
            (source / "resources.pak").write_bytes(b"resource fixture")
            result = stage.stage(browser, root / "staged")
            staged = root / "staged" / "chrome"
            self.assertEqual(staged.read_bytes(), browser.read_bytes())
            self.assertNotEqual(staged.stat().st_ino, browser.stat().st_ino)
            self.assertEqual(result["bytes"], len(b"executable fixture"))
            self.assertTrue((root / "staged" / "resources.pak").is_symlink())
            self.assertEqual((root / "staged" / "resources.pak").read_bytes(), b"resource fixture")

    def test_existing_destination_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "chrome"
            source.write_bytes(b"source")
            dest = root / "staged"
            dest.mkdir()
            (dest / "chrome").write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                stage.stage(source, dest)
            self.assertEqual((dest / "chrome").read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
