#!/usr/bin/env python3
"""Assert actual GameStream HTTPS/RTSP requests against loopback fixtures.

No video connection or real host is used. ANNOUNCE is rejected deliberately after
recording its numeric preferences; session keys and cookies are never printed.
"""
import importlib.util
from pathlib import Path
import re
import socketserver
import sys
import threading
import time
import urllib.parse

spec = importlib.util.spec_from_file_location('oidc_fixture', Path(__file__).with_name('test_oidc_integration.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.BINARY = str(Path(sys.argv[1]).resolve())


class Rtsp(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        first = self.rfile.readline().decode().strip()
        if not first: return
        headers = {}
        while True:
            line = self.rfile.readline().decode().strip()
            if not line: break
            key, value = line.split(':', 1)
            headers[key.lower()] = value.strip()
        body = self.rfile.read(int(headers.get('content-length', '0')))
        method = first.split()[0]
        self.server.methods.append(method)
        status = 200
        payload = b''
        if method == 'DESCRIBE':
            payload = (b'v=0\r\ns=fixture\r\na=x-ss-general.featureFlags:0\r\n'
                       b'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n'
                       b'm=audio 0 RTP/AVP 97\r\na=rtpmap:97 opus/48000/2\r\n')
        elif method == 'ANNOUNCE':
            self.server.attributes = {k:v.strip() for k,v in re.findall(rb'a=([^:\r\n]+):([^\r\n]+)', body)}
            status = 500  # Stop before starting control/video/audio channels.
        response = (f'RTSP/1.0 {status} Fixture\r\nCSeq: {headers.get("cseq", "1")}\r\n'
                    f'Session: fixture\r\nTransport: unicast;server_port=50000-50001\r\n'
                    f'Content-Length: {len(payload)}\r\n\r\n').encode() + payload
        self.wfile.write(response)


class Host(fixture.Fixture):
    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        if parts.path in ('/launch', '/resume'):
            self.server.requests.append((parts.path, urllib.parse.parse_qs(parts.query)))
            url = f'rtsp://127.0.0.1:{self.server.rtsp_port}'
            self.reply(f'<root status_code="200"><gamesession>1</gamesession><resume>1</resume><sessionUrl0>{url}</sessionUrl0></root>'.encode(), content_type='application/xml')
        elif parts.path == '/serverinfo':
            self.reply(('<root status_code="200"><hostname>Stream fixture</hostname>'
                        '<uniqueid>stream-fixture</uniqueid><appversion>7.1.431.-1</appversion>'
                        '<GfeVersion>3.23.0.74</GfeVersion><PairStatus>1</PairStatus>'
                        '<LocalIP>127.0.0.1</LocalIP><mac>02:11:22:33:44:55</mac>'
                        f'<HttpsPort>{self.server.https_port}</HttpsPort>'
                        f'<currentgame>{self.server.current_game}</currentgame>'
                        '<state>SUNSHINE_SERVER_BUSY</state></root>').encode(), content_type='application/xml')
        else:
            super().do_GET()


def run():
    fixture.OidcIsolation.setUpClass()
    try:
        for existing, measured in [(False, 240000), (True, 239760), (True, 0)]:
            rtsp = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Rtsp)
            rtsp.daemon_threads = True
            threading.Thread(target=rtsp.serve_forever, daemon=True).start()
            rtsp.attributes = {}
            rtsp.methods = []
            case = fixture.OidcIsolation('test_authentication_modes')
            case.setUp()
            try:
                for server in (case.pc, case.issuer_server):
                    server.RequestHandlerClass = Host
                    server.current_game = 42 if existing else 0
                    server.rtsp_port = rtsp.server_address[1]
                    server.requests = []
                case.start()
                admin, headers = case.administrator()
                pin = admin.request('/api/auth/pin', {'user_id':'local-owner'}, extra_headers=headers)[1]['pin']
                browser = fixture.Browser(case.base)
                assert browser.request('/api/auth/validate', {'pin':pin, 'public_key':browser.public_key})[0] == 200
                status, body, _ = browser.request('/api/hosts/manual', {'address': f'127.0.0.1:{case.pc.server_port}'}, local=True)
                assert status == 200, (status, body.get('error'))
                host = next(h for h in body['hosts'] if h['name'] == 'Stream fixture')
                # Seed only this temporary registration's server certificate.
                # Pairing cryptography is covered elsewhere; the fake PC accepts
                # this isolated service identity and never reaches a real PC.
                case.stop()
                import configparser
                ini = configparser.ConfigParser(interpolation=None)
                ini.optionxform = str
                settings = case.state / 'config/MoonlightWeb/MoonlightWeb.conf'
                ini.read(settings)
                for section in ini.sections():
                    for key, value in list(ini[section].items()):
                        if key.endswith('\\uuid') and value == host['uuid']:
                            cert = case.cert.read_text().replace('\n', '\\n')
                            ini[section][key[:-4] + 'serverCert'] = '@ByteArray(' + cert + ')'
                with settings.open('w') as output: ini.write(output)
                case.start()
                admin, headers = case.administrator()
                pin = admin.request('/api/auth/pin', {'user_id':'local-owner'}, extra_headers=headers)[1]['pin']
                browser = fixture.Browser(case.base)
                assert browser.request('/api/auth/validate', {'pin':pin, 'public_key':browser.public_key})[0] == 200
                for _ in range(200):
                    fresh = browser.request('/api/hosts')[1]['hosts']
                    if any(h.get('appVersion') == '7.1.431.-1' for h in fresh): break
                    time.sleep(.05)
                else: raise AssertionError('Fixture host metadata did not refresh')
                status, result, _ = browser.request('/api/hosts/' + host['uuid'] + '/start', {
                    'appId': 42, 'stream_height': 2160, 'stream_aspect': '3840:2160',
                    'stream_fps': 240, 'stream_bitrate': 100000, 'client_refresh_mhz': measured, 'video_codec': 'h264',
                    'transport_mode': 'wss', 'client_uniqueid': 'fixture-viewer',
                }, local=True)
                assert status >= 400, 'Fixture must stop the stream at ANNOUNCE'
                requests = case.issuer_server.requests
                assert requests, ('No GameStream launch/resume observed', status, result.get('error'), host.get('pairState'))
                path, query = requests[0]
                assert path == ('/resume' if existing else '/launch'), path
                assert query.get('mode') == ['3840x2160x240'], 'GameStream mode lost'
                assert query.get('sops') == ['1'], 'Display optimization missing'
                a = rtsp.attributes
                if not a:
                    for line in (case.state / 'server.log').read_text().splitlines():
                        if re.search(r'Invalid|invalid|RTSP|LiStart|stage|resolution|refresh|fps', line) and not re.search(r'key|token|secret|cookie|URL:', line, re.I):
                            print(line[:250])
                assert a, ('No RTSP ANNOUNCE observed', rtsp.methods, result.get('error'))
                for name, value in [(b'x-nv-video[0].clientViewportWd', b'3840'),
                                    (b'x-nv-video[0].clientViewportHt', b'2160'),
                                    (b'x-nv-video[0].maxFPS', b'240'),
                                    (b'x-ml-video.configuredBitrateKbps', b'100000'),
                                    (b'x-nv-vqos[0].bw.maximumBitrateKbps', b'80000'),
                                    (b'x-nv-video[0].clientRefreshRateX100', str((measured + 5)//10 if measured else 24000).encode())]:
                    assert a.get(name) == value, f'Incorrect RTSP {name.decode()}: {a.get(name)!r}'
                print(f'PASS: {path}/RTSP preserve 3840x2160, 240 FPS, configured 100000 kbit/s; client refresh {measured or 240000} mHz.')
            finally:
                case.tearDown()
                rtsp.shutdown()
                rtsp.server_close()
    finally:
        fixture.OidcIsolation.tearDownClass()


if __name__ == '__main__':
    run()
