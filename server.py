"""Telemetry app backend: game UDP -> WebSocket -> Vue frontend.

Usage: python server.py [--hz 60] [--udp-port 20777] [--port 8000] [--host 127.0.0.1] [--db data/f1tutor.db] [--no-browser]
"""

import argparse
import asyncio
import base64
import binascii
import collections
import contextlib
import json
import math
import os
import pathlib
import queue
import socket
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from collections.abc import AsyncIterator
from typing import Annotated, NamedTuple

import uvicorn
from fastapi import FastAPI, HTTPException, Path, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import f1_udp
from results_db import BYTES_PER_CELL, TRACE_CHANNELS, ResultsDb

DEFAULT_WEB_PORT = 8000
DEFAULT_SEND_HZ = 60.0
# With nothing new from the game, the browser still needs to hear that it's gone.
HEARTBEAT_S = 0.25
# Over how long the rate and the longest gap of the game's data are measured.
STATS_WINDOW_S = 5.0
# A gap this long in the middle of driving is visible as a freeze, so it's logged.
LOG_GAP_S = 0.25
# Without a packet for this long the game counts as gone (closed, or paused in a menu).
LIVE_TIMEOUT_S = 1.5
MAX_TRACE_CELLS = 5000
# The largest legitimate save, 500 laps of 5000 cells in base64, is about 107 MB.
MAX_BODY_BYTES = 120 * 1024 * 1024
# Names the app may be reached by. Anything else in the Host header is a DNS-rebinding
# attempt by some web page, and an Origin outside them is another site reaching in.
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
INT64 = Annotated[int, Field(ge=-(2**63), le=2**63 - 1)]
ROW_ID = Annotated[int, Path(ge=0, le=2**63 - 1)]
# Tried in turn when the web port is taken by another program.
WEB_PORT_ATTEMPTS = 10

# Packaged as one program (PyInstaller), the bundled files are unpacked to a
# temporary folder, while the program itself lives wherever the user put it.
FROZEN = getattr(sys, "frozen", False)
SOURCE_DIR = pathlib.Path(__file__).resolve().parent
BUNDLE_DIR = pathlib.Path(getattr(sys, "_MEIPASS", SOURCE_DIR))
APP_DIR = pathlib.Path(sys.executable).resolve().parent if FROZEN else SOURCE_DIR
FRONTEND_DIST = BUNDLE_DIR / "frontend" / "dist"


def voice_dir() -> pathlib.Path:
    """A `voice` folder next to the program wins, so recordings can be replaced without a rebuild."""
    beside = APP_DIR / "voice"
    return beside if beside.is_dir() else BUNDLE_DIR / "voice"


def is_writable(folder: pathlib.Path) -> bool:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=folder):
            return True
    except OSError:
        return False


def default_db() -> pathlib.Path:
    """Saved drives go next to the program, where they're easy to find and back up.

    If that folder can't be written to, for example Program Files, they go to the
    user's own application data instead.
    """
    if not FROZEN:
        return SOURCE_DIR / "data" / "f1tutor.db"
    beside = APP_DIR / "F1Tutor-data"
    if is_writable(beside):
        return beside / "f1tutor.db"
    home = pathlib.Path(os.environ.get("LOCALAPPDATA") or pathlib.Path.home())
    return home / "F1Tutor" / "f1tutor.db"


VOICE_DIR = voice_dir()


# Console output goes through a thread of its own: a console that blocks writing,
# such as a Windows console with text selected, mustn't stop the live data.
_log_queue: queue.SimpleQueue[str] = queue.SimpleQueue()


def _write_log() -> None:
    while True:
        print(_log_queue.get(), flush=True)


threading.Thread(target=_write_log, name="log", daemon=True).start()


def log(message: str) -> None:
    _log_queue.put(message)


def replace_invalid_numbers(record: tuple, previous: tuple | None) -> tuple:
    """Swap NaN and infinity for the field's last good value, or 0 without one.

    JSON has no such numbers. The browser would reject the whole message over a
    single one, and every value on the dashboard would freeze.
    """

    def clean(value, last):
        if isinstance(value, float) and not math.isfinite(value):
            return last if isinstance(last, (int, float)) and math.isfinite(last) else 0.0
        if isinstance(value, tuple):
            return tuple(clean(v, last[i] if last else None) for i, v in enumerate(value))
        return value

    values = (clean(v, previous[i] if previous else None) for i, v in enumerate(record))
    return type(record)(*values)


