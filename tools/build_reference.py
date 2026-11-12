"""Build frontend/public/reference/ from the TracingInsights archive (FastF1 export).

Usage: python3 tools/build_reference.py

Stores each driver's fastest 2025 qualifying lap for every circuit in the game.
Run this only to regenerate the data; the result is checked in.
Source: https://github.com/TracingInsights/2025 (Apache-2.0).
"""

import concurrent.futures
import json
import math
import pathlib
import subprocess
import urllib.parse

from build_tracks import BASE_URL, TRACKS

OUTPUT = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "public" / "reference"
YEAR = 2025
# A lap whose telemetry doesn't span the whole lap is left out rather than shown wrongly.
MAX_LAP_END_GAP_S = 0.5


def fetch_json(grand_prix: str, path: str) -> dict | None:
    # curl rather than urllib: python.org builds on macOS ship without CA certificates.
    url = f"{BASE_URL}/{urllib.parse.quote(f'{grand_prix} Grand Prix/Qualifying/{path}')}"
    result = subprocess.run(["curl", "-sSfL", "--retry", "3", "-m", "60", url], capture_output=True)
    return json.loads(result.stdout) if result.returncode == 0 else None


def fastest_lap(laptimes: dict) -> tuple[int, float, str] | None:
    """Return (lap number, seconds, compound) of the fastest timed lap."""
    deleted = laptimes.get("del") or [False] * len(laptimes["time"])
    # A lap deleted for track limits doesn't count, so it isn't a fair reference either.
    timed = [
        (time, lap, compound)
        for time, lap, compound, removed in zip(laptimes["time"], laptimes["lap"], laptimes["compound"], deleted)
        if isinstance(time, (int, float)) and removed is not True
    ]
    if not timed:
        return None
    time, lap, compound = min(timed)
    return lap, time, compound


def compact_lap(tel: dict) -> dict | None:
    """Keep what the app uses, in as few characters as the precision allows."""
    keys = ("distance", "time", "speed", "throttle", "brake", "gear", "x", "y")
    samples = []
    for row in zip(*(tel[key] for key in keys)):
        if all(isinstance(value, (int, float)) and math.isfinite(value) for value in row):
            # Repeated distances would break interpolation later.
            if not samples or row[0] > samples[-1][0]:
                samples.append(row)
    if len(samples) < 100:
        return None
    columns = list(zip(*samples))
    return {
        "d": [round(value, 1) for value in columns[0]],
        "t": [round(value * 1000) for value in columns[1]],
        "v": [round(value) for value in columns[2]],
        "thr": [round(value) for value in columns[3]],
        "brk": [int(value) for value in columns[4]],
        "g": [int(value) for value in columns[5]],
        # Decimetres in the source, metres here.
        "x": [round(value / 10, 1) for value in columns[6]],
        "y": [round(value / 10, 1) for value in columns[7]],
    }


def build_driver(track_id: int, grand_prix: str, driver: dict) -> dict | None:
    code = driver["driver"]
    laptimes = fetch_json(grand_prix, f"{code}/laptimes.json")
    best = fastest_lap(laptimes) if laptimes else None
    if not best:
        print(f"{grand_prix} {code}: no timed lap")
        return None
    lap, seconds, compound = best
    tel_file = fetch_json(grand_prix, f"{code}/{lap}_tel.json")
    compact = compact_lap(tel_file["tel"]) if tel_file else None
    if not compact or abs(compact["t"][-1] / 1000 - seconds) > MAX_LAP_END_GAP_S:
        print(f"{grand_prix} {code}: incomplete telemetry for lap {lap}")
        return None
    folder = OUTPUT / str(track_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{code}.json").write_text(json.dumps(compact, separators=(",", ":")), encoding="utf-8")
    return {
        "code": code,
        "name": f"{driver['fn']} {driver['ln']}",
        "team": driver["team"],
        "color": f"#{driver['tc']}",
        "number": driver["dn"],
        "lap": lap,
        "lapMs": round(seconds * 1000),
        "compound": compound,
    }


def main() -> None:
    index: dict[str, list] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for track_id, name, _, grand_prix in TRACKS:
            drivers = (fetch_json(grand_prix, "drivers.json") or {"drivers": []})["drivers"]
            results = pool.map(lambda driver: build_driver(track_id, grand_prix, driver), drivers)
            laps = sorted((lap for lap in results if lap), key=lambda lap: lap["lapMs"])
            index[str(track_id)] = laps
            best = f"{laps[0]['name']} {laps[0]['lapMs']} ms" if laps else "no data"
            print(f"{name}: {len(laps)} drivers, fastest {best}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "index.json").write_text(
        json.dumps({"year": YEAR, "tracks": index}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
