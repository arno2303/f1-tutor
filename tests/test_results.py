import base64
import contextlib
import math
import pathlib
import socket
import sqlite3
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

import server
from results_db import BYTES_PER_CELL, TRACE_CHANNELS, ResultsDb


def raw_trace(cells=100, speed=200.0):
    """Every channel holds its index plus the given speed, except one gap of NaN."""
    values = []
    for channel in range(len(TRACE_CHANNELS)):
        values += [speed + channel] * cells
    values[3] = math.nan
    return struct.pack(f"<{len(values)}f", *values)


def session_data(uid="111", laps=None, **extra):
    return {
        "sessionUid": uid,
        "name": "",
        "trackId": 4,
        "trackName": "Barcelona",
        "trackLength": 4650,
        "sessionType": 18,
        "formula": 2,
        "teamId": 163,
        "driverName": "LUKÁŠ",
        "raceNumber": 63,
        "weather": 1,
        "trackTemp": 35,
        "airTemp": 25,
        "gameVersion": "1.18",
        "laps": laps if laps is not None else [lap_data(1, 90000), lap_data(2, 88000), lap_data(3, 86000, valid=False)],
        **extra,
    }


def lap_data(lap, ms, valid=True, clean=True, cells=100):
    return {
        "lap": lap, "ms": ms, "s1": ms // 3, "s2": ms // 3, "s3": ms - 2 * (ms // 3),
        "valid": valid, "clean": clean, "cells": cells, "trace": raw_trace(cells, speed=float(lap)),
    }


def as_json(session):
    laps = [{**lap, "trace": base64.b64encode(lap["trace"]).decode("ascii")} for lap in session["laps"]]
    return {**session, "laps": laps}


class TempDbCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = pathlib.Path(folder.name, "nested", "results.db")
        self.db = ResultsDb(self.path)


