"""Storage regressions use only the isolated HTTPS integration fixture."""
import importlib.util
import os
from pathlib import Path
import unittest

if os.geteuid() == 0:
    raise SystemExit('Run this permission-failure probe as an unprivileged user.')
spec = importlib.util.spec_from_file_location('fixture', 'backend/tests/test_oidc_integration.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.BINARY = str(Path('build/MoonlightWeb').resolve())
suite = unittest.TestSuite(m.OidcIsolation(name) for name in (
    'test_pin_logout_is_durable_when_primary_store_is_unwritable',
    'test_pin_logout_retains_retry_cookie_if_both_stores_fail',
    'test_corrupt_revocation_journal_does_not_restore_pin_authority',
    'test_pin_login_refuses_unpersisted_remembered_session',
    'test_unpersisted_host_identity_blocks_status_and_launch_without_rotation',
))
raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