class TelemetryState:
    """The newest data from the game, split into what changes per frame and per session."""

    def __init__(self, udp_port: int = f1_udp.DEFAULT_PORT) -> None:
        self.udp_port = udp_port
        self.ip = local_ip()
        self.latest: dict[type, NamedTuple] = {}
        self.header: f1_udp.Header | None = None
        self.last_packet_at: float | None = None
        # Sent to the browser as codes and values, translated into its language there.
        self.format_warning: dict | None = None
        # Stays for the session: one bad packet type shouldn't flicker between good packets.
        self.size_warning: dict | None = None
        # Bumped by every decoded packet, so senders can tell when there's something new.
        self.version = 0
        self.frame_arrivals: collections.deque[tuple[float, float]] = collections.deque()
        self.last_frame_at: float | None = None

    def handle_datagram(self, data: bytes, now: float | None = None) -> None:
        header = f1_udp.parse_header(data)
        if header is None:
            return
        if header.packet_format != f1_udp.PACKET_FORMAT:
            self.format_warning = {"code": "format", "format": header.packet_format}
            return
        self.format_warning = None
        if self.header is not None and self.header.session_uid != header.session_uid:
            self.latest.clear()
            self.size_warning = None
        self.header = header
        try:
            record = f1_udp.decode_player_car(header, data)
        except f1_udp.PacketSizeError as err:
            self.size_warning = {"code": "packetSize", "packet": err.packet_id, "size": err.size, "expected": err.expected}
            return
        arrived = time.monotonic() if now is None else now
        self.last_packet_at = arrived
        if record is not None:
            record = replace_invalid_numbers(record, self.latest.get(type(record)))
            self.latest[type(record)] = record
            self.version += 1
            if isinstance(record, f1_udp.CarTelemetry):
                self.note_frame(arrived)

    def note_frame(self, arrived: float) -> None:
        gap = 0.0 if self.last_frame_at is None else arrived - self.last_frame_at
        self.last_frame_at = arrived
        self.frame_arrivals.append((arrived, gap))
        # Kept to the stats window here too, as nothing else trims it while no browser is connected.
        while self.frame_arrivals and self.frame_arrivals[0][0] < arrived - STATS_WINDOW_S:
            self.frame_arrivals.popleft()
        # A long stop is the game paused or closed, not a stall while driving.
        if LOG_GAP_S <= gap < STATS_WINDOW_S:
            log(f"{time.strftime('%H:%M:%S')}  data from the game stopped for {gap * 1000:.0f} ms")

    def link_stats(self, now: float | None = None) -> dict:
        """How often the game's data really arrives, as measured here."""
        now = time.monotonic() if now is None else now
        while self.frame_arrivals and self.frame_arrivals[0][0] < now - STATS_WINDOW_S:
            self.frame_arrivals.popleft()
        arrivals = self.frame_arrivals
        if len(arrivals) < 2:
            return {"hz": 0, "maxGapMs": 0}
        span = now - arrivals[0][0]
        return {
            "hz": round((len(arrivals) - 1) / span) if span > 0 else 0,
            "maxGapMs": round(max(gap for _, gap in list(arrivals)[1:]) * 1000),
        }

    def is_live(self, now: float | None = None) -> bool:
        if self.last_packet_at is None:
            return False
        return (time.monotonic() if now is None else now) - self.last_packet_at < LIVE_TIMEOUT_S

    def meta(self, build: str | None = None) -> dict:
        """Everything that stays the same during a session. Sent only when it changes."""
        session = self.latest.get(f1_udp.Session)
        player = self.latest.get(f1_udp.Participant)
        return {
            "type": "meta",
            # A page left open across an update compares this with its own script and reloads.
            "build": build,
            "udp": {"ip": self.ip, "port": self.udp_port},
            "warning": self.format_warning or self.size_warning,
            "sessionUid": str(self.header.session_uid) if self.header else None,
            "gameVersion": f"{self.header.game_major_version}.{self.header.game_minor_version:02d}"
            if self.header
            else None,
            "session": {
                "weather": session.weather,
                "trackTemp": session.track_temp,
                "airTemp": session.air_temp,
                "totalLaps": session.total_laps,
                "trackLength": session.track_length,
                "sessionType": session.session_type,
                "trackId": session.track_id,
                "formula": session.formula,
                "sector2Start": session.sector2_start,
                "sector3Start": session.sector3_start,
            }
            if session
            else None,
            "player": {
                "name": player.name,
                "teamId": player.team_id,
                "raceNumber": player.race_number,
                "nationality": player.nationality,
                "aiControlled": bool(player.ai_controlled),
            }
            if player
            else None,
        }

    def tick(self) -> dict:
        """The live values."""
        lap = self.latest.get(f1_udp.LapData)
        car = self.latest.get(f1_udp.CarTelemetry)
        motion = self.latest.get(f1_udp.Motion)
        status = self.latest.get(f1_udp.CarStatus)
        damage = self.latest.get(f1_udp.CarDamage)
        session = self.latest.get(f1_udp.Session)
        return {
            "type": "tick",
            "live": self.is_live(),
            "sessionTime": self.header.session_time if self.header and math.isfinite(self.header.session_time) else None,
            "frame": self.header.overall_frame_id if self.header else None,
            "udp": self.link_stats(),
            "paused": bool(session.game_paused) if session else False,
            "safetyCar": session.safety_car if session else 0,
            "timeLeft": session.time_left if session else None,
            "lap": lap._asdict() if lap else None,
            "car": car._asdict() if car else None,
            "motion": motion._asdict() if motion else None,
            "status": status._asdict() if status else None,
            "damage": damage._asdict() if damage else None,
        }