class ResultsDbTests(TempDbCase):
    def test_nothing_is_created_until_it_is_used(self):
        self.assertFalse(self.path.exists())
        self.assertEqual(self.db.list_sessions(), [])
        self.assertTrue(self.path.exists())

    def test_summary_uses_only_valid_laps_for_the_best(self):
        session_id = self.db.save_session(session_data())
        summary = self.db.list_sessions()[0]
        self.assertEqual(summary["id"], session_id)
        self.assertEqual((summary["lapCount"], summary["validLapCount"]), (3, 2))
        # Lap 3 was faster but invalid.
        self.assertEqual((summary["bestLapNumber"], summary["bestLapMs"]), (2, 88000))
        self.assertEqual(summary["bestS1"], 88000 // 3)
        self.assertEqual(summary["trackName"], "Barcelona")
        self.assertEqual(summary["driverName"], "LUKÁŠ")

    def test_session_with_no_valid_lap_has_no_best(self):
        self.db.save_session(session_data(laps=[lap_data(1, 90000, valid=False)]))
        summary = self.db.list_sessions()[0]
        self.assertIsNone(summary["bestLapMs"])
        self.assertIsNone(summary["bestLapNumber"])
        self.assertIsNone(summary["bestS1"])

    def test_lap_table_is_in_lap_order(self):
        session_id = self.db.save_session(session_data())
        laps = self.db.get_session(session_id)["laps"]
        self.assertEqual([lap["lap"] for lap in laps], [1, 2, 3])
        self.assertEqual(laps[2]["valid"], False)
        self.assertEqual(laps[0]["s3"], 30000)
        self.assertNotIn("trace", laps[0])

    def test_trace_comes_back_identical_including_gaps(self):
        session_id = self.db.save_session(session_data())
        cells, trace = self.db.get_trace(session_id, 2)
        self.assertEqual(cells, 100)
        self.assertEqual(trace, raw_trace(100, speed=2.0))
        self.assertTrue(math.isnan(struct.unpack_from("<f", trace, 12)[0]))

    def test_traces_are_stored_compressed(self):
        session_id = self.db.save_session(session_data())
        with contextlib.closing(sqlite3.connect(self.path)) as connection:
            stored = connection.execute("SELECT LENGTH(trace) FROM laps WHERE session_id = ?", (session_id,)).fetchone()[0]
        self.assertLess(stored, 100 * BYTES_PER_CELL)

    def test_saving_again_adds_laps_and_keeps_the_earlier_ones(self):
        first = self.db.save_session(session_data(laps=[lap_data(1, 90000), lap_data(2, 88000)]))
        # After a page reload the browser only knows the laps since then.
        second = self.db.save_session(session_data(laps=[lap_data(5, 87000)]))
        self.assertEqual(first, second)
        self.assertEqual([lap["lap"] for lap in self.db.get_session(first)["laps"]], [1, 2, 5])
        self.assertEqual(len(self.db.list_sessions()), 1)

    def test_saving_a_lap_number_again_replaces_it(self):
        session_id = self.db.save_session(session_data(laps=[lap_data(1, 90000)]))
        self.db.save_session(session_data(laps=[lap_data(1, 85000)]))
        self.assertEqual(self.db.get_session(session_id)["laps"][0]["ms"], 85000)

    def test_a_later_save_without_a_name_keeps_the_name(self):
        session_id = self.db.save_session(session_data(name="Prvý tréning"))
        self.db.save_session(session_data())
        self.assertEqual(self.db.get_session(session_id)["name"], "Prvý tréning")
        self.db.save_session(session_data(name="Premenované"))
        self.assertEqual(self.db.get_session(session_id)["name"], "Premenované")

    def test_filters_by_track_newest_first(self):
        self.db.save_session(session_data(uid="1"))
        self.db.save_session(session_data(uid="2", trackId=11, trackName="Monza"))
        self.db.save_session(session_data(uid="3"))
        self.assertEqual([s["sessionUid"] for s in self.db.list_sessions(4)], ["3", "1"])
        self.assertEqual([s["sessionUid"] for s in self.db.list_sessions(11)], ["2"])
        self.assertEqual(len(self.db.list_sessions()), 3)

    def test_delete_removes_the_laps_too(self):
        session_id = self.db.save_session(session_data())
        self.assertTrue(self.db.delete_session(session_id))
        self.assertIsNone(self.db.get_session(session_id))
        self.assertIsNone(self.db.get_trace(session_id, 1))
        with contextlib.closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM laps").fetchone()[0], 0)
        self.assertFalse(self.db.delete_session(session_id))

    def test_two_first_uses_at_once_both_work(self):
        import concurrent.futures

        def first_use(index):
            db = ResultsDb(self.path.parent / f"fresh{index}.db")
            with concurrent.futures.ThreadPoolExecutor(4) as pool:
                return list(pool.map(lambda _: db.list_sessions(), range(4)))

        for index in range(20):
            self.assertEqual(first_use(index), [[], [], [], []])

    def test_saving_again_without_driver_details_keeps_them(self):
        session_id = self.db.save_session(session_data())
        # Saved again right after a server restart, before the game resent the participants.
        self.db.save_session(session_data(driverName="", teamId=None, raceNumber=None, laps=[lap_data(4, 87000)]))
        summary = self.db.get_session(session_id)
        self.assertEqual((summary["driverName"], summary["teamId"]), ("LUKÁŠ", 163))

    def test_data_survives_reopening(self):
        session_id = self.db.save_session(session_data())
        self.assertEqual(ResultsDb(self.path).get_session(session_id)["lapCount"], 3)

    def test_unknown_things_are_reported_as_missing(self):
        self.assertIsNone(self.db.get_session(99))
        self.assertIsNone(self.db.get_trace(99, 1))


class ResultsApiTests(TempDbCase):
    def setUp(self):
        super().setUp()
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("127.0.0.1", 0))
            udp_port = sock.getsockname()[1]
        self.client = TestClient(server.create_app(udp_port, db_path=self.path, allowed_hosts=server.LOCAL_HOSTS | {"testserver"}))

    def save(self, session=None):
        return self.client.post("/api/sessions", json=as_json(session or session_data()))

    def test_save_list_read_and_delete(self):
        saved = self.save()
        self.assertEqual(saved.status_code, 201)
        session_id = saved.json()["id"]
        self.assertEqual(saved.json()["lapCount"], 3)

        listed = self.client.get("/api/sessions", params={"trackId": 4}).json()
        self.assertEqual([s["id"] for s in listed], [session_id])
        self.assertEqual(self.client.get("/api/sessions", params={"trackId": 11}).json(), [])

        detail = self.client.get(f"/api/sessions/{session_id}").json()
        self.assertEqual(len(detail["laps"]), 3)

        self.assertEqual(self.client.delete(f"/api/sessions/{session_id}").status_code, 204)
        missing = self.client.get(f"/api/sessions/{session_id}")
        self.assertEqual((missing.status_code, missing.json()["detail"]), (404, {"code": "session_not_found"}))
        self.assertEqual(self.client.delete(f"/api/sessions/{session_id}").status_code, 404)

    def test_trace_round_trip(self):
        session_id = self.save().json()["id"]
        body = self.client.get(f"/api/sessions/{session_id}/laps/2/trace").json()
        self.assertEqual(body["cells"], 100)
        self.assertEqual(body["channels"], list(TRACE_CHANNELS))
        self.assertEqual(base64.b64decode(body["trace"]), raw_trace(100, speed=2.0))
        self.assertEqual(self.client.get(f"/api/sessions/{session_id}/laps/9/trace").status_code, 404)

    def test_rejects_a_trace_of_the_wrong_size(self):
        lap = lap_data(1, 90000)
        lap["cells"] = 99
        response = self.save(session_data(laps=[lap]))
        self.assertEqual(response.status_code, 422)
        # A code the browser translates, not a sentence in one language.
        self.assertEqual(response.json()["detail"], {"code": "trace_size", "lap": 1})
        self.assertEqual(self.db.list_sessions(), [])

    def test_rejects_a_trace_that_is_not_base64(self):
        body = as_json(session_data(laps=[lap_data(1, 90000)]))
        body["laps"][0]["trace"] = "@@not base64@@"
        response = self.client.post("/api/sessions", json=body)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], {"code": "trace_unreadable", "lap": 1})

    def test_rejects_a_session_without_laps(self):
        self.assertEqual(self.save(session_data(laps=[])).status_code, 422)

    def test_rejects_numbers_too_big_for_the_database(self):
        body = as_json(session_data(laps=[lap_data(1, 90000)]))
        body["trackId"] = 2**70
        self.assertEqual(self.client.post("/api/sessions", json=body).status_code, 422)
        self.assertEqual(self.client.get(f"/api/sessions/{2**70}").status_code, 422)
        self.assertEqual(self.client.get("/api/sessions", params={"trackId": 2**70}).status_code, 422)

    def test_validation_errors_do_not_echo_the_upload(self):
        body = as_json(session_data(laps=[lap_data(1, 90000)]))
        body["trackId"] = "x" * 100_000
        response = self.client.post("/api/sessions", json=body)
        self.assertEqual(response.status_code, 422)
        self.assertLess(len(response.content), 2000)

    def test_rejects_too_many_cells(self):
        body = as_json(session_data(laps=[lap_data(1, 90000)]))
        body["laps"][0]["cells"] = server.MAX_TRACE_CELLS + 1
        self.assertEqual(self.client.post("/api/sessions", json=body).status_code, 422)


if __name__ == "__main__":
    unittest.main()
