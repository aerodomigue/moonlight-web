#!/usr/bin/env python3
"""WOL metadata against a mutually authenticated Apollo HTTPS fixture.

Usage: python3 backend/tests/test_wol_integration.py build/MoonlightWeb
Only ephemeral loopback providers and state are used; no wake packets are sent.
"""
import configparser
from contextlib import contextmanager
import http.server
from pathlib import Path
import ssl
import subprocess
import sys
import threading
import time
import unittest
import test_oidc_integration as oidc
from test_oidc_integration import Browser


class WolIntegration(oidc.OidcIsolation):
    @contextmanager
    def wol_peer(self, wrong_pin=False):
        # Old paired registration with no MAC: HTTP must not be sufficient.
        self.pc.mac = "00:00:00:00:00:00"
        class Peer(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                if self.path.startswith('/serverinfo'):
                    self.server.requests += 1
                    self.server.clients.append(bool(self.connection.getpeercert()))
                    self.server.entered.set()
                    self.server.gate.wait(20)
                    xml = ('<root status_code="200"><uniqueid>' + self.server.physical +
                           '</uniqueid><LocalIP>192.168.5.191</LocalIP><mac>' + self.server.mac + '</mac></root>')
                else: xml = '<root status_code="200"/>'
                body=xml.encode(); self.send_response(200)
                self.send_header('Content-Length',str(len(body))); self.send_header('Connection','close'); self.end_headers()
                try: self.wfile.write(body)
                except (OSError,ssl.SSLError): pass
        peer=http.server.ThreadingHTTPServer(('127.0.0.1',0),Peer)
        peer.requests=0;peer.clients=[];peer.entered=threading.Event();peer.gate=threading.Event();peer.gate.set()
        peer.physical='fixture-physical-pc';peer.mac='4c:d5:77:cb:4b:d9'
        key=self.state/'wol-client.key';cert=self.state/'wol-client.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=wol-client',
                        '-keyout',str(key),'-out',str(cert)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(self.cert,self.key)
        context.load_verify_locations(cert);context.verify_mode=ssl.CERT_REQUIRED
        peer.socket=context.wrap_socket(peer.socket,server_side=True)
        threading.Thread(target=peer.serve_forever,daemon=True).start()
        old_port=self.pc.https_port;self.pc.https_port=peer.server_port
        try:
            alice=self.start();self.login(alice)
            added=alice.request('/api/hosts/manual',{'address':'127.0.0.1:'+str(self.pc.server_port)})
            self.assertEqual(added[0],200);host=added[1]['hosts'][0]['uuid'];self.stop()
            settings=self.state/'config/MoonlightWeb/MoonlightWeb.conf'
            config=configparser.ConfigParser(interpolation=None);config.optionxform=str;config.read(settings)
            section=config['hosts'];prefix=next(k[:-4] for k,v in section.items() if k.endswith('\\uuid') and v==host)
            def qbyte(value):return '@ByteArray('+value.replace('\\','\\\\').replace('\n','\\n')+')'
            section[prefix+'serverCert']=qbyte((cert if wrong_pin else self.cert).read_text())
            section[prefix+'pairState']='paired';section[prefix+'mac']='@ByteArray()';section[prefix+'macSource']=''
            seat=section[prefix+'identitySeat']
            if 'seatIdentities' not in config:config['seatIdentities']={}
            config['seatIdentities'][seat+'\\cert']=qbyte(cert.read_text())
            config['seatIdentities'][seat+'\\key']=qbyte(key.read_text())
            with settings.open('w') as f:config.write(f,space_around_delimiters=False)
            # Starting is left to each test so it can delay/alter the response.
            yield alice, '/api/hosts/'+host+'/wol-config', peer
        finally:
            peer.gate.set();self.stop();peer.shutdown();peer.server_close()
            self.pc.https_port=old_port;del self.pc.mac

    def wait_wol(self, browser, path, predicate, timeout=12):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            data=browser.request(path)[1]
            if predicate(data):return data
            time.sleep(.1)
        self.fail('WOL metadata did not reach expected state')

    def test_wol_paired_https_backfill_and_restart_preserve_identity(self):
        with self.wol_peer() as (alice,path,peer):
            self.start();alice.base=self.base;self.login(alice)
            data=self.wait_wol(alice,path,lambda d:d['detected']['source']=='https')
            self.assertEqual(data['detected']['mac'],'4c:d5:77:cb:4b:d9')
            self.assertEqual(data['detected']['address'],'192.168.5.191')
            self.assertEqual(data['reason'],'network_unreachable');self.assertFalse(data['available'])
            self.assertEqual(peer.clients,[True]);self.assertEqual(peer.requests,1)
            self.assertEqual(alice.request('/api/hosts')[1]['hosts'][0]['pairState'],'paired')
            self.start();alice.base=self.base;self.login(alice)
            self.assertEqual(alice.request(path)[1]['detected'],data['detected'])
            time.sleep(5.5);self.assertEqual(peer.requests,1)

    def test_wol_wrong_certificate_and_physical_identity_are_rejected(self):
        for wrong_pin in (True,False):
            with self.subTest(wrong_pin=wrong_pin), self.wol_peer(wrong_pin) as (alice,path,peer):
                if not wrong_pin:peer.physical='different-pc'
                self.start();alice.base=self.base;self.login(alice)
                time.sleep(11)
                self.assertEqual(alice.request(path)[1]['detected']['mac'],'')
                self.assertLessEqual(peer.requests,1)

    def test_wol_disabled_registration_drops_a_late_https_response(self):
        with self.wol_peer() as (alice,path,peer):
            peer.gate.clear()
            admin=self.start();self.login(admin,'admin-subject');key=admin.request('/api/admin/token')[1]['token']
            alice.base=self.base;self.login(alice)
            self.assertTrue(peer.entered.wait(12))
            host=path.split('/')[3]
            self.assertEqual(admin.request('/api/admin/hosts/'+host+'/enabled',{'enabled':False},extra_headers={'X-MW-Admin-Key':key})[0],200)
            peer.gate.set();time.sleep(.3)
            self.assertEqual(alice.request(path)[0],403)
            self.assertEqual(admin.request('/api/admin/hosts/'+host+'/enabled',{'enabled':True},extra_headers={'X-MW-Admin-Key':key})[0],200)
            self.assertEqual(alice.request(path)[1]['detected']['mac'],'')

    def test_wol_failed_manual_save_preserves_previous_values(self):
        alice=self.start();self.login(alice)
        added=alice.request('/api/hosts/manual',{'address':'127.0.0.1:'+str(self.pc.server_port)})
        path='/api/hosts/'+added[1]['hosts'][0]['uuid']+'/wol-config'
        self.assertEqual(alice.request(path,{'address':'192.168.5.191','mac':'4c:d5:77:cb:4b:d9'})[0],200)
        previous=alice.request(path)[1]
        file=self.state/'config/MoonlightWeb/MoonlightWeb.conf'
        mode=file.stat().st_mode&0o777;dm=file.parent.stat().st_mode&0o777
        file.chmod(0o400);file.parent.chmod(0o500)
        try:
            self.assertEqual(alice.request(path,{'address':'','mac':''})[0],503)
            self.assertEqual(alice.request(path)[1],previous)
        finally:file.parent.chmod(dm);file.chmod(mode)
        self.start();alice.base=self.base;self.login(alice)
        self.assertEqual(alice.request(path)[1]['manual'],previous['manual'])

    def test_wol_invalid_mac_timeout_and_storage_failure_remain_retryable(self):
        for kind in ('invalid_mac','timeout','storage'):
            with self.subTest(kind=kind),self.wol_peer() as (alice,path,peer):
                peer.gate.clear()
                if kind=='invalid_mac':peer.mac='00:00:00:00:00:00'
                self.start();alice.base=self.base;self.login(alice)
                self.assertTrue(peer.entered.wait(12))
                file=self.state/'config/MoonlightWeb/MoonlightWeb.conf'
                mode=file.stat().st_mode&0o777;dm=file.parent.stat().st_mode&0o777
                try:
                    if kind=='storage':file.chmod(0o400);file.parent.chmod(0o500)
                    if kind=='timeout':time.sleep(7.5)
                    peer.gate.set();time.sleep(.4)
                    self.assertEqual(alice.request(path)[1]['detected']['mac'],'')
                    time.sleep(10.5)
                    self.assertEqual(peer.requests,1,'Failed metadata collection must not run each poll')
                finally:file.parent.chmod(dm);file.chmod(mode)
                if kind=='storage':
                    self.stop();config=configparser.ConfigParser(interpolation=None);config.read(file)
                    self.assertTrue(all(v in ('','@ByteArray()') for k,v in config['hosts'].items() if k.endswith('\\mac')))

    def test_wol_manual_add_storage_failure_leaves_no_registration(self):
        alice=self.start();self.login(alice)
        file=self.state/'config/MoonlightWeb/MoonlightWeb.conf'
        mode=file.stat().st_mode&0o777;dm=file.parent.stat().st_mode&0o777
        file.chmod(0o400);file.parent.chmod(0o500)
        try:
            result=alice.request('/api/hosts/manual',{'address':'127.0.0.1:'+str(self.pc.server_port)})
            self.assertEqual(result[0],503)
            self.assertEqual(alice.request('/api/hosts')[1]['hosts'],[])
        finally:file.parent.chmod(dm);file.chmod(mode)
        self.start();alice.base=self.base;self.login(alice)
        self.assertEqual(alice.request('/api/hosts')[1]['hosts'],[])

    def test_wol_configuration_is_readable_isolated_and_durable(self):
        alice = self.start(); self.login(alice)
        bob = Browser(self.base); self.login(bob, "bob-sub")
        added = alice.request("/api/hosts/manual", {"address": "127.0.0.1:" + str(self.pc.server_port)})
        self.assertEqual(added[0], 200)
        path = "/api/hosts/" + added[1]["hosts"][0]["uuid"] + "/wol-config"
        status, config, _ = alice.request(path)
        self.assertEqual(status, 200)
        self.assertEqual(config["mode"], "automatic")
        self.assertEqual(bob.request(path)[0], 404)
        self.assertEqual(alice.request(path, {"address": "192.168.5.191", "mac": "4c:d5:77:cb:4b:d9"})[0], 200)
        config = alice.request(path)[1]
        self.assertEqual(config["mode"], "manual")
        self.assertEqual(config["effective"], {"address": "192.168.5.191", "mac": "4c:d5:77:cb:4b:d9"})
        self.start(); alice.base = self.base; self.login(alice)
        self.assertEqual(alice.request(path)[1]["effective"], config["effective"])
        self.assertEqual(alice.request(path, {"address": "", "mac": ""})[0], 200)
        self.assertEqual(alice.request(path)[1]["mode"], "automatic")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(WolIntegration(name) for name in WolIntegration.__dict__
                              if name.startswith('test_wol_'))

if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    oidc.BINARY = str(Path(sys.argv.pop()).resolve())
    unittest.main(verbosity=2)
