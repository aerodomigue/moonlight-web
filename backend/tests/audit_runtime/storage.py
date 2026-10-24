import importlib.util
import json
import os
from pathlib import Path

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
    browser = case.start()
    case.login(browser)
    sessions = next(case.state.rglob('sessions.json'))
    data = sessions.parent
    original = sessions.read_bytes()
    data.chmod(0o555)
    sessions.chmod(0o444)
    locked = (data, sessions)
    reply = browser.request('/api/auth/logout', {})[0]
    memory = browser.request('/api/auth/status')[1]['authenticated']
    unchanged = sessions.read_bytes() == original
    # Tokens remain in memory and are never printed by this probe.
    # The server persists hashes, so use a second browser captured before logout
    # in the next independent run below for the restart proof.
    print(json.dumps({'probe': 'logout-write-failure', 'http_status': reply,
                      'memory_authenticated': memory, 'session_file_unchanged': unchanged}))
    data.chmod(0o700)
    sessions.chmod(0o600)
    locked = None

    # A complete replay proof uses a copy of the valid browser cookie before logout.
    case.start()
    browser = m.Browser(case.base)
    case.login(browser, 'replay-subject')
    replay = m.Browser(case.base)
    for cookie in browser.cookies:
        replay.cookies.set_cookie(cookie)
    sessions = next(case.state.rglob('sessions.json'))
    data = sessions.parent
    data.chmod(0o555)
    sessions.chmod(0o444)
    locked = (data, sessions)
    code = browser.request('/api/auth/logout', {})[0]
    before_restart = replay.request('/api/auth/status')[1]['authenticated']
    case.stop()
    data.chmod(0o700)
    sessions.chmod(0o600)
    locked = None
    case.start()
    replay.base = case.base
    after_restart = replay.request('/api/auth/status')[1]['authenticated']
    print(json.dumps({'probe': 'logout-replay-after-restart', 'logout_http': code,
                      'replay_before_restart': before_restart, 'replay_after_restart': after_restart}))

    # Only the isolated fixture settings are changed. Production state is never used.
    settings = case.state / 'settings.json'
    d = json.loads(settings.read_text())
    d.pop('host_signing_key', None)
    settings.write_text(json.dumps(d))
    settings.chmod(0o444)
    case.state.chmod(0o555)
    locked = (case.state, settings)
    first = replay.request('/api/auth/status')[1]['host_id']
    second = replay.request('/api/auth/status')[1]['host_id']
    print(json.dumps({'probe': 'host-key-write-failure', 'successive_ids_match': first == second,
                      'key_persisted': bool(json.loads(settings.read_text()).get('host_signing_key'))}))
    case.state.chmod(0o700)
    settings.chmod(0o600)
    d['audit_sentinel'] = 'preserve-me'
    settings.write_text(json.dumps(d))
    settings.chmod(0o000)
    replay.request('/api/auth/status')
    settings.chmod(0o600)
    overwritten = json.loads(settings.read_text())
    print(json.dumps({'probe': 'settings-read-failure', 'sentinel_retained': 'audit_sentinel' in overwritten,
                      'field_count_before': len(d), 'field_count_after': len(overwritten)}))
finally:
    if locked:
        locked[0].chmod(0o700)
        locked[1].chmod(0o600)
    case.tearDown()
    m.OidcIsolation.tearDownClass()
