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
            self.reply(self.server.read_status, self.server.text)
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
        self.assertEqual(len(chunks), 1)
        self.assertEqual(base64.b64decode(chunks[0]['data']), self.server.text)
        self.assertEqual(sum(r[0]=='GET' and '/actions/' in r[1] for r in self.server.requests), 2)
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
    def test_slow_reads_do_not_overlap(self):
        self.server.read_delay = 1.2
        self.run_adapter([{'at':n, 'message': {'type':'clipboardread'}} for n in [250, 500, 1300]], duration=1600)
        self.assertEqual(sum(r[0]=='GET' and '/actions/' in r[1] for r in self.server.requests), 1)

if __name__ == '__main__':
    unittest.main(verbosity=2)
