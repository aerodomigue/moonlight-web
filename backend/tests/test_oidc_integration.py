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
                "subject": query.get("fixture_subject", [getattr(self.server, "browser_subject", "browser-subject")])[0], "nonce": query["nonce"][0],
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
            gate = getattr(self.server, "info_gate", None)
            if gate is not None:
                self.server.info_entered.set()
                gate.wait(timeout=10)
            self.server.fetch_marker = self.headers.get("X-MW-Internal-Fetch")
            xml = ('<root status_code="200"><hostname>Fixture PC</hostname>'
                   '<uniqueid>fixture-physical-pc</uniqueid><appversion>7.1.431.0</appversion>'
                   '<GfeVersion>3.23.0.74</GfeVersion><PairStatus>1</PairStatus>'
                   '<LocalIP>127.0.0.1</LocalIP><mac>02:11:22:33:44:55</mac>'
                   f'<HttpsPort>{self.server.https_port}</HttpsPort></root>')
            xml = xml.replace("fixture-physical-pc", getattr(self.server, "physical_uuid", "fixture-physical-pc"))
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
        gate = getattr(self.server, "token_gate", None)
        if gate is not None:
            self.server.token_entered.set()
            gate.wait(timeout=10)
        claims = {
            "iss": self.server.issuer, "sub": grant["subject"], "name": grant["subject"],
            "aud": "fixture-client", "nonce": grant["nonce"],
            "iat": int(time.time()), "exp": int(time.time()) + 300,
            "moonlight_role": getattr(self.server, "roles", {}).get(grant["subject"],
                "internal_admin" if grant["subject"] == "admin-subject" else "internal_user"),
        }
        claims.update(grant.get("claims", {}))
        if claims.pop("_fixture_omit_role", False):
            claims.pop("moonlight_role", None)
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
        self.issuer_server.roles = {}

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

    def start(self, methods="pin,sso", trust_issuer=True, secret_file=False, trust_proxy=True):
        self.stop()
        def port():
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                return listener.getsockname()[1]
        if not hasattr(self, "ports"):
            ports = set()
            while len(ports) < 3:
                ports.add(port())
            self.ports = tuple(ports)
        tls, http, ws = self.ports
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
            "MW_REVERSE_PROXY": "1", "MW_TRUSTED_PROXIES": "127.0.0.1/32" if trust_proxy else "192.0.2.1/32",
            "MW_NO_TELEMETRY": "1", "MW_CERT_PEM": str(self.cert), "MW_CERT_KEY": str(self.key),
            "MW_SERVICE": "1",  # The fixture must never rewrite desktop launchers.
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

    def prepare(self, browser, subject="alice-sub", claims=None, remember=True, path="/api/auth/oidc/prepare", headers=None, public_key=None):
        payload = {"remember": remember}
        if public_key is not None:
            payload["public_key"] = public_key
        status, body, _ = browser.request(path, payload, extra_headers=headers)
        self.assertEqual(status, 200, "Local HTTPS issuer discovery failed")
        params = urllib.parse.parse_qs(urllib.parse.urlparse(body["authorization_url"]).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertIn("openid", params["scope"][0].split())
        self.last_scopes = params["scope"][0]
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

    def test_fresh_pin_and_sso_allow_identity_renewal_only_for_the_bound_browser(self):
        admin = self.start()
        def browser_key():
            private = subprocess.check_output(["openssl", "genpkey", "-algorithm", "EC",
                                               "-pkeyopt", "ec_paramgen_curve:P-256"], stderr=subprocess.DEVNULL)
            public = subprocess.check_output(["openssl", "pkey", "-pubout", "-outform", "DER"],
                                              input=private, stderr=subprocess.DEVNULL)
            return base64.b64encode(public).decode()
        public = browser_key()
        wrong = browser_key()
        browser = Browser(self.base)
        path = "/api/auth/identity/renew"
        denied = browser.request(path, {"public_key": public})
        self.assertEqual(denied[0], 401)
        self.assertEqual(denied[2]["Cache-Control"], "no-store")
        self.login(admin, "admin-subject")
        key = admin.request("/api/admin/token")[1]["token"]
        pin = admin.request("/api/auth/pin", {"user_id": "local-owner"},
                            extra_headers={"X-MW-Admin-Key": key})[1]["pin"]
        status, login, _ = browser.request("/api/auth/validate", {"pin": pin, "public_key": public})
        self.assertEqual(status, 200)
        self.assertTrue(browser.request("/api/auth/status")[1]["identity_renewal_available"])
        self.assertEqual(browser.request(path, {"public_key": wrong})[0], 409)
        self.assertEqual(browser.request(path, {"public_key": public}, cross_site=True)[0], 403)
        for _ in range(2):
            code, identity, headers = browser.request(path, {"public_key": public})
            self.assertEqual(code, 200)
            self.assertEqual(identity["host_id"], login["host_id"])
            self.assertEqual(identity["host_public_key"], login["host_public_key"])
            self.assertEqual(headers["Cache-Control"], "no-store")
        # A runtime auth-config change cancels grants even when sessions stay valid.
        self.assertEqual(admin.request("/api/admin/auth-config", {},
                                       extra_headers={"X-MW-Admin-Key": key})[0], 200)
        self.assertEqual(browser.request(path, {"public_key": public})[0], 403)
        self.assertTrue(browser.request("/api/auth/status")[1]["authenticated"])
        callback = self.prepare(browser, public_key=public)
        self.assertEqual(browser.request(path, {"public_key": public})[0], 403)
        self.assertEqual(browser.request(callback, cross_site=True)[2]["Location"], "/")
        self.assertEqual(browser.request(path, {"public_key": public})[0], 200)
        self.assertTrue(browser.request("/api/auth/status")[1]["identity_renewal_available"])
        # A restart retains the remembered session, never its fresh-login grant.
        self.start()
        browser.base = self.base
        self.assertTrue(browser.request("/api/auth/status")[1]["authenticated"])
        self.assertFalse(browser.request("/api/auth/status")[1]["identity_renewal_available"])
        self.assertEqual(browser.request(path, {"public_key": public})[0], 403)

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
        self.assertEqual(self.pc.fetch_marker, "1")
        alice_pc = body["hosts"][0]["uuid"]
        self.assertEqual(body["hosts"][0]["pairState"], "not_paired")
        status, body, _ = bob.request("/api/hosts/manual", {"address": address})
        self.assertEqual(status, 200)
        bob_pc = body["hosts"][0]["uuid"]
        self.assertNotEqual(alice_pc, bob_pc)
        self.assertEqual(alice.request("/api/hosts/" + alice_pc + "/backend",
                                       {"type": "native", "apiUrl": "http://127.0.0.1"})[0], 403)
        self.assertNotEqual(alice.request("/api/hosts")[1]["hosts"][0].get("backendType"), "native")

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
        before = alice.request("/api/hosts")[1]["hosts"]
        self.pc.physical_uuid = alice_pc
        try:
            # A hostile legacy host must not overwrite or disclose a private registration.
            self.assertEqual(local_owner.request("/api/hosts/manual", {"address": address})[0], 409)
            after = alice.request("/api/hosts")[1]["hosts"]
            self.assertEqual(len(after), len(before))
            for field in ("uuid", "name", "customName", "port"):
                self.assertEqual(after[0][field], before[0][field])
            self.assertEqual(local_owner.request("/api/hosts")[1]["hosts"], [])
        finally:
            self.pc.physical_uuid = "fixture-physical-pc"

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

    def test_internal_host_fetch_does_not_inherit_loopback_admin(self):
        browser = self.start(trust_proxy=False)
        headers = {"Host": "localhost:" + self.base.rsplit(":", 1)[1]}
        status, body, _ = browser.request("/api/admin/token", local=True, extra_headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(body["token"])
        headers["X-MW-Internal-Fetch"] = "1"
        self.assertEqual(browser.request("/api/admin/token", local=True, extra_headers=headers)[0], 403)
        status = browser.request("/api/auth/status", local=True, extra_headers=headers)[1]
        self.assertFalse(status["authenticated"])
        self.assertFalse(status["is_localhost"])

    def administrator(self):
        browser = Browser(self.base)
        self.login(browser, "admin-subject")
        key = browser.request("/api/admin/token")[1]["token"]
        return browser, {"X-MW-Admin-Key": key}

    def test_admin_accounts_roles_and_machine_reassignment(self):
        self.start()
        admin, headers = self.administrator()
        make = lambda name, role="user": admin.request("/api/admin/users", {"name": name, "role": role}, extra_headers=headers)[1]["user"]
        alice = make("Local Alice")
        bob = make("Local Bob")
        root = make("Local administrator", "admin")
        self.assertTrue(alice["id"].startswith("local-"))
        self.assertEqual(admin.request("/api/admin/users", {"name": "No CSRF"})[0], 403)
        path = "/api/admin/users/" + alice["id"]
        code, body, _ = admin.request(path + "/pin", {}, extra_headers=headers)
        self.assertEqual(code, 200)
        self.assertEqual(body["expires_in"], 300)
        visitor = Browser(self.base)
        self.assertEqual(visitor.request("/api/auth/validate", {"pin": body["pin"], "remember": True})[0], 200)
        self.assertEqual(visitor.request("/api/auth/status")[1]["user"]["id"], alice["id"])
        self.assertEqual(visitor.request("/api/admin/users")[0], 403)
        self.assertEqual(visitor.request("/api/admin/auth-config")[0], 403)
        self.assertEqual(visitor.request("/api/auth/admin-unlock", {"password": "irrelevant"})[0], 403)
        self.assertEqual(visitor.request("/api/admin/users", {"name": "Privilege escalation"})[0], 403)
        self.assertEqual(visitor.request(path, method="DELETE")[0], 403)
        address = "127.0.0.1:" + str(self.pc.server_port)
        source = visitor.request("/api/hosts/manual", {"address": address})[1]["hosts"][0]["uuid"]
        self.assertEqual(admin.request(path + "/hosts")[1]["hosts"][0]["uuid"], source)
        self.assertEqual(visitor.request("/api/hosts/" + source + "/pair/start", {})[0], 200)
        for _ in range(100):
            code, body, _ = admin.request("/api/admin/hosts/" + source + "/duplicate", {"user_id": bob["id"]}, extra_headers=headers)
            if code != 409:
                break
            time.sleep(.03)
        self.assertEqual(code, 200)
        copied = body["host"]["uuid"]
        self.assertNotEqual(source, copied)
        self.assertEqual(admin.request("/api/admin/hosts/" + source + "/duplicate", {"user_id": bob["id"]}, extra_headers=headers)[0], 409)
        self.assertEqual(visitor.request("/api/hosts/" + copied, method="DELETE")[0], 404)
        code, body, _ = admin.request("/api/admin/hosts/" + source + "/transfer", {"user_id": root["id"]}, extra_headers=headers)
        self.assertEqual(code, 200)
        moved = body["host"]["uuid"]
        self.assertEqual(visitor.request("/api/hosts")[1]["hosts"], [])
        self.assertEqual(visitor.request("/api/hosts/" + moved + "/apps")[0], 404)
        self.assertEqual(len(admin.request("/api/admin/users/" + bob["id"] + "/hosts")[1]["hosts"]), 1)
        # Both copies keep the same seat identity, including across a transfer.
        import configparser
        ini = configparser.ConfigParser(interpolation=None)
        ini.optionxform = str
        config = self.state / "config/MoonlightWeb/MoonlightWeb.conf"
        ini.read(config)
        entries = {}
        for section in ini.sections():
            for key, value in ini[section].items():
                if key.endswith("\\uuid"):
                    prefix = key[:-4]
                    entries[value] = ini[section].get(prefix + "identitySeat", "")
        self.assertEqual(entries[copied], entries[moved])
        self.assertEqual(entries[copied], source)
        self.assertEqual(admin.request("/api/admin/hosts/" + moved, method="DELETE", extra_headers=headers)[0], 200)
        self.assertEqual(len(admin.request("/api/admin/users/" + bob["id"] + "/hosts")[1]["hosts"]), 1)
        # A local administrator obtains the same role through PIN.
        pin = admin.request("/api/admin/users/" + root["id"] + "/pin", {}, extra_headers=headers)[1]["pin"]
        local_admin = Browser(self.base)
        self.assertEqual(local_admin.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.assertFalse(local_admin.request("/api/admin/token")[1].get("token"))
        self.assertFalse(local_admin.request("/api/auth/status")[1]["is_localhost"])
        self.assertEqual(admin.request("/api/admin/password", {"password": "fixture-admin-password", "enabled": True, "internet": True}, extra_headers=headers)[0], 200)
        self.assertEqual(local_admin.request("/api/auth/admin-unlock", {"password": "fixture-admin-password"})[0], 200)
        self.assertTrue(local_admin.request("/api/auth/status")[1]["is_localhost"])
        self.assertEqual(admin.request(path, {"enabled": False}, extra_headers=headers)[0], 200)
        self.assertFalse(visitor.request("/api/auth/status")[1]["authenticated"])
        self.assertEqual(admin.request(path + "/pin", {}, extra_headers=headers)[0], 409)
        self.assertEqual(admin.request("/api/admin/users/local-owner", {"enabled": False}, extra_headers=headers)[0], 403)
        self.assertEqual(admin.request("/api/admin/users/local-owner", method="DELETE", extra_headers=headers)[0], 403)
        self.assertEqual(admin.request("/api/admin/users/" + bob["id"], method="DELETE", extra_headers=headers)[0], 200)
        self.assertEqual(admin.request("/api/admin/users/" + bob["id"] + "/hosts")[0], 404)
        self.assertEqual(local_admin.request("/api/admin/users")[0], 200)
        self.start()
        local_admin.base = self.base
        self.assertTrue(local_admin.request("/api/auth/status")[1]["is_localhost"])

    def test_disabled_local_admin_keeps_its_assigned_role(self):
        self.start()
        admin, headers = self.administrator()
        user = admin.request("/api/admin/users", {"name": "Disabled administrator", "role": "admin"}, extra_headers=headers)[1]["user"]
        path = "/api/admin/users/" + user["id"]
        self.assertEqual(admin.request(path, {"enabled": False}, extra_headers=headers)[0], 200)
        row = next(u for u in admin.request("/api/admin/users")[1]["users"] if u["id"] == user["id"])
        self.assertFalse(row["enabled"])
        self.assertEqual(row["role"], "admin")
        self.assertEqual(admin.request(path, {"name": "Still administrator", "enabled": True}, extra_headers=headers)[0], 200)
        self.assertEqual(next(u for u in admin.request("/api/admin/users")[1]["users"] if u["id"] == user["id"])["role"], "admin")

    def test_admin_auth_configuration_runtime_and_persistence(self):
        browser = self.start()
        self.login(browser)
        admin, headers = self.administrator()
        config = admin.request("/api/admin/auth-config")[1]
        self.assertTrue(config["secret_configured"])
        self.assertNotIn("client_secret", config)
        self.assertEqual(admin.request("/api/admin/auth-config", {"pin": False, "sso": False}, extra_headers=headers)[0], 400)
        self.assertEqual(admin.request("/api/admin/auth-config/test", {}, extra_headers=headers)[0], 200)
        self.assertEqual(admin.request("/api/admin/auth-config/test", {"issuer": "http://not-https.invalid"}, extra_headers=headers)[0], 400)
        prepare = self.prepare(browser)
        self.assertEqual(admin.request("/api/admin/auth-config", {"client_secret": ""}, extra_headers=headers)[0], 200)
        self.assertEqual(browser.request(prepare, cross_site=True)[2]["Location"], "/?auth_error=sso")
        # Successful SSO of an administrator permits SSO-only without a restart.
        self.login(admin, "admin-subject")
        self.assertEqual(admin.request("/api/admin/auth-config", {"pin": False}, extra_headers=headers)[0], 200)
        self.assertFalse(browser.request("/api/auth/status")[1]["pin_enabled"])
        admin_id = admin.request("/api/auth/status")[1]["user"]["id"]
        operator_headers = {**headers, "Host": "localhost"}
        self.assertEqual(admin.request("/api/admin/users/" + admin_id, {"enabled": False}, local=True, extra_headers=operator_headers)[0], 409)
        self.assertEqual(admin.request("/api/admin/auth-config", {"pin": True}, extra_headers=headers)[0], 200)
        local = admin.request("/api/admin/users", {"name": "Remembered local account"}, extra_headers=headers)[1]["user"]
        pin = admin.request("/api/admin/users/" + local["id"] + "/pin", {}, extra_headers=headers)[1]["pin"]
        pin_browser = Browser(self.base)
        self.assertEqual(pin_browser.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.assertEqual(admin.request("/api/admin/auth-config", {"pin": True, "sso": False}, extra_headers=headers)[0], 200)
        self.assertFalse(browser.request("/api/auth/status")[1]["sso_enabled"])
        self.assertFalse(admin.request("/api/auth/status")[1]["authenticated"])
        self.assertTrue(pin_browser.request("/api/auth/status")[1]["authenticated"])
        managed = self.state / "data/MoonlightWeb/MoonlightWeb/auth-config.json"
        self.assertEqual(managed.stat().st_mode & 0o777, 0o600)
        self.start("pin,sso")  # Saved configuration wins over conflicting environment bootstrap.
        pin_browser.base = self.base
        status = pin_browser.request("/api/auth/status")[1]
        self.assertFalse(status["sso_enabled"])
        self.assertTrue(status["authenticated"])

    def test_explicit_sso_linking_preserves_the_local_account(self):
        self.start()
        admin, headers = self.administrator()
        user = admin.request("/api/admin/users", {"name": "Linked local"}, extra_headers=headers)[1]["user"]
        path = "/api/admin/users/" + user["id"]
        pin = admin.request(path + "/pin", {}, extra_headers=headers)[1]["pin"]
        local = Browser(self.base)
        self.assertEqual(local.request("/api/auth/validate", {"pin": pin})[0], 200)
        pc = local.request("/api/hosts/manual", {"address": "127.0.0.1:" + str(self.pc.server_port)})[1]["hosts"][0]["uuid"]
        original_cookie = next(c.value for c in admin.cookies if c.name == "__Host-mw_session")
        callback = self.prepare(admin, "linked-local-sub", path=path + "/sso/prepare", headers=headers)
        self.assertEqual(admin.request(callback, cross_site=True)[2]["Location"], "/admin?oidc_link=ready")
        self.assertEqual(next(c.value for c in admin.cookies if c.name == "__Host-mw_session"), original_cookie)
        pending = admin.request("/api/admin/users/sso/pending")[1]
        self.assertEqual(pending["user_id"], user["id"])
        self.assertEqual(pending["subject"], "linked-local-sub")
        self.assertEqual(admin.request(path + "/sso/confirm", {})[0], 403)
        self.assertEqual(admin.request(path + "/sso/confirm", {}, extra_headers=headers)[0], 200)
        self.assertEqual(admin.request(path + "/sso/confirm", {}, extra_headers=headers)[0], 403)
        sso = Browser(self.base)
        self.assertEqual(self.login(sso, "linked-local-sub")["user"]["id"], user["id"])
        self.assertEqual(sso.request("/api/hosts")[1]["hosts"][0]["uuid"], pc)
        self.assertFalse(local.request("/api/auth/status")[1]["authenticated"]) # binding revokes old sessions
        other = admin.request("/api/admin/users", {"name": "Other local"}, extra_headers=headers)[1]["user"]
        callback = self.prepare(admin, "linked-local-sub", path="/api/admin/users/" + other["id"] + "/sso/prepare", headers=headers)
        self.assertEqual(admin.request(callback, cross_site=True)[2]["Location"], "/admin?oidc_link=conflict")
        self.assertEqual(admin.request(path, {"enabled": False}, extra_headers=headers)[0], 200)
        self.assertFalse(sso.request("/api/auth/status")[1]["authenticated"])
        self.assertFalse(local.request("/api/auth/status")[1]["authenticated"])
        callback = self.prepare(sso, "linked-local-sub")
        self.assertEqual(sso.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
        rows = admin.request("/api/admin/users")[1]["users"]
        row = next(u for u in rows if u["id"] == user["id"])
        self.assertFalse(row["enabled"])
        self.assertEqual(row["name"], "Linked local")

    def test_interrupted_account_deletion_resumes_without_affecting_copies(self):
        self.start()
        admin, headers = self.administrator()
        alice = Browser(self.base)
        user_id = self.login(alice)["user"]["id"]
        source = alice.request("/api/hosts/manual", {"address": "127.0.0.1:" + str(self.pc.server_port)})[1]["hosts"][0]["uuid"]
        bob = admin.request("/api/admin/users", {"name": "Surviving copy"}, extra_headers=headers)[1]["user"]
        self.assertEqual(admin.request("/api/admin/hosts/" + source + "/duplicate", {"user_id": bob["id"]}, extra_headers=headers)[0], 200)
        self.stop()
        users_file = self.state / "data/MoonlightWeb/MoonlightWeb/users.json"
        data = json.loads(users_file.read_text())
        for user in data["users"]:
            if user["id"] == user_id:
                user.update({"enabled": False, "deleting": True})
        users_file.write_text(json.dumps(data))
        self.start()
        admin.base = alice.base = self.base
        self.assertFalse(alice.request("/api/auth/status")[1]["authenticated"])
        rows = admin.request("/api/admin/users")[1]["users"]
        self.assertNotIn(user_id, [u["id"] for u in rows])
        self.assertEqual(len(admin.request("/api/admin/users/" + bob["id"] + "/hosts")[1]["hosts"]), 1)
        self.assertEqual(admin.request("/api/admin/users/" + user_id + "/hosts")[0], 404)

    def test_deleted_account_cannot_complete_an_inflight_machine_add(self):
        self.start()
        admin, headers = self.administrator()
        user = admin.request("/api/admin/users", {"name": "Pending add"}, extra_headers=headers)[1]["user"]
        path = "/api/admin/users/" + user["id"]
        pin = admin.request(path + "/pin", {}, extra_headers=headers)[1]["pin"]
        browser = Browser(self.base)
        self.assertEqual(browser.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.pc.info_gate = threading.Event()
        self.pc.info_entered = threading.Event()
        results = []
        thread = threading.Thread(target=lambda: results.append(browser.request("/api/hosts/manual", {"address": "127.0.0.1:" + str(self.pc.server_port)})[0]))
        thread.start()
        try:
            self.assertTrue(self.pc.info_entered.wait(timeout=3))
            self.assertEqual(admin.request(path, method="DELETE", extra_headers=headers)[0], 200)
        finally:
            self.pc.info_gate.set()
            thread.join(timeout=10)
            del self.pc.info_gate
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [409])
        self.assertEqual(admin.request(path + "/hosts")[0], 404)
        self.assertFalse(browser.request("/api/auth/status")[1]["authenticated"])

    def test_oidc_callback_is_rejected_after_configuration_changes_mid_exchange(self):
        alice = self.start()
        admin, headers = self.administrator()
        callback = self.prepare(alice, "stale-identity")
        self.issuer_server.token_gate = threading.Event()
        self.issuer_server.token_entered = threading.Event()
        replies = []
        thread = threading.Thread(target=lambda: replies.append(alice.request(callback, cross_site=True)))
        thread.start()
        try:
            self.assertTrue(self.issuer_server.token_entered.wait(timeout=3))
            self.assertEqual(admin.request("/api/admin/auth-config", {"sso": False, "pin": True}, extra_headers=headers)[0], 200)
        finally:
            self.issuer_server.token_gate.set()
            thread.join(timeout=10)
            del self.issuer_server.token_gate
        self.assertFalse(thread.is_alive())
        self.assertEqual(replies[0][2]["Location"], "/?auth_error=sso")
        self.assertFalse(alice.request("/api/auth/status")[1]["authenticated"])
        self.assertFalse(any(c.name == "__Host-mw_session" for c in alice.cookies))

    def control_socket(self, browser):
        port = int(self.base.rsplit(":", 1)[1])
        conn = ssl._create_unverified_context().wrap_socket(socket.create_connection(("127.0.0.1", port), timeout=3), server_hostname="127.0.0.1")
        cookie = next(c.value for c in browser.cookies if c.name == "__Host-mw_session")
        headers = {"Host": "127.0.0.1:" + str(port), "Origin": self.base, "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": base64.b64encode(secrets.token_bytes(16)).decode(), "Cookie": "__Host-mw_session=" + cookie, "X-Forwarded-For": "203.0.113.20", "X-Forwarded-Proto": "https"}
        request = "GET /ws/control HTTP/1.1\r\n" + "".join(k + ": " + v + "\r\n" for k, v in headers.items()) + "\r\n"
        conn.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            response += conn.recv(4096)
        self.assertTrue(response.startswith(b"HTTP/1.1 101"))
        return conn

    def test_revoking_one_administrator_closes_only_its_websocket(self):
        self.start()
        admin, headers = self.administrator()
        user = admin.request("/api/admin/users", {"name": "Other administrator", "role": "admin"}, extra_headers=headers)[1]["user"]
        path = "/api/admin/users/" + user["id"]
        pin = admin.request(path + "/pin", {}, extra_headers=headers)[1]["pin"]
        other = Browser(self.base)
        self.assertEqual(other.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.assertEqual(admin.request("/api/admin/password", {"password": "fixture-admin-password", "enabled": True, "internet": True}, extra_headers=headers)[0], 200)
        self.assertEqual(other.request("/api/auth/admin-unlock", {"password": "fixture-admin-password"})[0], 200)
        first, second = self.control_socket(admin), self.control_socket(other)
        try:
            self.assertEqual(admin.request(path, {"enabled": False}, extra_headers=headers)[0], 200)
            second.settimeout(3)
            while second.recv(4096):
                pass
            self.assertTrue(admin.request("/api/auth/status")[1]["authenticated"])
            first.sendall(b"\x89\x80" + secrets.token_bytes(4))
            first.settimeout(2)
            try:
                self.assertNotEqual(first.recv(4096), b"")
            except socket.timeout:
                pass
        finally:
            first.close()
            second.close()

    def test_verified_role_mapping_pin_boundary_and_legacy_admin_override(self):
        self.start()
        admin, headers = self.administrator()
        status = admin.request("/api/auth/status")[1]
        self.assertEqual(status["auth_method"], "sso")
        self.assertEqual(status["effective_role"], "admin")
        self.assertTrue(status["admin_access"])
        self.assertFalse(status["admin_unlock_available"])
        config = admin.request("/api/admin/auth-config")[1]
        self.assertEqual(config["scopes"], "openid profile email moonlight_role")
        self.assertEqual(admin.request("/api/admin/password", {"password": "fixture-admin-password", "enabled": True, "internet": True}, extra_headers=headers)[0], 200)
        pin = admin.request("/api/auth/pin", {})[1]["pin"]
        pin_browser = Browser(self.base)
        self.assertEqual(pin_browser.request("/api/auth/validate", {"pin": pin})[0], 200)
        status = pin_browser.request("/api/auth/status")[1]
        self.assertEqual(status["auth_method"], "pin")
        self.assertFalse(status["admin_access"])
        self.assertTrue(status["admin_unlock_available"])
        self.assertEqual(pin_browser.request("/api/admin/users")[0], 403)
        self.assertEqual(pin_browser.request("/api/auth/admin-unlock", {"password": "wrong"})[0], 401)
        self.assertEqual(pin_browser.request("/api/auth/admin-unlock", {"password": "fixture-admin-password"})[0], 200)
        self.assertEqual(pin_browser.request("/api/admin/users")[0], 200)
        # Every unexpected JSON type is ordinary, even for the old admin-subject.
        for value in [None, "", "admin", "INTERNAL_ADMIN", ["internal_admin"], {"role": "internal_admin"}, True, 1, "internal_user"]:
            ordinary = Browser(self.base)
            callback = self.prepare(ordinary, "admin-subject", claims={"moonlight_role": value})
            self.assertEqual(ordinary.request(callback, cross_site=True)[2]["Location"], "/")
            status = ordinary.request("/api/auth/status")[1]
            self.assertFalse(status["admin_access"], repr(value))
            self.assertFalse(status["admin_unlock_available"])
            self.assertEqual(status["effective_role"], "user")
            for route in ["/api/admin/users", "/api/admin/auth-config"]:
                self.assertEqual(ordinary.request(route)[0], 403)
            self.assertFalse(ordinary.request("/api/admin/token")[1].get("token"))
            self.assertEqual(ordinary.request("/api/auth/admin-unlock", {"password": "fixture-admin-password"})[0], 403)
            websocket = {"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": base64.b64encode(secrets.token_bytes(16)).decode(), "Origin": self.base}
            self.assertEqual(ordinary.request("/ws/control", extra_headers=websocket)[0], 403)
        self.assertFalse(admin.request("/api/auth/status")[1]["authenticated"])
        self.assertFalse(pin_browser.request("/api/auth/status")[1]["authenticated"])
        absent = Browser(self.base)
        callback = self.prepare(absent, "admin-subject", claims={"_fixture_omit_role": True})
        self.assertEqual(absent.request(callback, cross_site=True)[2]["Location"], "/")
        self.assertFalse(absent.request("/api/auth/status")[1]["admin_access"])
        # A token with an admin claim but invalid nonce cannot grant any session.
        forged = Browser(self.base)
        callback = self.prepare(forged, "admin-subject", claims={"moonlight_role": "internal_admin", "nonce": "forged"})
        self.assertEqual(forged.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
        self.assertFalse(forged.request("/api/auth/status")[1]["authenticated"])

    def test_role_changes_revoke_only_that_account_and_survive_restart(self):
        self.start()
        admin, headers = self.administrator()
        user = Browser(self.base)
        status = self.login(user)
        user_id = status["user"]["id"]
        host = user.request("/api/hosts/manual", {"address": "127.0.0.1:" + str(self.pc.server_port)})[1]["hosts"][0]["uuid"]
        self.issuer_server.roles["alice-sub"] = "internal_admin"
        promoted = Browser(self.base)
        self.assertTrue(self.login(promoted)["admin_access"])
        self.assertFalse(user.request("/api/auth/status")[1]["authenticated"])
        self.assertTrue(admin.request("/api/auth/status")[1]["admin_access"])
        self.assertEqual(promoted.request("/api/hosts")[1]["hosts"][0]["uuid"], host)
        path = "/api/admin/users/" + user_id
        row = next(u for u in admin.request("/api/admin/users")[1]["users"] if u["id"] == user_id)
        self.assertEqual(row["role_source"], "authentik")
        self.assertEqual(admin.request(path, {"role": "admin"}, extra_headers=headers)[0], 409)
        self.start()
        promoted.base = admin.base = self.base
        headers = {"X-MW-Admin-Key": admin.request("/api/admin/token")[1]["token"]}
        self.assertTrue(promoted.request("/api/auth/status")[1]["admin_access"])
        self.issuer_server.roles["alice-sub"] = "internal_user"
        demoted = Browser(self.base)
        self.assertFalse(self.login(demoted)["admin_access"])
        self.assertFalse(promoted.request("/api/auth/status")[1]["authenticated"])
        self.assertEqual(demoted.request("/api/hosts")[1]["hosts"][0]["uuid"], host)
        self.assertTrue(admin.request("/api/auth/status")[1]["admin_access"])
        self.assertEqual(admin.request(path, {"enabled": False}, extra_headers=headers)[0], 200)
        self.issuer_server.roles["alice-sub"] = "internal_admin"
        callback = self.prepare(demoted)
        self.assertEqual(demoted.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")

    def test_role_sync_storage_failure_rejects_login_and_old_session_revision(self):
        if os.name != "posix" or os.geteuid() == 0:
            self.skipTest("Requires an unprivileged POSIX process")
        self.start()
        user = Browser(self.base)
        self.login(user)
        store = self.state / "data/MoonlightWeb/MoonlightWeb/users.json"
        backup = store.with_suffix(".saved")
        store.rename(backup)
        store.mkdir() # QSaveFile cannot replace a directory.
        self.issuer_server.roles["alice-sub"] = "internal_admin"
        fresh = Browser(self.base)
        try:
            callback = self.prepare(fresh)
            self.assertEqual(fresh.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
            self.assertFalse(fresh.request("/api/auth/status")[1]["authenticated"])
            self.assertFalse(user.request("/api/auth/status")[1]["admin_access"])
        finally:
            store.rmdir()
            backup.rename(store)
        sessions = store.with_name("sessions.json")
        session_backup = sessions.with_suffix(".saved")
        sessions.rename(session_backup)
        sessions.mkdir()
        try:
            callback = self.prepare(fresh)
            self.assertEqual(fresh.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
            self.assertFalse(fresh.request("/api/auth/status")[1]["authenticated"])
            self.assertFalse(user.request("/api/auth/status")[1]["authenticated"])
            self.assertIsNone(self.process.poll())
        finally:
            sessions.rmdir()
            session_backup.rename(sessions)
        self.start()
        user.base = self.base
        # Old persisted cookies are rejected even after a failed revocation write.
        self.assertFalse(user.request("/api/auth/status")[1]["authenticated"])
        fresh.base = self.base
        self.assertTrue(self.login(fresh)["admin_access"])
        # A restored legacy SSO session without its own role proof is ordinary.
        self.stop()
        stored = json.loads(sessions.read_text())
        for session in stored["sessions"]:
            session.pop("sso_admin_config", None)
            session["is_admin"] = True # historical/manual flags cannot bypass SSO proof.
        sessions.write_text(json.dumps(stored))
        self.start()
        fresh.base = self.base
        self.assertTrue(fresh.request("/api/auth/status")[1]["authenticated"])
        self.assertFalse(fresh.request("/api/auth/status")[1]["admin_access"])
        self.assertEqual(fresh.request("/api/auth/admin-unlock", {"password": "anything"})[0], 403)

    def test_owner_sso_follows_claim_but_pin_keeps_password_recovery(self):
        self.start()
        admin, headers = self.administrator()
        owner_path = "/api/admin/users/local-owner"
        callback = self.prepare(admin, "owner-sub", claims={"moonlight_role": "internal_user"}, path=owner_path + "/sso/prepare", headers=headers)
        self.assertEqual(admin.request(callback, cross_site=True)[2]["Location"], "/admin?oidc_link=ready")
        self.assertEqual(admin.request(owner_path + "/sso/confirm", {}, extra_headers=headers)[0], 200)
        sso = Browser(self.base)
        self.assertFalse(self.login(sso, "owner-sub")["admin_access"])
        self.assertEqual(sso.request("/api/auth/admin-unlock", {"password": "fixture-admin-password"})[0], 403)
        self.assertEqual(admin.request("/api/admin/password", {"password": "fixture-admin-password", "enabled": True, "internet": True}, extra_headers=headers)[0], 200)
        pin = admin.request(owner_path + "/pin", {}, extra_headers=headers)[1]["pin"]
        recovery = Browser(self.base)
        self.assertEqual(recovery.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.assertFalse(recovery.request("/api/auth/status")[1]["admin_access"])
        self.assertTrue(recovery.request("/api/auth/status")[1]["admin_unlock_available"])
        self.assertEqual(recovery.request("/api/auth/admin-unlock", {"password": "fixture-admin-password"})[0], 200)
        self.assertEqual(recovery.request("/api/admin/users")[0], 200)

    def test_sso_demotion_closes_only_its_control_websocket(self):
        self.start()
        admin, _ = self.administrator()
        self.issuer_server.roles["alice-sub"] = "internal_admin"
        other = Browser(self.base)
        self.login(other)
        first, second = self.control_socket(admin), self.control_socket(other)
        try:
            self.issuer_server.roles["alice-sub"] = "internal_user"
            self.assertFalse(self.login(Browser(self.base))["admin_access"])
            second.settimeout(3)
            while second.recv(4096):
                pass
            first.sendall(b"\x89\x80" + secrets.token_bytes(4))
            first.settimeout(2)
            try:
                self.assertNotEqual(first.recv(4096), b"")
            except socket.timeout:
                pass
            self.assertTrue(admin.request("/api/auth/status")[1]["admin_access"])
        finally:
            first.close()
            second.close()

    def test_confirmed_link_claim_overrides_a_local_admin_only_after_confirmation(self):
        self.start()
        admin, headers = self.administrator()
        local = admin.request("/api/admin/users", {"name": "Old local admin", "role": "admin"}, extra_headers=headers)[1]["user"]
        path = "/api/admin/users/" + local["id"]
        callback = self.prepare(admin, "linked-sub", path=path + "/sso/prepare", headers=headers)
        self.assertEqual(admin.request(callback, cross_site=True)[2]["Location"], "/admin?oidc_link=ready")
        before = next(u for u in admin.request("/api/admin/users")[1]["users"] if u["id"] == local["id"])
        self.assertEqual(before["role"], "admin")
        self.assertEqual(before["role_source"], "local")
        self.assertEqual(admin.request(path + "/sso/confirm", {}, extra_headers=headers)[0], 200)
        after = next(u for u in admin.request("/api/admin/users")[1]["users"] if u["id"] == local["id"])
        self.assertEqual(after["role"], "user")
        self.assertEqual(after["role_source"], "authentik")
        pin = admin.request(path + "/pin", {}, extra_headers=headers)[1]["pin"]
        pin_browser = Browser(self.base)
        self.assertEqual(pin_browser.request("/api/auth/validate", {"pin": pin})[0], 200)
        self.assertFalse(pin_browser.request("/api/auth/status")[1]["admin_unlock_available"])
        self.assertEqual(pin_browser.request("/api/auth/admin-unlock", {"password": "anything"})[0], 403)

    def test_scopes_invalidate_transactions_and_sso_only_validation(self):
        self.start()
        admin, headers = self.administrator()
        waiting = Browser(self.base)
        callback = self.prepare(waiting)
        self.assertEqual(self.last_scopes, "openid profile email moonlight_role")
        self.assertEqual(admin.request("/api/admin/auth-config", {"scopes": "openid profile moonlight_role"}, extra_headers=headers)[0], 200)
        self.assertEqual(waiting.request(callback, cross_site=True)[2]["Location"], "/?auth_error=sso")
        # Old SSO proof cannot disable PIN with the edited scope set.
        self.assertEqual(admin.request("/api/admin/auth-config", {"pin": False}, extra_headers=headers)[0], 401)
        fresh = Browser(self.base)
        self.assertTrue(self.login(fresh, "admin-subject")["admin_access"])
        self.assertEqual(self.last_scopes, "openid profile moonlight_role")
        fresh_headers = {"X-MW-Admin-Key": fresh.request("/api/admin/token")[1]["token"]}
        self.assertTrue(fresh.request("/api/admin/auth-config")[1]["secret_configured"])
        self.assertEqual(fresh.request("/api/admin/auth-config", {"pin": False}, extra_headers=fresh_headers)[0], 200)
        # Losing the last IdP administrator really removes access, even in SSO-only mode.
        self.issuer_server.roles["admin-subject"] = "internal_user"
        ordinary = Browser(self.base)
        self.assertFalse(self.login(ordinary, "admin-subject")["admin_access"])
        self.assertFalse(fresh.request("/api/auth/status")[1]["authenticated"])
        recovery = Browser(self.base)
        local_headers = {"Host": "localhost", "X-MW-Admin-Key": recovery.request("/api/admin/token", local=True, extra_headers={"Host": "localhost"})[1]["token"]}
        self.assertEqual(recovery.request("/api/admin/auth-config", {"pin": True}, local=True, extra_headers=local_headers)[0], 200)

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
        admin, headers = self.administrator()
        alice_user = alice.request("/api/auth/status")[1]["user"]["id"]
        self.issuer_server.cancel_gate = threading.Event()
        self.issuer_server.cancel_entered = threading.Event()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                stopped = executor.submit(alice.request, "/api/hosts/" + alice_pc + "/stop-session", {})
                self.assertTrue(self.issuer_server.cancel_entered.wait(timeout=5))
                self.assertEqual(bob.request("/api/hosts/" + bob_pc + "/start", {"appId": 1})[0], 409)
                self.assertEqual(alice.request("/api/hosts/" + alice_pc, method="DELETE")[0], 409)
                for operation in ("transfer", "duplicate"):
                    self.assertEqual(admin.request("/api/admin/hosts/" + alice_pc + "/" + operation, {"user_id": "local-owner"}, extra_headers=headers)[0], 409)
                self.assertEqual(admin.request("/api/admin/hosts/" + alice_pc, method="DELETE", extra_headers=headers)[0], 409)
                self.assertEqual(admin.request("/api/admin/users/" + alice_user, method="DELETE", extra_headers=headers)[0], 409)
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