class SavedLap(BaseModel):
    lap: INT64
    ms: INT64
    s1: INT64 | None = None
    s2: INT64 | None = None
    s3: INT64 | None = None
    valid: bool
    clean: bool
    cells: int = Field(gt=0, le=MAX_TRACE_CELLS)
    trace: str  # base64 of the raw channels, see results_db.TRACE_CHANNELS


class SavedSession(BaseModel):
    sessionUid: str = Field(min_length=1, max_length=40)
    name: str = Field(default="", max_length=100)
    trackId: INT64
    trackName: str = Field(max_length=100)
    trackLength: INT64
    sessionType: INT64
    formula: INT64
    teamId: INT64 | None = None
    driverName: str = Field(default="", max_length=64)
    raceNumber: INT64 | None = None
    weather: INT64 | None = None
    trackTemp: INT64 | None = None
    airTemp: INT64 | None = None
    gameVersion: str | None = Field(default=None, max_length=16)
    laps: list[SavedLap] = Field(min_length=1, max_length=500)


def decode_trace(lap: SavedLap) -> bytes:
    try:
        trace = base64.b64decode(lap.trace, validate=True)
    except binascii.Error:
        raise HTTPException(422, {"code": "trace_unreadable", "lap": lap.lap})
    if len(trace) != lap.cells * BYTES_PER_CELL:
        raise HTTPException(422, {"code": "trace_size", "lap": lap.lap})
    return trace


def current_build(static_dir: pathlib.Path) -> str | None:
    """Name of the app's main script in the current build; it changes with every build."""
    try:
        page = (static_dir / "index.html").read_text(encoding="utf-8")
    except OSError:
        return None
    start = page.find("/assets/index-")
    end = page.find(".js", start)
    return page[start + len("/assets/") : end + 3] if start >= 0 and end > start else None


