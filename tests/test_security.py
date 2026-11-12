"""Other web pages open in the same browser must not reach the app or its saved drives."""

import asyncio
import json
import pathlib
import socket
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import server

GOOD_ORIGIN = "http://127.0.0.1:8000"
EVIL_ORIGIN = "http://f1tutor.attacker.example:8000"


def free_udp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LocalOnlyTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        app = server.create_app(free_udp_port(), pathlib.Path(folder.name), db_path=pathlib.Path(folder.name, "x.db"))
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_works_for_the_app_itself(self):
        self.assertEqual(self.client.get("/api/sessions").status_code, 200)
        self.assertEqual(self.client.get("/api/sessions", headers={"Host": "localhost:8000"}).status_code, 200)

    def test_turns_away_a_rebound_domain(self):
        # DNS rebinding: an attacker's name pointed at 127.0.0.1, so the browser thinks it's the same site.
        response = self.client.get("/api/sessions", headers={"Host": "f1tutor.attacker.example:8000"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.delete("/api/sessions/1", headers={"Host": "f1tutor.attacker.example"}).status_code, 403)

    def test_another_site_cannot_change_saved_drives(self):
        body = json.dumps({"sessionUid": "x"})
        evil = self.client.post("/api/sessions", content=body, headers={"Origin": EVIL_ORIGIN, "Content-Type": "application/json"})
        self.assertEqual(evil.status_code, 403)
        self.assertEqual(self.client.delete("/api/sessions/1", headers={"Origin": EVIL_ORIGIN}).status_code, 403)
        own = self.client.post("/api/sessions", content=body, headers={"Origin": GOOD_ORIGIN, "Content-Type": "application/json"})
        self.assertEqual(own.status_code, 422)

    def test_another_site_cannot_open_the_live_feed(self):
        # The test client's WebSockets always say Host: testserver, so that name is allowed here
        # and only the Origin, the page the connection comes from, is under test.
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        app = server.create_app(
            free_udp_port(), pathlib.Path(folder.name), db_path=pathlib.Path(folder.name, "x.db"),
            allowed_hosts=server.LOCAL_HOSTS | {"testserver"},
        )
        with TestClient(app) as client:
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect("/ws", headers={"Origin": EVIL_ORIGIN}) as websocket:
                    websocket.receive_text()
            with client.websocket_connect("/ws", headers={"Origin": GOOD_ORIGIN}) as websocket:
                self.assertEqual(json.loads(websocket.receive_text())["type"], "meta")

    def test_only_json_is_accepted_for_saving(self):
        # A text/plain POST needs no permission from the browser, so it's refused before it's read.
        response = self.client.post("/api/sessions", content=b"{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(response.status_code, 415)
        response = self.client.post("/api/sessions", content=b"{}")
        self.assertEqual(response.status_code, 415)

    def test_refuses_a_body_larger_than_any_save(self):
        sent = []

        async def app(scope, receive, send):
            sent.append("reached the app")

        guard = server.LocalOnlyMiddleware(app, server.LOCAL_HOSTS)
        scope = {
            "type": "http", "method": "POST", "path": "/api/sessions",
            "headers": [(b"host", b"127.0.0.1:8000"), (b"content-type", b"application/json"),
                        (b"content-length", str(server.MAX_BODY_BYTES + 1).encode())],
        }
        responses = []

        async def send(message):
            responses.append(message)

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        asyncio.run(guard(scope, receive, send))
        self.assertEqual(responses[0]["status"], 413)
        self.assertEqual(sent, [])


class HostNameTests(unittest.TestCase):
    def test_reads_host_headers_and_origins(self):
        self.assertEqual(server.host_name("127.0.0.1:8000"), "127.0.0.1")
        self.assertEqual(server.host_name("http://LOCALHOST:5173"), "localhost")
        self.assertEqual(server.host_name("[::1]:8000"), "::1")
        self.assertEqual(server.host_name("http://[::1]:8000/x"), "::1")
        self.assertEqual(server.host_name("example.com"), "example.com")

    def test_serving_to_other_devices_adds_this_computers_address(self):
        hosts = server.allowed_hosts_for("0.0.0.0")
        self.assertTrue(server.LOCAL_HOSTS <= hosts)
        if server.local_ip():
            self.assertIn(server.local_ip(), hosts)
        self.assertEqual(server.allowed_hosts_for("127.0.0.1"), server.LOCAL_HOSTS)


if __name__ == "__main__":
    unittest.main()
