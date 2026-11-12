import json
import pathlib
import socket
import sys
import struct
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

import f1_udp
import server

DATA_DIR = pathlib.Path(__file__).resolve().parent / "data"
# The test client calls itself "testserver".
TEST_HOSTS = server.LOCAL_HOSTS | {"testserver"}
CAPTURES = ["Motion", "Session", "LapData", "Participants", "CarTelemetry", "CarStatus", "CarDamage"]


def capture(name):
    return (DATA_DIR / f"{name}.bin").read_bytes()


def with_session_uid(data, uid):
    return data[:7] + uid.to_bytes(8, "little") + data[15:]


def with_format(data, packet_format):
    return packet_format.to_bytes(2, "little") + data[2:]


def free_udp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StateTests(unittest.TestCase):
    def setUp(self):
        self.state = server.TelemetryState(20777)

    def feed_all(self):
        for name in CAPTURES:
            self.state.handle_datagram(capture(name))

    def test_meta_from_real_packets(self):
        self.feed_all()
        meta = self.state.meta()
        self.assertEqual(meta["session"]["trackId"], 11)
        self.assertEqual(meta["session"]["trackLength"], 5798)
        self.assertEqual(meta["player"]["name"], "RUSSELL")
        self.assertEqual(meta["player"]["teamId"], 0)
        self.assertEqual(meta["gameVersion"], "1.18")
        self.assertIsNone(meta["warning"])

    def test_tick_from_real_packets_is_json_ready(self):
        self.feed_all()
        tick = json.loads(json.dumps(self.state.tick()))
        self.assertTrue(tick["live"])
        self.assertEqual(tick["car"]["speed"], 41)
        self.assertEqual(tick["car"]["tyre_surface_temps"], [79, 79, 70, 70])
        self.assertEqual(tick["lap"]["lap_num"], 1)
        self.assertEqual(tick["status"]["visual_compound"], 17)
        self.assertEqual(tick["damage"]["gearbox"], 0)
        self.assertEqual(tick["motion"]["z"], self.state.latest[f1_udp.Motion].z)

    def test_empty_state_is_valid(self):
        self.assertIsNone(self.state.meta()["session"])
        tick = self.state.tick()
        self.assertFalse(tick["live"])
        self.assertIsNone(tick["car"])

    def test_goes_stale_when_packets_stop(self):
        self.state.handle_datagram(capture("CarTelemetry"), now=100.0)
        self.assertTrue(self.state.is_live(now=101.0))
        self.assertFalse(self.state.is_live(now=100.0 + server.LIVE_TIMEOUT_S))

    def test_other_format_warns_and_is_not_decoded(self):
        self.state.handle_datagram(with_format(capture("CarTelemetry"), 2026))
        self.assertEqual(self.state.meta()["warning"], {"code": "format", "format": 2026})
        self.assertIsNone(self.state.tick()["car"])
        self.assertFalse(self.state.is_live())

    def test_format_warning_clears_once_the_setting_is_fixed(self):
        self.state.handle_datagram(with_format(capture("CarTelemetry"), 2026))
        self.state.handle_datagram(capture("CarTelemetry"))
        self.assertIsNone(self.state.meta()["warning"])

    def test_size_warning_stays_during_the_session(self):
        self.state.handle_datagram(capture("CarDamage")[:-1])
        self.state.handle_datagram(capture("CarTelemetry"))
        self.assertEqual(self.state.meta()["warning"], {"code": "packetSize", "packet": 10, "size": 1040, "expected": 1041})
        self.state.handle_datagram(with_session_uid(capture("CarTelemetry"), 99))
        self.assertIsNone(self.state.meta()["warning"])

    def test_invalid_numbers_never_reach_the_browser(self):
        self.state.handle_datagram(capture("CarStatus"))
        good = self.state.latest[f1_udp.CarStatus].fuel_kg
        data = bytearray(capture("CarStatus"))
        # fuel_kg of car 19; a NaN must keep the last good value.
        struct.pack_into("<f", data, 29 + 19 * 55 + 5, float("nan"))
        self.state.handle_datagram(bytes(data))
        self.assertEqual(self.state.latest[f1_udp.CarStatus].fuel_kg, good)
        json.dumps(self.state.tick(), allow_nan=False)

    def test_invalid_numbers_without_an_earlier_value_become_zero(self):
        data = bytearray(capture("CarTelemetry"))
        struct.pack_into("<f", data, 29 + 19 * 60 + 2, float("inf"))  # throttle
        self.state.handle_datagram(bytes(data))
        self.assertEqual(self.state.latest[f1_udp.CarTelemetry].throttle, 0.0)
        json.dumps(self.state.tick(), allow_nan=False)

    def test_invalid_numbers_inside_per_wheel_values(self):
        self.state.handle_datagram(capture("CarTelemetry"))
        good = self.state.latest[f1_udp.CarTelemetry].tyre_pressures[1]
        data = bytearray(capture("CarTelemetry"))
        struct.pack_into("<f", data, 29 + 19 * 60 + 40 + 4, float("nan"))
        self.state.handle_datagram(bytes(data))
        self.assertEqual(self.state.latest[f1_udp.CarTelemetry].tyre_pressures[1], good)

    def test_measures_the_rate_and_longest_gap_of_the_game_data(self):
        for i in range(20):
            self.state.handle_datagram(capture("CarTelemetry"), now=100.0 + i * 0.05)
        self.state.handle_datagram(capture("CarTelemetry"), now=101.45)
        stats = self.state.link_stats(now=101.45)
        self.assertEqual(stats["maxGapMs"], 500)
        self.assertTrue(13 <= stats["hz"] <= 15, stats)

    def test_old_measurements_expire(self):
        self.state.handle_datagram(capture("CarTelemetry"), now=100.0)
        self.state.handle_datagram(capture("CarTelemetry"), now=100.9)
        self.assertEqual(self.state.link_stats(now=120.0), {"hz": 0, "maxGapMs": 0})

    def test_session_time_that_is_not_a_number_never_reaches_the_browser(self):
        data = bytearray(capture("CarTelemetry"))
        struct.pack_into("<f", data, 15, float("nan"))  # header session time
        self.state.handle_datagram(bytes(data))
        self.assertIsNone(json.loads(json.dumps(self.state.tick(), allow_nan=False))["sessionTime"])

    def test_measurements_stay_bounded_without_a_browser(self):
        for i in range(3000):
            self.state.handle_datagram(capture("CarTelemetry"), now=100.0 + i / 60)
        self.assertLess(len(self.state.frame_arrivals), 60 * server.STATS_WINDOW_S + 5)

    def test_garbage_is_ignored(self):
        self.state.handle_datagram(b"")
        self.state.handle_datagram(b"x" * 10)
        self.assertIsNone(self.state.header)

    def test_new_session_drops_old_data(self):
        self.feed_all()
        self.state.handle_datagram(with_session_uid(capture("CarTelemetry"), 99))
        meta = self.state.meta()
        self.assertEqual(meta["sessionUid"], "99")
        self.assertIsNone(meta["session"])
        self.assertIsNone(meta["player"])
        self.assertIsNone(self.state.tick()["lap"])
        self.assertEqual(self.state.tick()["car"]["speed"], 41)


