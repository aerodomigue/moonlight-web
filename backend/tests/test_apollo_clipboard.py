#!/usr/bin/env python3
"""Exercise the production adapter against a mutually authenticated HTTPS Apollo fixture."""
import base64
import http.server
import json
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest

BINARY = str(Path(sys.argv.pop()).resolve())
FULL = (1 << 25) | (1 << 12) | (1 << 16) | (1 << 17)

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def reply(self, status, body=b''):
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (OSError, ssl.SSLError):
            pass
    def do_GET(self):
        self.server.requests.append(('GET', self.path, bool(self.connection.getpeercert())))
        if self.path.startswith('/serverinfo'):
            body = f'<root><Permission>{self.server.permission}</Permission></root>'.encode() if self.server.permission is not None else b'<root/>'
            self.reply(200, body)
        else:
            time.sleep(self.server.read_delay)
            status = self.server.read_statuses.pop(0) if self.server.read_statuses else self.server.read_status
            text = self.server.read_texts.pop(0) if self.server.read_texts else self.server.text
            self.reply(status, text)
    def do_POST(self):
        text = self.rfile.read(int(self.headers['Content-Length']))
        self.server.requests.append(('POST', text, bool(self.connection.getpeercert())))
        time.sleep(self.server.write_delay)
        if self.server.write_status == 200:
            self.server.text = text
        self.reply(self.server.write_status)

class ClipboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='mw-clipboard-')
        cls.root = Path(cls.temp.name)
        for name in ['server', 'client', 'wrong']:
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-subj', '/CN=localhost', '-keyout', str(cls.root / (name + '.key')),
                            '-out', str(cls.root / (name + '.pem'))], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.root / 'server.pem', cls.root / 'server.key')
        context.load_verify_locations(cls.root / 'client.pem')
        context.verify_mode = ssl.CERT_REQUIRED
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()
    def setUp(self):
        self.server.permission = FULL
        self.server.text = 'Apollo é🌙\n'.encode()
        self.server.read_status = self.server.write_status = 200
        self.server.read_delay = self.server.write_delay = 0
        self.server.requests = []
        self.server.read_texts = []
        self.server.read_statuses = []
    def run_adapter(self, commands=(), duration=1200, **overrides):
        config = dict(origin=f'https://127.0.0.1:{self.server.server_port}',
                      certificate=str(self.root/'client.pem'), key=str(self.root/'client.key'),
                      serverCertificate=str(self.root/'server.pem'), commands=list(commands), duration=duration)
        config.update(overrides)
        path = self.root/'scenario.json'
        path.write_text(json.dumps(config))
        process = subprocess.run([BINARY, str(path)], capture_output=True, timeout=10, check=True)
        return [json.loads(line) for line in process.stdout.splitlines()]
    def chunk(self, data=b'copied', at=300, **overrides):
        message = dict(type='clipboardchunk', id='paste', index=0, total=1, data=base64.b64encode(data).decode())
        message.update(overrides)
        return {'at': at, 'message': message}
    def test_mutual_tls_and_write_before_chord(self):
        text = 'Bonjour 🌙\n'.encode()
        out = self.run_adapter([self.chunk(text)])
        self.assertTrue(out[0]['write'])
        self.assertEqual(self.server.text, text)
        self.assertEqual([x for x in out if x['type']=='injected'], [{'type':'injected', 'key':86}])
        self.assertTrue(all(r[2] for r in self.server.requests))
    def test_unchanged_read_and_rate_limit(self):
        out = self.run_adapter([{'at': n, 'message': {'type':'clipboardread'}} for n in [250, 300, 350, 1300]], duration=1700)
        chunks = [x for x in out if x['type']=='clipboardchunk']
        self.assertEqual(chunks, []) # initial Apollo contents never overwrite the client
        self.assertEqual(sum(r[0]=='GET' and '/actions/' in r[1] for r in self.server.requests), 2)
    def test_empty_initial_clipboard_never_clears_client(self):
        self.server.text = b''
        out = self.run_adapter([{'at':250, 'message':{'type':'clipboardread'}}])
        self.assertFalse(any(x['type']=='clipboardchunk' for x in out))
    def test_explicit_copy_returns_same_text_after_baseline(self):
        out = self.run_adapter([
            {'at':250, 'message':{'type':'clipboardread'}},
            {'at':500, 'message':{'type':'clipboardcopy'}},
            {'at':1350, 'message':{'type':'clipboardread'}}], duration=1700)
        chunks = [x for x in out if x['type']=='clipboardchunk']
        self.assertEqual(len(chunks), 1)
        self.assertEqual(base64.b64decode(chunks[0]['data']), self.server.text)
        self.assertEqual([x['key'] for x in out if x['type']=='injected'], [67])
    def test_explicit_copy_before_first_poll_is_not_discarded(self):
        out = self.run_adapter([
            {'at':250, 'message':{'type':'clipboardcopy'}},
            {'at':350, 'message':{'type':'clipboardread'}}])
        self.assertEqual(sum(x['type']=='clipboardchunk' for x in out), 1)
    def test_copy_during_initial_read_is_preserved_for_next_poll(self):
        self.server.read_delay = .35
        out = self.run_adapter([
            {'at':250, 'message':{'type':'clipboardread'}},
            {'at':400, 'message':{'type':'clipboardcopy'}},
            {'at':1350, 'message':{'type':'clipboardread'}}], duration=2000)
        self.assertEqual(sum(x['type']=='clipboardchunk' for x in out), 1)
    def test_later_remote_changes_include_intentional_empty_clipboard(self):
        self.server.read_texts = [b'initial', b'changed', b'']
        out = self.run_adapter([{'at':n, 'message':{'type':'clipboardread'}}
                                for n in [250,1350,2450]], duration=2800)
        self.assertEqual([base64.b64decode(x['data']) for x in out if x['type']=='clipboardchunk'],
                         [b'changed', b''])
    def test_copy_survives_transient_read_failure(self):
        self.server.read_statuses = [500,200]
        out = self.run_adapter([
            {'at':250, 'message':{'type':'clipboardcopy'}},
            {'at':350, 'message':{'type':'clipboardread'}},
            {'at':1450, 'message':{'type':'clipboardread'}}], duration=1800)
        self.assertEqual(sum(x['type']=='clipboardchunk' for x in out), 1)
    def test_client_paste_supersedes_pending_copy_and_slow_read(self):
        self.server.read_delay = .4
        out = self.run_adapter([
            {'at':250, 'message':{'type':'clipboardcopy'}},
            {'at':350, 'message':{'type':'clipboardread'}},
            self.chunk(b'client wins', at=450),
            {'at':1450, 'message':{'type':'clipboardread'}}], duration=2100)
        self.assertEqual(self.server.text, b'client wins')
        self.assertFalse(any(x['type']=='clipboardchunk' for x in out))
        self.assertEqual([x['key'] for x in out if x['type']=='injected'],[67,86])
    def test_copy_during_write_reports_busy_instead_of_copying_stale_text(self):
        self.server.write_delay = .4
        out = self.run_adapter([self.chunk(at=250),
            {'at':400, 'message':{'type':'clipboardcopy'}}])
        self.assertTrue(any(x.get('code')=='busy' for x in out))
        self.assertEqual([x['key'] for x in out if x['type']=='injected'], [86])
    def test_permissions_are_independent_and_sunshine_is_silent(self):
        for perm, read, write in [(FULL & ~(1<<16), True, False), (FULL & ~(1<<17), False, True), (None, False, False)]:
            self.server.permission = perm
            out = self.run_adapter([self.chunk()], duration=650)
            self.assertEqual((out[0]['read'], out[0]['write']), (read, write))
            self.assertEqual(any(x['type']=='injected' for x in out), write)
    def test_wrong_pin_or_client_certificate_never_reaches_clipboard(self):
        for override in [dict(serverCertificate=str(self.root/'wrong.pem')),
                         dict(certificate=str(self.root/'wrong.pem'), key=str(self.root/'wrong.key'))]:
            self.server.requests = []
            out = self.run_adapter([self.chunk()], duration=800, **override)
            self.assertFalse(any(x['type']=='injected' for x in out))
            self.assertFalse(any(r[0]=='POST' for r in self.server.requests))
    def test_write_failure_never_pastes_and_denial_disables_writing(self):
        for status in [403, 500, 302]:
            self.server.write_status = status
            out = self.run_adapter([self.chunk()], duration=700)
            self.assertFalse(any(x['type']=='injected' for x in out))
            self.assertTrue(any(x['type']=='clipboarderror' for x in out))
            if status == 403:
                self.assertFalse([x for x in out if x['type']=='clipboardcaps'][-1]['write'])
    def test_stop_during_post_never_injects_and_other_session_works(self):
        self.server.write_delay = .4
        out = self.run_adapter([self.chunk(), {'at':400, 'stop':True}], duration=950)
        self.assertFalse(any(x['type']=='injected' for x in out))
        self.server.write_delay = 0
        out = self.run_adapter([self.chunk()])
        self.assertTrue(any(x['type']=='injected' for x in out))
    def test_replay_invalid_chunks_and_large_unicode(self):
        data = ('é🌙'*7000).encode()
        chunks = [data[i:i+4096] for i in range(0,len(data),4096)]
        commands = [self.chunk(c, at=250+i*5, index=i, total=len(chunks)) for i,c in enumerate(chunks)]
        commands += [self.chunk(at=700), self.chunk(at=750, id='bad', index=1, total=2)]
        out = self.run_adapter(commands)
        self.assertEqual(self.server.text, data)
        self.assertEqual(sum(x['type']=='injected' for x in out), 1)
    def test_oversized_read_is_reported_without_truncation(self):
        self.server.text = b'x' * (256 * 1024 + 1)
        out = self.run_adapter([{'at':250, 'message': {'type':'clipboardread'}}])
        self.assertFalse(any(x['type']=='clipboardchunk' for x in out))
        self.assertTrue(any(x.get('code')=='too_large' for x in out))
    def test_write_timeout_never_injects(self):
        self.server.write_delay = 3.5
        out = self.run_adapter([self.chunk()], duration=4100)
        self.assertFalse(any(x['type']=='injected' for x in out))
        self.assertTrue(any(x.get('code')=='write_failed' for x in out))
    def test_slow_reads_do_not_overlap(self):
        self.server.read_delay = 1.2
        self.run_adapter([{'at':n, 'message': {'type':'clipboardread'}} for n in [250, 500, 1300]], duration=1600)
        self.assertEqual(sum(r[0]=='GET' and '/actions/' in r[1] for r in self.server.requests), 1)

if __name__ == '__main__':
    unittest.main(verbosity=2)
