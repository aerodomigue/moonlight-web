#!/usr/bin/env python3
"""Run real Chromium identity-renewal regressions against an isolated OIDC fixture.

Usage: MW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs python3
       backend/tests/run_identity_browser.py build/MoonlightWeb
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import secrets
import sys

spec = importlib.util.spec_from_file_location("oidc_fixture", Path(__file__).with_name("test_oidc_integration.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.BINARY = str(Path(sys.argv[1]).resolve())
os.environ["MW_BINDING_FIXTURE"] = str(Path(fixture.BINARY).with_name("mw-security-tests"))
fixture.OidcIsolation.setUpClass()
case = fixture.OidcIsolation("test_authentication_modes")
case.setUp()
try:
    case.issuer_server.browser_subject = "admin-subject"
    case.start()
    case.issuer_server.test_case = case
    case.issuer_server.control_secret = secrets.token_urlsafe(32)
    os.environ["MW_FIXTURE_CONTROL"] = case.issuer_server.control_secret
    os.environ["MW_FIXTURE_CA"] = str(case.cert)
    os.environ["MW_FIXTURE_ISSUER"] = case.issuer
    for name in ([os.environ["MW_BROWSER_CASE"]] if os.environ.get("MW_BROWSER_CASE") else ("identity-renewal.mjs", "authentik-roles.mjs", "sso-lifecycle.mjs")):
        script = Path(__file__).resolve().parents[2] / "frontend/test/browser" / name
        subprocess.run(["node", str(script), case.base], check=True, timeout=120, env=os.environ.copy())
finally:
    case.tearDown()
    case.tearDownClass()