class BuildTests(unittest.TestCase):
    def test_reads_the_script_name_from_the_page(self):
        with tempfile.TemporaryDirectory() as folder:
            pathlib.Path(folder, "index.html").write_text('<script src="/assets/index-Dj6abM-E.js"></script>', encoding="utf-8")
            self.assertEqual(server.current_build(pathlib.Path(folder)), "index-Dj6abM-E.js")

    def test_no_build_without_a_page(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertIsNone(server.current_build(pathlib.Path(folder)))


class LiveAppTests(unittest.TestCase):
    """Real UDP datagrams in, real WebSocket messages out."""

    def setUp(self):
        self.udp_port = free_udp_port()
        self.static = tempfile.TemporaryDirectory()
        self.addCleanup(self.static.cleanup)
        pathlib.Path(self.static.name, "index.html").write_text(
            '<title>F1 Tutor</title><script type="module" src="/assets/index-abc123.js"></script>', encoding="utf-8"
        )
        pathlib.Path(self.static.name, "assets").mkdir()
        pathlib.Path(self.static.name, "assets", "index-abc123.js").write_text("// app", encoding="utf-8")
        self.voice = pathlib.Path(self.static.name, "voice-source")
        self.voice.mkdir()
        (self.voice / "Brzda.m4a").write_bytes(b"recording")
        self.client = TestClient(
            server.create_app(
                self.udp_port, pathlib.Path(self.static.name), self.voice,
                db_path=pathlib.Path(self.static.name, "test.db"), allowed_hosts=TEST_HOSTS,
            )
        )
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(self.sender.close)

    def send_all(self):
        for name in CAPTURES:
            self.sender.sendto(capture(name), ("127.0.0.1", self.udp_port))

    def receive_until(self, websocket, condition, limit=200):
        for _ in range(limit):
            message = json.loads(websocket.receive_text())
            if condition(message):
                return message
        self.fail("expected message never arrived")

    def test_serves_the_frontend(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("F1 Tutor", response.text)

    def test_the_page_is_always_checked_for_a_newer_version(self):
        # A browser that kept an old index.html would keep running an old version of the app.
        for path in ("/", "/index.html"):
            self.assertEqual(self.client.get(path).headers["cache-control"], "no-cache", path)
        self.assertEqual(self.client.get("/voice/Brzda.m4a").headers["cache-control"], "no-cache")

    def test_built_files_with_hashed_names_are_kept(self):
        response = self.client.get("/assets/index-abc123.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("immutable", response.headers["cache-control"])

    def test_serves_the_voice_recordings(self):
        response = self.client.get("/voice/Brzda.m4a")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"recording")

    def test_runs_without_a_voice_folder(self):
        app = server.create_app(free_udp_port(), pathlib.Path(self.static.name), pathlib.Path(self.static.name, "none"))
        self.assertNotIn("voice", {route.name for route in app.routes})

    def test_tells_each_page_the_current_build(self):
        with self.client.websocket_connect("/ws") as websocket:
            self.assertEqual(json.loads(websocket.receive_text())["build"], "index-abc123.js")

    def test_udp_reaches_the_websocket(self):
        with self.client.websocket_connect("/ws") as websocket:
            first = json.loads(websocket.receive_text())
            self.assertEqual(first["type"], "meta")
            self.assertIsNone(first["session"])
            self.send_all()
            meta = self.receive_until(websocket, lambda m: m["type"] == "meta" and m["player"] and m["session"])
            self.assertEqual(meta["player"]["name"], "RUSSELL")
            self.assertEqual(meta["session"]["trackId"], 11)
            tick = self.receive_until(websocket, lambda m: m["type"] == "tick" and m["car"] and m["lap"])
            self.assertTrue(tick["live"])
            self.assertEqual(tick["car"]["speed"], 41)

    def test_meta_is_only_sent_when_it_changes(self):
        with self.client.websocket_connect("/ws") as websocket:
            self.send_all()
            self.receive_until(websocket, lambda m: m["type"] == "meta" and m["player"] and m["session"])
            following = [json.loads(websocket.receive_text()) for _ in range(10)]
            self.assertEqual({m["type"] for m in following}, {"tick"})

    def test_only_a_heartbeat_goes_out_without_new_data(self):
        with self.client.websocket_connect("/ws") as websocket:
            start = time.monotonic()
            received = 0
            while time.monotonic() - start < 1.0:
                if json.loads(websocket.receive_text())["type"] == "tick":
                    received += 1
            self.assertTrue(3 <= received <= 6, f"{received} ticks in a second")

    def test_new_data_goes_out_at_the_rate_it_arrives(self):
        stop = threading.Event()

        def game():
            data = capture("CarTelemetry")
            while not stop.is_set():
                self.sender.sendto(data, ("127.0.0.1", self.udp_port))
                time.sleep(1 / 60)

        thread = threading.Thread(target=game)
        thread.start()
        try:
            with self.client.websocket_connect("/ws") as websocket:
                start = time.monotonic()
                received = 0
                while time.monotonic() - start < 1.0:
                    if json.loads(websocket.receive_text())["type"] == "tick":
                        received += 1
                self.assertTrue(30 <= received <= 62, f"{received} ticks in a second")
        finally:
            stop.set()
            thread.join()

    def test_two_clients_both_receive_data_and_one_leaving_is_harmless(self):
        with self.client.websocket_connect("/ws") as second:
            with self.client.websocket_connect("/ws") as first:
                self.send_all()
                self.receive_until(first, lambda m: m["type"] == "tick" and m["car"])
            self.receive_until(second, lambda m: m["type"] == "tick" and m["car"])


if __name__ == "__main__":
    unittest.main()