class AppStaticFiles(StaticFiles):
    """Static files with caching that can't leave a browser on an old version of the app.

    Built scripts and styles carry a content hash in their name, so a new build
    gets new names and these can be kept for good. Everything else, above all
    index.html that names them, is checked with the server on every load.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        hashed = scope["path"].startswith("/assets/")
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if hashed else "no-cache"
        return response


def host_name(value: str) -> str:
    """The host part of a Host header or an Origin URL, without scheme or port."""
    value = value.split("://", 1)[-1].split("/", 1)[0].lower()
    if value.startswith("["):
        return value[1 : value.find("]")]
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


class LocalOnlyMiddleware:
    """Keeps other web pages in the same browser away from the app and its saved drives.

    Requests must name the app by a local address (against DNS rebinding); the
    WebSocket and requests that change data must come from the app's own pages;
    and request bodies are capped, since any page can send one without asking.
    """

    def __init__(self, app, allowed_hosts: frozenset[str]) -> None:
        self.app = app
        self.allowed = allowed_hosts

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {key.decode("latin-1"): value.decode("latin-1") for key, value in scope["headers"]}
        origin = headers.get("origin")
        host_ok = host_name(headers.get("host", "")) in self.allowed
        changes_data = scope["type"] == "websocket" or scope["method"] not in ("GET", "HEAD", "OPTIONS")
        origin_ok = origin is None or not changes_data or host_name(origin) in self.allowed
        if not host_ok or not origin_ok:
            if scope["type"] == "websocket":
                return await send({"type": "websocket.close", "code": 1008})
            return await JSONResponse({"detail": {"code": "forbidden"}}, status_code=403)(scope, receive, send)

        if scope["type"] == "http" and changes_data:
            length = headers.get("content-length")
            if length is not None and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
                return await JSONResponse({"detail": {"code": "too_large"}}, status_code=413)(scope, receive, send)
            if scope["method"] == "POST" and not headers.get("content-type", "").startswith("application/json"):
                return await JSONResponse({"detail": {"code": "json_only"}}, status_code=415)(scope, receive, send)
            receive = self._capped(receive)
        return await self.app(scope, receive, send)

    @staticmethod
    def _capped(receive):
        # Also for bodies sent without a Content-Length.
        received = 0

        async def wrapped():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > MAX_BODY_BYTES:
                raise HTTPException(413, {"code": "too_large"})
            return message

        return wrapped


def allowed_hosts_for(bind_host: str) -> frozenset[str]:
    """Local names, plus the address the app is opened at when it's served to other devices."""
    hosts = set(LOCAL_HOSTS)
    if bind_host in ("0.0.0.0", "::", ""):
        hosts.update(filter(None, [local_ip(), socket.gethostname().lower()]))
    else:
        hosts.add(host_name(bind_host))
    return frozenset(hosts)


class UdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, state: TelemetryState) -> None:
        self.state = state

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        self.state.handle_datagram(data)


