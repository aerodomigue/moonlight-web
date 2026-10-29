"""Build identity comes from the packaged source, even on a UI-only update."""
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'cmake/WriteFrontendBuild.cmake'


class FrontendBuildTest(unittest.TestCase):
    def test_revision_dirty_and_unknown(self):
        with tempfile.TemporaryDirectory(prefix='mw build ') as tmp:
            root = pathlib.Path(tmp)
            source = root / 'source'
            stage = root / 'stage'
            source.mkdir()
            (source / 'frontend').mkdir()
            asset = source / 'frontend/a.js'
            asset.write_text('first')
            def git(*args):
                return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
            def stamp(target=stage, revision=None):
                subprocess.run(['cmake', f'-DSOURCE_DIR={source}', f'-DOUTPUT_DIR={target}', *([] if revision is None else [f'-DSOURCE_REVISION={revision}']), '-P', str(SCRIPT)], check=True, capture_output=True)
                return (target / 'js/util/FrontendBuild.js').read_text()
            self.assertIn("revision: ''", stamp())
            self.assertIn('b' * 40, stamp(revision='b' * 40))
            self.assertIn('dirty: false', stamp(revision='b' * 40))
            with self.assertRaises(subprocess.CalledProcessError):
                stamp(revision='not-a-commit')
            git('init', '-q')
            git('add', '.')
            git('-c', 'user.name=Build fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
            revision = git('rev-parse', 'HEAD')
            self.assertIn(revision, stamp())
            self.assertIn('dirty: false', stamp())
            asset.write_text('second')
            self.assertIn('dirty: true', stamp())
            git('add', '.')
            git('-c', 'user.name=Build fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'second')
            second = git('rev-parse', 'HEAD')
            self.assertNotEqual(revision, second)
            self.assertIn(second, stamp())
            self.assertIn('dirty: false', stamp())
            with self.assertRaises(subprocess.CalledProcessError):
                stamp(source / 'frontend')
            self.assertFalse((source / 'frontend/js/util/FrontendBuild.js').exists())


if __name__ == '__main__':
    unittest.main()
