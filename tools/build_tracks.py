"""Build frontend/src/data/tracks.json from the TracingInsights archive (FastF1 export).

Usage: python3 tools/build_tracks.py

Run this only to regenerate the map data; the result is checked in. Each track's
outline is resampled to even spacing, so a lap fraction maps directly to a point.
Source: https://github.com/TracingInsights/2025 (Apache-2.0).
"""

import json
import math
import pathlib
import subprocess
import urllib.parse

BASE_URL = "https://raw.githubusercontent.com/TracingInsights/2025/main"
OUTPUT = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "src" / "data" / "tracks.json"
SPACING_M = 8.0
# A corner's real position is searched this far around its published distance,
# which keeps it on the right stretch of track where two parts run side by side.
CORNER_SEARCH_M = 150.0

# (F1 25 track id, English name, country, Grand Prix folder in the archive).
# Slovak names are in frontend/src/i18n/sk.ts.
TRACKS = [
    (0, "Melbourne", "Australia", "Australian"),
    (2, "Shanghai", "China", "Chinese"),
    (3, "Sakhir", "Bahrain", "Bahrain"),
    (4, "Barcelona", "Spain", "Spanish"),
    (5, "Monaco", "Monaco", "Monaco"),
    (6, "Montreal", "Canada", "Canadian"),
    (7, "Silverstone", "Great Britain", "British"),
    (9, "Hungaroring", "Hungary", "Hungarian"),
    (10, "Spa-Francorchamps", "Belgium", "Belgian"),
    (11, "Monza", "Italy", "Italian"),
    (12, "Singapore", "Singapore", "Singapore"),
    (13, "Suzuka", "Japan", "Japanese"),
    (14, "Yas Marina", "Abu Dhabi", "Abu Dhabi"),
    (15, "Austin", "USA", "United States"),
    (16, "Interlagos", "Brazil", "São Paulo"),
    (17, "Spielberg", "Austria", "Austrian"),
    (19, "Mexico City", "Mexico", "Mexico City"),
    (20, "Baku", "Azerbaijan", "Azerbaijan"),
    (26, "Zandvoort", "Netherlands", "Dutch"),
    (27, "Imola", "Italy", "Emilia Romagna"),
    (29, "Jeddah", "Saudi Arabia", "Saudi Arabian"),
    (30, "Miami", "USA", "Miami"),
    (31, "Las Vegas", "USA", "Las Vegas"),
    (32, "Lusail", "Qatar", "Qatar"),
]
# (track id, base track id). The game drives these layouts the other way round.
REVERSE_TRACKS = [(39, 7), (40, 17), (41, 26)]


def fetch_corners(grand_prix: str) -> dict:
    # curl rather than urllib: python.org builds on macOS ship without CA certificates.
    path = urllib.parse.quote(f"{grand_prix} Grand Prix/Qualifying/corners.json")
    result = subprocess.run(
        ["curl", "-sSfL", "-m", "60", f"{BASE_URL}/{path}"], capture_output=True, check=True
    )
    return json.loads(result.stdout)


def rotate(x: float, y: float, degrees: float) -> tuple[float, float]:
    angle = math.radians(degrees)
    return x * math.cos(angle) - y * math.sin(angle), x * math.sin(angle) + y * math.cos(angle)


def resample_closed(points: list[tuple[float, float]], spacing: float) -> tuple[list[tuple[float, float]], float]:
    """Return evenly spaced points along a closed polyline, and its length."""
    closed = [*points, points[0]]
    lengths = [math.dist(a, b) for a, b in zip(closed, closed[1:])]
    total = sum(lengths)
    count = round(total / spacing)
    resampled = []
    segment = 0
    walked = 0.0
    for i in range(count):
        target = total * i / count
        while walked + lengths[segment] < target:
            walked += lengths[segment]
            segment += 1
        t = (target - walked) / lengths[segment] if lengths[segment] else 0.0
        a, b = closed[segment], closed[segment + 1]
        resampled.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return resampled, total


def build_track(track_id: int, name: str, country: str, raw: dict) -> dict:
    rotation = raw["Rotation"]
    # Source coordinates are in decimetres. Y is flipped for screen coordinates.
    def to_map(x: float, y: float) -> tuple[float, float]:
        rx, ry = rotate(x / 10, y / 10, rotation)
        return rx, -ry

    points, length = resample_closed([to_map(x, y) for x, y in zip(raw["TrackX"], raw["TrackY"])], SPACING_M)

    corners = []
    previous_distance = 0.0
    for label, x, y, angle, distance, fallback_distance in zip(
        raw["CornerLabel"], raw["X"], raw["Y"], raw["Angle"], raw["Distance"], raw["MVDistance"]
    ):
        # The archive has a wrong Distance for at least Baku T20, seen as a corner that goes backwards.
        if distance < previous_distance:
            distance = fallback_distance
        previous_distance = distance
        corner_at = to_map(x, y)
        window = round(CORNER_SEARCH_M / SPACING_M)
        center = round(distance / length * len(points))
        nearest = min(
            (i % len(points) for i in range(center - window, center + window + 1)),
            key=lambda i: math.dist(points[i], corner_at),
        )
        label_x, label_y = rotate(1.0, 0.0, angle + rotation)
        corners.append(
            {
                "label": label,
                "fraction": round(nearest / len(points), 5),
                "labelDir": [round(label_x, 3), round(-label_y, 3)],
            }
        )

    return {
        "id": track_id,
        "name": name,
        "country": country,
        "lengthM": round(length),
        "points": [[round(x, 1), round(y, 1)] for x, y in points],
        "corners": corners,
    }


def build_reverse(track_id: int, base: dict) -> dict:
    # Keep the start point first. Corner numbers are left out because the
    # reversed layouts aren't numbered the same way as the real circuits.
    return {
        **base,
        "id": track_id,
        "name": f"{base['name']} (reverse)",
        "points": [base["points"][0], *reversed(base["points"][1:])],
        "corners": [],
    }


def main() -> None:
    tracks = {}
    for track_id, name, country, grand_prix in TRACKS:
        tracks[track_id] = build_track(track_id, name, country, fetch_corners(grand_prix))
        print(f"{name}: {tracks[track_id]['lengthM']} m, {len(tracks[track_id]['points'])} points")
    for track_id, base_id in REVERSE_TRACKS:
        tracks[track_id] = build_reverse(track_id, tracks[base_id])
    ordered = sorted(tracks.values(), key=lambda track: track["name"])
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Written: {OUTPUT} ({OUTPUT.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    main()
