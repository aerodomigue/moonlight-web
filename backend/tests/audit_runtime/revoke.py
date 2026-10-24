import importlib.util
import json
import os
from pathlib import Path
import resource
import subprocess

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
spec = importlib.util.spec_from_file_location('fixture', 'backend/tests/test_oidc_integration.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.BINARY = str(Path('build/MoonlightWeb').resolve())
if os.geteuid() == 0:
    raise SystemExit('Run this permission-failure probe as an unprivileged user.')
m.OidcIsolation.setUpClass()
case = m.OidcIsolation('test_authentication_modes')
case.setUp()
locked = None
try:
    user = case.start()
    user_id = case.login(user)['user']['id']
    admin = m.Browser(case.base)
    case.login(admin, 'admin-subject')
    key = admin.request('/api/admin/token')[1]['token']
    sessions = next(case.state.rglob('sessions.json'))
    sessions.parent.chmod(0o555)
    sessions.chmod(0o444)
    locked = (sessions.parent, sessions)
    try:
        status = admin.request('/api/admin/users/' + user_id + '/revoke-sessions', {},
                               extra_headers={'X-MW-Admin-Key': key})[0]
        print(json.dumps({'reply_status': status}))
    except Exception as error:
        print(json.dumps({'request_error_type': type(error).__name__}))
    try:
        code = case.process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        code = None
    print(json.dumps({'probe': 'admin-revoke-write-failure', 'server_exit_code': code,
                      'service_stayed_alive': code is None}))
finally:
    if locked:
        locked[0].chmod(0o700)
        locked[1].chmod(0o600)
    case.tearDown()
    m.OidcIsolation.tearDownClass()
