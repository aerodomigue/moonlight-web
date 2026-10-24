#!/usr/bin/env python3
"""Exercise the real server with a local HTTPS OIDC issuer and fake GameStream PC.

Usage: python3 backend/tests/test_oidc_integration.py build/MoonlightWeb
Requires Python's standard library, openssl, and a built server. All identities,
certificates, state and listening sockets are temporary and bound to loopback.
"""

import base64
import concurrent.futures
import hashlib
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


class Browser:
    def __init__(self, base):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.cookies),
            urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
        )

    def request(self, path, data=None, method=None, cross_site=False, local=False, extra_headers=None):
        headers = {"Sec-Fetch-Site": "cross-site" if cross_site else "same-origin"}
        if not local:
            headers.update({"X-Forwarded-For": "203.0.113.20", "X-Forwarded-Proto": "https"})
        if data is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra_headers or {})
        request = urllib.request.Request(
            self.base + path, data=None if data is None else json.dumps(data).encode(),
            headers=headers, method=method,
        )
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read()
        body = json.loads(raw) if raw and response.headers.get_content_type() == "application/json" else raw
        code, response_headers = response.code, response.headers
        response.close()
        return code, body, response_headers


class Fixture(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # Never log authorization codes, cookies or credentials.

    def reply(self, value, status=200, content_type="application/json"):
        data = json.dumps(value).encode() if isinstance(value, dict) else value
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/authorize?"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            code = secrets.token_urlsafe(24)
            self.server.codes[code] = {
                "subject": "browser-subject", "nonce": query["nonce"][0],
                "challenge": query["code_challenge"][0],
            }
            self.send_response(303)
            self.send_header("Location", query["redirect_uri"][0] + "?" + urllib.parse.urlencode({
                "state": query["state"][0], "code": code,
            }))
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
        elif self.path == "/.well-known/openid-configuration":
            self.reply({
                "issuer": self.server.issuer,
                "authorization_endpoint": self.server.issuer.replace("127.0.0.1", "localhost") + "/authorize",
                "token_endpoint": self.server.issuer + "/token",
                "jwks_uri": self.server.issuer + "/jwks",
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["client_secret_basic"],
            })
        elif self.path == "/jwks":
            self.reply({"keys": [self.server.jwk]})
        elif self.path.startswith("/cancel"):
            gate = getattr(self.server, "cancel_gate", None)
            if gate is not None:
                self.server.cancel_entered.set()
                gate.wait(timeout=10)
            self.reply(b'<root status_code="200"><cancel>1</cancel></root>', content_type="application/xml")
        elif self.path.startswith("/serverinfo"):
            xml = ('<root status_code="200"><hostname>Fixture PC</hostname>'
                   '<uniqueid>fixture-physical-pc</uniqueid><appversion>7.1.431.0</appversion>'
                   '<GfeVersion>3.23.0.74</GfeVersion><PairStatus>1</PairStatus>'
                   '<LocalIP>127.0.0.1</LocalIP><mac>02:11:22:33:44:55</mac>'
                   f'<HttpsPort>{self.server.https_port}</HttpsPort></root>')
            self.reply(xml.encode(), content_type="application/xml")
        else:
            self.reply({}, 404)

    def do_POST(self):
        if self.path != "/token":
            self.reply({}, 404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        form = urllib.parse.parse_qs(body.decode())
        grant = self.server.codes.pop(form.get("code", [""])[0], None)
        basic = "Basic " + base64.b64encode(b"fixture-client:fixture-only-secret").decode()
        if (not grant or self.headers.get("Authorization") != basic
                or form.get("grant_type") != ["authorization_code"]
                or form.get("redirect_uri") != [self.server.callback]
                or b64(hashlib.sha256(form.get("code_verifier", [""])[0].encode()).digest()) != grant["challenge"]):
            self.reply({"error": "invalid_grant"}, 400)
            return
        claims = {
            "iss": self.server.issuer, "sub": grant["subject"], "name": grant["subject"],
            "aud": "fixture-client", "nonce": grant["nonce"],
            "iat": int(time.time()), "exp": int(time.time()) + 300,
        }
        claims.update(grant.get("claims", {}))
        header = {"alg": "RS256", "kid": "fixture-key"}
        payload = (b64(json.dumps(header).encode()) + "." + b64(json.dumps(claims).encode())).encode()
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(self.server.key)],
            input=payload, capture_output=True, check=True,
        ).stdout
        self.reply({"id_token": payload.decode() + "." + b64(signature), "token_type": "Bearer"})


class OidcIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="moonlight-oidc-test-")
        cls.root = Path(cls.temporary.name)
        cls.key, cls.cert = cls.root / "fixture.key", cls.root / "fixture.crt"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(cls.key), "-out", str(cls.cert), "-subj", "/CN=localhost",
            "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ], capture_output=True, check=True)
        cls.key.chmod(0o600)
        modulus = subprocess.run(["openssl", "rsa", "-in", str(cls.key), "-modulus", "-noout"],
                                 capture_output=True, check=True).stdout.decode().strip().split("=", 1)[1]
        cls.issuer_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.issuer_server.socket = context.wrap_socket(cls.issuer_server.socket, server_side=True)
        cls.issuer = "https://127.0.0.1:" + str(cls.issuer_server.server_port)
        cls.issuer_server.issuer = cls.issuer
        cls.issuer_server.key = cls.key
        cls.issuer_server.codes = {}
        cls.issuer_server.jwk = {"kty": "RSA", "kid": "fixture-key", "alg": "RS256", "use": "sig",
                                 "n": b64(bytes.fromhex(modulus)), "e": "AQAB"}
        cls.pc = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        cls.pc.https_port = cls.issuer_server.server_port
        cls.issuer_server.https_port = cls.issuer_server.server_port
        for server in (cls.issuer_server, cls.pc):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.issuer_server, cls.pc):
            server.shutdown()
            server.server_close()
        cls.temporary.cleanup()

    def setUp(self):
        self.state = Path(tempfile.mkdtemp(dir=self.root))
        self.process = None
        self.log = None

    def tearDown(self):
        self.stop()

    def stop(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        if self.log:
            self.log.close()
            self.log = None

    def start(self, methods="pin,sso", trust_issuer=True, secret_file=False):
        self.stop()
        def port():
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                return listener.getsockname()[1]
        tls, http, ws = port(), port(), port()
        self.base = "https://127.0.0.1:" + str(tls)
        self.issuer_server.callback = self.base + "/api/auth/oidc/callback"
        settings = self.state / "settings.json"
        config = json.loads(settings.read_text()) if settings.exists() else {}
        config.update({"http_port": http, "https_port": tls, "native_host_enabled": False,
                       "setup_completed": True, "internet_access_enabled": False,
                       "auto_ip_detection": False, "upnp_enabled": False})
        settings.write_text(json.dumps(config))
        env = os.environ.copy()
        env.update({
            "XDG_CONFIG_HOME": str(self.state / "config"), "XDG_DATA_HOME": str(self.state / "data"),
            "XDG_CACHE_HOME": str(self.state / "cache"), "QT_QPA_PLATFORM": "offscreen",
            "MW_AUTH_METHODS": methods, "MW_OIDC_ISSUER": self.issuer,
            "MW_OIDC_CLIENT_ID": "fixture-client", "MW_OIDC_CLIENT_SECRET": "fixture-only-secret",
            "MW_OIDC_ADMIN_SUBJECTS": "admin-subject", "MW_PUBLIC_URL": self.base,
            "MW_REVERSE_PROXY": "1", "MW_TRUSTED_PROXIES": "127.0.0.1/32",
            "MW_NO_TELEMETRY": "1", "MW_CERT_PEM": str(self.cert), "MW_CERT_KEY": str(self.key),
            "SSL_CERT_FILE": str(self.cert),
            "MW_OIDC_CA_FILE": str(self.cert) if trust_issuer else "",
        })
        env.pop("MW_OIDC_CLIENT_SECRET_FILE", None)
        if secret_file:
            secret = self.state / "client-secret"
            secret.write_text("fixture-only-secret\n")
            secret.chmod(0o600)
            env["MW_OIDC_CLIENT_SECRET_FILE"] = str(secret)
            env["MW_OIDC_CLIENT_SECRET"] = "wrong-environment-secret"

        self.log = (self.state / "server.log").open("ab")
        self.process = subprocess.Popen([BINARY, "--autostart", "--config", str(settings), "--ws-port", str(ws)],
                                        env=env, stdout=self.log, stderr=self.log)
        browser = Browser(self.base)
        for _ in range(150):
            if self.process.poll() is not None:
                self.fail("Isolated server exited before becoming healthy")
            try:
                if browser.request("/api/health")[0] == 200:
                    return browser
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        self.fail("Isolated server did not become healthy")

    def prepare(self, browser, subject="alice-sub", claims=None, remember=True):
        status, body, _ = browser.request("/api/auth/oidc/prepare", {"remember": remember})
        self.assertEqual(status, 200, "Local HTTPS issuer discovery failed")
        params = urllib.parse.parse_qs(urllib.parse.urlparse(body["authorization_url"]).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        code = secrets.token_urlsafe(24)
        self.issuer_server.codes[code] = {"nonce": params["nonce"][0], "challenge": params["code_challenge"][0],
                                         "subject": subject, "claims": claims or {}}
        return "/api/auth/oidc/callback?" + urllib.parse.urlencode({"code": code, "state": params["state"][0]})

    def login(self, browser, subject="alice-sub", remember=True):
        callback = self.prepare(browser, subject, remember=remember)
        status, _, headers = browser.request(callback, cross_site=True)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/")
        status, body, _ = browser.request("/api/auth/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["authenticated"])
        return body

    def test_oidc_accounts_and_independent_machine_registrations(self):
        alice = self.start()
        bob = Browser(self.base)
        alice_status = self.login(alice)
        bob_status = self.login(bob, "bob-sub")
        self.assertNotEqual(alice_status["user"]["id"], bob_status["user"]["id"])
        self.assertFalse(alice_status["is_localhost"])
        token_cookie = next(c for c in alice.cookies if c.name == "__Host-mw_session")
        self.assertTrue(token_cookie.value.startswith("v2."))
        self.assertEqual(Browser(self.base).request("/api/hosts", extra_headers={"Cookie": "mw_session=" + token_cookie.value})[0], 401)
        self.assertEqual(Browser(self.base).request("/api/hosts", extra_headers={"Cookie": "__host-mw_session=" + token_cookie.value})[0], 401)

        address = "127.0.0.1:" + str(self.pc.server_port)
        status, body, _ = alice.request("/api/hosts/manual", {"address": address})
        self.assertEqual(status, 200)
        alice_pc = body["hosts"][0]["uuid"]
        self.assertEqual(body["hosts"][0]["pairState"], "not_paired")
        status, body, _ = bob.request("/api/hosts/manual", {"address": address})
        self.assertEqual(status, 200)
        bob_pc = body["hosts"][0]["uuid"]
        self.assertNotEqual(alice_pc, bob_pc)
        self.assertEqual([h["uuid"] for h in alice.request("/api/hosts")[1]["hosts"]], [alice_pc])
        self.assertEqual([h["uuid"] for h in bob.request("/api/hosts")[1]["hosts"]], [bob_pc])
        for suffix in ("/apps", "/appasset?appid=1", "/backend", "/seats", "/profiles", "/lobbies"):
            self.assertEqual(bob.request("/api/hosts/" + alice_pc + suffix)[0], 404)
        for suffix, data in (("/wol", {}), ("/wol-config", {"address": "10.2.10.20", "mac": "02:11:22:33:44:55"}),
                             ("/name", {"name": "Intruder"}), ("/pair/start", {}), ("/start", {"appId": 1}),
                             ("/quit", {}), ("/stop-session", {}), ("/restart", {}), ("/backend", {"type": "wolf", "apiUrl": "http://127.0.0.1"})):
            self.assertEqual(bob.request("/api/hosts/" + alice_pc + suffix, data)[0], 404)
        self.assertEqual(bob.request("/api/hosts/" + alice_pc, method="DELETE")[0], 404)
        # A fresh SSO session cannot enter an unowned stream socket.
        websocket = {"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13",
                     "Sec-WebSocket-Key": base64.b64encode(b"0123456789ABCDEF").decode(), "Origin": self.base}
        self.assertEqual(bob.request("/ws", extra_headers=websocket)[0], 403)
        self.assertEqual(bob.request("/ws1", extra_headers=websocket)[0], 403)
        self.assertEqual(bob.request("/api/share/status")[0], 403)
        administrator = Browser(self.base)
        self.assertTrue(self.login(administrator, "admin-subject")["is_localhost"])
        self.assertEqual(administrator.request("/api/auth/pin", {"user_id": "local-owner"})[0], 403)
        admin_key = administrator.request("/api/admin/token")[1]["token"]
        owner_pin = administrator.request("/api/auth/pin", {"user_id": "local-owner"},
                                          extra_headers={"X-MW-Admin-Key": admin_key})[1]["pin"]
        local_owner = Browser(self.base)
        self.assertEqual(local_owner.request("/api/auth/validate", {"pin": owner_pin})[0], 200)
        self.assertEqual(local_owner.request("/api/share/status?host=" + alice_pc)[0], 404)
        # Appairing on one registration never gives the other its certificate.
        self.assertEqual(alice.request("/api/hosts/" + alice_pc + "/pair/start", {})[0], 200)
        self.assertEqual(bob.request("/api/hosts/" + bob_pc + "/pair/start", {})[0], 200)

        self.assertEqual(alice.request("/api/hosts/" + alice_pc + "/name", {"name": "Alice private"})[0], 200)
        self.assertNotEqual(bob.request("/api/hosts")[1]["hosts"][0].get("customName"), "Alice private")
        pin = alice.request("/api/auth/pin", {})[1]["pin"]
        pin_browser = Browser(self.base)
        self.assertEqual(pin_browser.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.assertEqual(pin_browser.request("/api/auth/status")[1]["user"]["id"], alice_status["user"]["id"])
        self.assertEqual(Browser(self.base).request("/api/auth/validate", {"pin": pin})[0], 401)
        self.assertEqual(bob.request("/api/auth/pin", {"user_id": alice_status["user"]["id"]})[0], 403)
        self.assertEqual(alice.request("/api/admin/token")[1].get("token", ""), "")
        admin = Browser(self.base)
        self.assertTrue(self.login(admin, "admin-subject")["is_localhost"])
        self.assertTrue(admin.request("/api/admin/token")[1]["token"])
        # A role grants administration; it does not merge personal machine lists.
        self.assertEqual(admin.request("/api/hosts")[1]["hosts"], [])
        self.assertEqual(bob.request("/api/auth/logout", {})[0], 200)
        self.assertEqual(bob.request("/api/hosts")[0], 401)
        self.assertEqual(alice.request("/api/hosts")[0], 200)
        self.start()  # Reload the same store, with new listening ports.
        alice.base = self.base
        self.assertEqual(alice.request("/api/auth/status")[1]["user"]["id"], alice_status["user"]["id"])
        self.assertEqual(alice.request("/api/hosts")[1]["hosts"][0]["uuid"], alice_pc)

    def test_state_cookie_replay_and_invalid_token(self):
        alice = self.start()
        callback = self.prepare(alice)
        status, _, headers = Browser(self.base).request(callback, cross_site=True)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/?auth_error=sso")
        self.assertEqual(alice.request(callback, cross_site=True)[2]["Location"], "/")
        self.assertEqual(alice.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
        invalid = Browser(self.base)
        callback = self.prepare(invalid, claims={"nonce": "wrong-nonce"})
        self.assertEqual(invalid.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
        self.assertFalse(invalid.request("/api/auth/status")[1]["authenticated"])

    def test_account_switch_and_ephemeral_sessions(self):
        browser = self.start()
        alice = self.login(browser)
        before = next(c.value for c in browser.cookies if c.name == "__Host-mw_session")
        bob = self.login(browser, "bob-sub", remember=False)
        self.assertNotEqual(alice["user"]["id"], bob["user"]["id"])
        self.assertEqual(Browser(self.base).request("/api/hosts", extra_headers={"Cookie": "__Host-mw_session=" + before})[0], 401)
        cookie = next(c for c in browser.cookies if c.name == "__Host-mw_session")
        self.assertIsNone(cookie.expires)
        self.assertEqual(browser.request("/api/auth/logout", {})[0], 200)
        self.assertFalse(browser.request("/api/auth/status")[1]["authenticated"])
        self.login(browser, remember=False)
        self.start()
        browser.base = self.base
        self.assertFalse(browser.request("/api/auth/status")[1]["authenticated"])

    def test_secret_file_and_tls_validation(self):
        browser = self.start(secret_file=True)
        self.login(browser)
        browser = self.start(trust_issuer=False)
        self.assertEqual(browser.request("/api/auth/oidc/prepare", {})[0], 502)

    def test_async_stop_reserves_only_its_physical_pc(self):
        alice = self.start()
        bob = Browser(self.base)
        self.login(alice)
        self.login(bob, "bob-sub")
        address = "127.0.0.1:" + str(self.pc.server_port)
        alice_pc = alice.request("/api/hosts/manual", {"address": address})[1]["hosts"][0]["uuid"]
        bob_pc = bob.request("/api/hosts/manual", {"address": address})[1]["hosts"][0]["uuid"]
        self.issuer_server.cancel_gate = threading.Event()
        self.issuer_server.cancel_entered = threading.Event()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                stopped = executor.submit(alice.request, "/api/hosts/" + alice_pc + "/stop-session", {})
                self.assertTrue(self.issuer_server.cancel_entered.wait(timeout=5))
                self.assertEqual(bob.request("/api/hosts/" + bob_pc + "/start", {"appId": 1})[0], 409)
                self.assertEqual(alice.request("/api/hosts/" + alice_pc, method="DELETE")[0], 409)
                self.issuer_server.cancel_gate.set()
                self.assertEqual(stopped.result(timeout=10)[0], 200)
            # The async callback must release its lease rather than leak a cycle.
            time.sleep(0.1)
            self.assertNotEqual(bob.request("/api/hosts/" + bob_pc + "/start", {"appId": 1})[0], 409)
        finally:
            self.issuer_server.cancel_gate.set()
            self.issuer_server.cancel_gate = None

    def test_authentication_modes(self):
        browser = self.start("sso")
        status = browser.request("/api/auth/status")[1]
        self.assertTrue(status["sso_enabled"])
        self.assertFalse(status["pin_enabled"])
        self.assertEqual(browser.request("/api/auth/validate", {"pin": "123456"})[0], 403)
        self.assertEqual(browser.request("/api/auth/validate", {"certificate": "anything"})[0], 403)
        self.login(browser, remember=True)
        self.assertEqual(browser.request("/api/auth/pin", {})[0], 403)
        self.start("pin")
        browser.base = self.base
        self.assertFalse(browser.request("/api/auth/status")[1]["authenticated"])
        self.assertEqual(browser.request("/api/auth/oidc/prepare", {})[0], 404)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    BINARY = str(Path(sys.argv.pop()).resolve())
    unittest.main(verbosity=2)