def local_ip() -> str | None:
    """Return this computer's LAN address, which is what the game needs as its UDP IP."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            # Connecting a UDP socket sends nothing; it only picks the outgoing interface.
            sock.connect(("10.255.255.255", 1))
            return sock.getsockname()[0]
        except OSError:
            return None


def create_app(
    udp_port: int = f1_udp.DEFAULT_PORT,
    static_dir: pathlib.Path = FRONTEND_DIST,
    voice_dir: pathlib.Path = VOICE_DIR,
    send_hz: float = DEFAULT_SEND_HZ,
    db_path: pathlib.Path | None = None,
    allowed_hosts: frozenset[str] = LOCAL_HOSTS,
) -> FastAPI:
    state = TelemetryState(udp_port)
    results = ResultsDb(db_path or default_db())

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(lambda: UdpProtocol(state), local_addr=("0.0.0.0", udp_port))
        yield
        transport.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(LocalOnlyMiddleware, allowed_hosts=allowed_hosts)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        # Without the default echo of the input, which could be a large upload sent straight back.
        problems = [{"loc": problem["loc"], "type": problem["type"]} for problem in error.errors()]
        return JSONResponse({"detail": problems}, status_code=422)
    app.state.telemetry = state

    @app.websocket("/ws")
    async def telemetry_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        build = current_build(static_dir)
        last_meta = None
        last_version = -1
        last_sent = 0.0
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            while True:
                meta = state.meta(build)
                if meta != last_meta:
                    await websocket.send_text(json.dumps(meta))
                    last_meta = meta
                now = time.monotonic()
                # Only new data goes out: a repeat would look to the browser like fresh data.
                if state.version != last_version or now - last_sent >= HEARTBEAT_S:
                    last_version = state.version
                    last_sent = now
                    await websocket.send_text(json.dumps(state.tick()))
                await asyncio.sleep(1 / send_hz)

    # Plain `def` handlers: FastAPI runs them on a thread, so disk access can't hold up the live data.
    @app.get("/api/sessions")
    def list_sessions(trackId: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None) -> list[dict]:
        return results.list_sessions(trackId)

    @app.post("/api/sessions", status_code=201)
    def save_session(session: SavedSession) -> dict:
        data = session.model_dump()
        for lap_data, lap in zip(data["laps"], session.laps):
            lap_data["trace"] = decode_trace(lap)
        return results.get_session(results.save_session(data))

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: ROW_ID) -> dict:
        session = results.get_session(session_id)
        if session is None:
            raise HTTPException(404, {"code": "session_not_found"})
        return session

    @app.get("/api/sessions/{session_id}/laps/{lap_number}/trace")
    def get_trace(session_id: ROW_ID, lap_number: ROW_ID) -> dict:
        found = results.get_trace(session_id, lap_number)
        if found is None:
            raise HTTPException(404, {"code": "lap_not_found"})
        cells, trace = found
        return {"cells": cells, "channels": TRACE_CHANNELS, "trace": base64.b64encode(trace).decode("ascii")}

    @app.delete("/api/sessions/{session_id}", status_code=204)
    def delete_session(session_id: ROW_ID) -> None:
        if not results.delete_session(session_id):
            raise HTTPException(404, {"code": "session_not_found"})

    # Served from disk rather than bundled, so a re-recorded clip needs no rebuild.
    if voice_dir.is_dir():
        app.mount("/voice", AppStaticFiles(directory=voice_dir), name="voice")
    if static_dir.is_dir():
        app.mount("/", AppStaticFiles(directory=static_dir, html=True), name="frontend")
    return app


def free_web_port(host: str, first: int) -> int | None:
    for port in range(first, first + WEB_PORT_ATTEMPTS):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, port))
                return port
            except OSError:
                continue
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="F1 25 telemetry in the browser.")
    parser.add_argument(
        "--hz",
        type=f1_udp.positive_float,
        default=DEFAULT_SEND_HZ,
        help="most updates per second sent to the browser (default: %(default)s); more than the game's UDP Send Rate doesn't help",
    )
    parser.add_argument("--udp-port", type=int, default=f1_udp.DEFAULT_PORT, help="UDP port the game sends to (default: %(default)s)")
    parser.add_argument("--port", type=int, default=DEFAULT_WEB_PORT, help="port of the web app (default: %(default)s)")
    parser.add_argument("--host", default="127.0.0.1", help="address of the web app (default: %(default)s)")
    parser.add_argument("--db", type=pathlib.Path, default=None, help="file for saved drives (default: a data folder next to the app)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    args = parser.parse_args()

    if not FRONTEND_DIST.is_dir():
        raise SystemExit("The frontend isn't built. Run: cd frontend && npm install && npm run build")
    # Checked up front because uvicorn would only log a traceback for a busy port.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.bind(("0.0.0.0", args.udp_port))
        except OSError as err:
            raise SystemExit(f"UDP port {args.udp_port} can't be opened: {err}")

    port = free_web_port(args.host, args.port)
    if port is None:
        raise SystemExit(f"Ports {args.port}–{args.port + WEB_PORT_ATTEMPTS - 1} are all in use by other programs.")
    db_path = args.db or default_db()

    url = f"http://{args.host}:{port}"
    print("F1 Tutor is running.")
    print(f"  App:           {url}")
    print(f"  In the game:   UDP IP {local_ip()}, UDP Port {args.udp_port}, UDP Format 2025, Send Rate 60 Hz")
    print(f"  Saved drives:  {db_path}")
    if FROZEN:
        print("Keep this window open while driving. Closing it stops the app.")
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, args=[url]).start()
    app = create_app(args.udp_port, send_hz=args.hz, db_path=db_path, allowed_hosts=allowed_hosts_for(args.host))
    uvicorn.run(app, host=args.host, port=port, log_level="warning")


def disable_console_selection() -> None:
    """Turns off Windows' QuickEdit, where a click in the console pauses the program until a key is pressed."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-10)  # standard input
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            quick_edit, extended_flags = 0x0040, 0x0080
            kernel32.SetConsoleMode(handle, (mode.value & ~quick_edit) | extended_flags)
    except (AttributeError, OSError):
        pass


def run_packaged() -> None:
    """As a double-clicked program, the console closes on exit, so an error stays until it's read."""
    # Some Windows consoles can't show every character; a "?" beats a crash.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    disable_console_selection()
    try:
        main()
    except KeyboardInterrupt:
        return
    except SystemExit as stop:
        if stop.code in (None, 0):
            return
        print(f"\n{stop.code}" if isinstance(stop.code, str) else "")
        input("\nPress Enter to close this window…")
        raise
    except Exception:
        traceback.print_exc()
        input("\nSomething went wrong. Press Enter to close this window…")
        raise SystemExit(1)


if __name__ == "__main__":
    if FROZEN:
        run_packaged()
    else:
        main()
