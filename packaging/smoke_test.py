"""Starts a built F1Tutor program and checks that it really works.

Usage: python packaging/smoke_test.py path/to/F1Tutor[.exe]

Real game packets go in over UDP; the page, the real-driver data, the live
WebSocket feed and saving a drive are checked from outside.
"""

import base64
import json
import pathlib
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

from websockets.sync.client import connect

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAPTURES = ["Session", "Participants", "Motion", "LapData", "CarTelemetry", "CarStatus", "CarDamage"]


def free_port(kind: int) -> int:
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=10) as response:
        return response.read()


def main() -> None:
    program = pathlib.Path(sys.argv[1]).resolve()
    web_port = free_port(socket.SOCK_STREAM)
    udp_port = free_port(socket.SOCK_DGRAM)
    with tempfile.TemporaryDirectory() as folder:
        db = pathlib.Path(folder, "smoke.db")
        # Output to a file: an unread pipe fills up and would stall the program being tested.
        output = open(pathlib.Path(folder, "output.txt"), "w+b")
        process = subprocess.Popen(
            [str(program), "--no-browser", "--port", str(web_port), "--udp-port", str(udp_port), "--db", str(db)],
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        base = f"http://127.0.0.1:{web_port}"
        try:
            started = time.monotonic()
            while True:
                try:
                    page = get(base + "/")
                    break
                except OSError:
                    if process.poll() is not None or time.monotonic() - started > 90:
                        output.seek(0)
                        raise SystemExit(f"The program didn't start:\n{output.read().decode(errors='replace')}")
                    time.sleep(0.5)
            print(f"started in {time.monotonic() - started:.1f} s")
            assert b"F1 Tutor" in page, "page"
            index = json.loads(get(base + "/reference/index.json"))
            assert index["tracks"]["4"][0]["code"] == "PIA", "reference index"
            assert len(get(base + "/reference/11/VER.json")) > 10_000, "reference lap"
            print("page and real-driver data: ok")

            with connect(f"ws://127.0.0.1:{web_port}/ws", open_timeout=10) as ws, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                packets = [(ROOT / "tests" / "data" / f"{name}.bin").read_bytes() for name in CAPTURES]
                meta = tick = None
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and not (meta and tick):
                    for packet in packets:
                        udp.sendto(packet, ("127.0.0.1", udp_port))
                    message = json.loads(ws.recv(timeout=5))
                    if message["type"] == "meta" and message["player"] and message["session"]:
                        meta = message
                    if message["type"] == "tick" and message["live"] and message["car"]:
                        tick = message
                assert meta and meta["player"]["name"] == "RUSSELL" and meta["session"]["trackId"] == 11, "meta"
                assert tick and tick["car"]["speed"] == 41, "tick"
            print("game packets reach the live feed: ok")

            cells = 10
            trace = base64.b64encode(struct.pack(f"<{cells * 8}f", *range(cells * 8))).decode()
            session = {
                "sessionUid": "smoke", "trackId": 4, "trackName": "Barcelona", "trackLength": 4650, "sessionType": 18,
                "formula": 2, "laps": [{"lap": 1, "ms": 90000, "valid": True, "clean": True, "cells": cells, "trace": trace}],
            }
            request = urllib.request.Request(
                base + "/api/sessions", data=json.dumps(session).encode(), headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                assert response.status == 201, "save"
            saved = json.loads(get(base + "/api/sessions?trackId=4"))
            assert saved[0]["bestLapMs"] == 90000 and db.is_file(), "saved drive"
            print("saving a drive: ok")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
            output.close()
    print("SMOKE TEST PASSED")


if __name__ == "__main__":
    main()
