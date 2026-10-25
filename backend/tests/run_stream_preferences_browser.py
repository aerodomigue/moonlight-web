#!/usr/bin/env python3
"""Chromium regressions for stream size negotiation, using only loopback fixtures.

Run from the repository root:
MW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs python3 \
    backend/tests/run_stream_preferences_browser.py build/MoonlightWeb
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location(
    'oidc_fixture', Path(__file__).with_name('test_oidc_integration.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.BINARY = str(Path(sys.argv[1]).resolve())
fixture.OidcIsolation.setUpClass()
case = fixture.OidcIsolation('test_authentication_modes')
case.setUp()
try:
    case.start()
    admin, headers = case.administrator()
    pins = []
    for i in range(4):
        uid = admin.request('/api/admin/users', {'name': f'Stream preferences fixture {i}', 'role': 'user'},
                            extra_headers=headers)[1]['user']['id']
        pins.append(admin.request('/api/admin/users/' + uid + '/pin', {}, extra_headers=headers)[1]['pin'])
    env = os.environ.copy()
    env['MW_FIXTURE_PINS'] = json.dumps(pins)
    script = Path(__file__).resolve().parents[2] / 'frontend/test/browser/stream-dimensions.mjs'
    subprocess.run(['node', str(script), case.base], env=env, check=True, timeout=180)
finally:
    case.tearDown()
    case.tearDownClass()
