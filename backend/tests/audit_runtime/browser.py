import importlib.util
from pathlib import Path
import subprocess
spec = importlib.util.spec_from_file_location('fixture', 'backend/tests/test_oidc_integration.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.BINARY = str(Path('build/MoonlightWeb').resolve())
m.OidcIsolation.setUpClass()
case = m.OidcIsolation('test_authentication_modes')
case.setUp()
try:
    case.start()
    subprocess.run(['node', 'backend/tests/audit_runtime/browser.mjs', case.base], check=True, timeout=45)
finally:
    case.tearDown()
    m.OidcIsolation.tearDownClass()
