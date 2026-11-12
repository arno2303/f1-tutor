"""Stand-in for the game: sends realistic F1 25 UDP packets, so the app can be tried without it.

Usage: python3 tools/simulate_game.py [--track 4] [--host 127.0.0.1] [--time-scale 1]

Packets are written out field by field here, independently of the layouts in
f1_udp.py, so a mistake in those can't cancel itself out. The driving itself is
invented: a speed profile computed from the shape of the track.
"""

import argparse
import json
import math
import pathlib
import random
import socket
import struct
import time

TRACKS_FILE = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "src" / "data" / "tracks.json"
PLAYER = 0
CARS = 22

HEADER = struct.Struct("<HBBBBBQfIIBB")
MOTION_CAR = struct.Struct("<6f6h6f")
LAP_CAR = struct.Struct("<IIHBHBHBHBfff15BHHBfB")
TELEMETRY_CAR = struct.Struct("<HfffBbHBBH4H4B4BH4f4B")
STATUS_CAR = struct.Struct("<5B3f2H2BH3Bb3fB3fB")
DAMAGE_CAR = struct.Struct("<4f30B")
PARTICIPANT = struct.Struct("<7B32s2BHBB12s")
SESSION_SIZE = 724

# Slower than a real F1 lap, about what the game's F2 car manages.
GRIP_LATERAL = 24.0  # m/s^2 available in a corner
ACCELERATION = 10.0
BRAKING = 26.0
TOP_SPEED = 84.0  # m/s
# The game's coordinates and start line don't match the real circuit's, so neither do these.
WORLD_ANGLE = math.radians(37)
WORLD_SHIFT = (412.0, -158.0)
LINE_OFFSET_M = 32.0
LENGTH_SCALE = 1.004


def speed_profile(points: list, spacing: float) -> tuple[list[float], list[float]]:
    """Fastest speed and curvature at each outline point, for the grip and power above."""
    n = len(points)
    window = 3
    limits = []
    curvature = []
    for i in range(n):
        ax, ay = points[(i - window) % n]
        bx, by = points[i]
        cx, cy = points[(i + window) % n]
        first = math.atan2(by - ay, bx - ax)
        second = math.atan2(cy - by, cx - bx)
        turn = math.atan2(math.sin(second - first), math.cos(second - first))
        kappa = turn / (window * spacing)
        curvature.append(kappa)
        limits.append(min(TOP_SPEED, math.sqrt(GRIP_LATERAL / max(abs(kappa), 1e-4))))
    speeds = limits[:]
    for _ in range(2):  # twice, so the limits carry across the start line
        for i in range(n):
            speeds[i] = min(speeds[i], math.sqrt(speeds[i - 1] ** 2 + 2 * ACCELERATION * spacing))
        for i in reversed(range(n)):
            speeds[i] = min(speeds[i], math.sqrt(speeds[(i + 1) % n] ** 2 + 2 * BRAKING * spacing))
    return speeds, curvature


class Simulator:
    def __init__(self, track: dict, name: str, team_id: int, formula: int, session_type: int, send_rate: int = 60) -> None:
        self.send_rate = send_rate
        self.track = track
        self.name = name
        self.team_id = team_id
        self.formula = formula
        self.session_type = session_type
        self.points = track["points"]
        self.outline_length = float(track["lengthM"])
        self.length = self.outline_length * LENGTH_SCALE
        self.spacing = self.outline_length / len(self.points)
        self.speeds, self.curvature = speed_profile(self.points, self.spacing)
        self.session_uid = random.getrandbits(63)
        self.frame = 0
        self.session_time = 0.0
        self.distance = 0.0
        self.lap_time = 0.0
        self.lap_num = 1
        self.last_lap_ms = 0
        self.pace = 0.97
        self.s1_ms = 0
        self.s2_ms = 0
        self.invalid = 0
        self.fuel = 38.0
        self.wear = 0.0
        self.prev_speed = 0.0

    def state_at(self, distance: float) -> tuple[float, float, float, float, float]:
        position = (distance / LENGTH_SCALE + LINE_OFFSET_M) / self.spacing
        i = int(position) % len(self.points)
        j = (i + 1) % len(self.points)
        t = position - int(position)
        map_x = self.points[i][0] + (self.points[j][0] - self.points[i][0]) * t
        map_y = self.points[i][1] + (self.points[j][1] - self.points[i][1]) * t
        # Rotated, moved and mirrored against the map, as real game coordinates are.
        x = map_x * math.cos(WORLD_ANGLE) - map_y * math.sin(WORLD_ANGLE) + WORLD_SHIFT[0]
        z = -(map_x * math.sin(WORLD_ANGLE) + map_y * math.cos(WORLD_ANGLE)) + WORLD_SHIFT[1]
        speed = (self.speeds[i] + (self.speeds[j] - self.speeds[i]) * t) * self.pace
        return x, z, speed, self.curvature[i], self.speeds[j] - self.speeds[i]

    def advance(self, dt: float) -> None:
        _, _, speed, _, _ = self.state_at(self.distance)
        self.frame += 1
        self.session_time += dt
        self.lap_time += dt
        self.distance += speed * dt
        self.fuel = max(0.0, self.fuel - 0.0009)
        self.wear += 0.00012
        if not self.s1_ms and self.distance >= self.length / 3:
            self.s1_ms = int(self.lap_time * 1000)
        if not self.s2_ms and self.distance >= self.length * 2 / 3:
            self.s2_ms = int(self.lap_time * 1000) - self.s1_ms
        # One lap in five goes off track for a moment, to exercise invalid laps.
        if self.lap_num % 5 == 3 and 0.4 < self.distance / self.length < 0.41:
            self.invalid = 1
        if self.distance >= self.length:
            self.distance -= self.length
            self.last_lap_ms = int(self.lap_time * 1000)
            self.lap_time = 0.0
            self.lap_num += 1
            self.s1_ms = self.s2_ms = 0
            self.invalid = 0
            self.pace = random.uniform(0.95, 1.0)

    def header(self, packet_id: int) -> bytes:
        return HEADER.pack(
            2025, 25, 1, 18, 1, packet_id, self.session_uid, self.session_time, self.frame, self.frame, PLAYER, 255
        )

    def motion(self) -> bytes:
        x, z, speed, kappa, _ = self.state_at(self.distance)
        accel = (speed - self.prev_speed) * self.send_rate
        self.prev_speed = speed
        g_lat = speed * speed * kappa / 9.81
        g_long = max(-6.0, min(3.0, accel / 9.81))
        car = MOTION_CAR.pack(x, 0.0, z, 0, 0, speed, 0, 0, 0, 0, 0, 0, g_lat, g_long, 1.0, 0, 0, 0)
        return self.header(0) + car * CARS

    def session(self) -> bytes:
        data = bytearray(SESSION_SIZE)
        struct.pack_into(
            "<BbbBHBbBHHBB",
            data,
            0,
            1,  # weather
            35,  # track temperature
            25,  # air temperature
            5,  # total laps
            int(self.length),
            self.session_type,
            self.track["id"],
            self.formula,
            3600,  # time left
            3600,  # duration
            80,  # pit speed limit
            0,  # paused
        )
        struct.pack_into("<ff", data, SESSION_SIZE - 8, self.length / 3, self.length * 2 / 3)
        return self.header(1) + bytes(data)

    def lap_data(self) -> bytes:
        sector = 0 if self.distance < self.length / 3 else 1 if self.distance < self.length * 2 / 3 else 2
        fields = [3, self.lap_num, 0, 0, sector, self.invalid, 0, 0, 0, 0, 0, 3, 1, 2, 0]
        car = LAP_CAR.pack(
            self.last_lap_ms, int(self.lap_time * 1000),
            self.s1_ms % 60000, self.s1_ms // 60000, self.s2_ms % 60000, self.s2_ms // 60000,
            0, 0, 0, 0,
            self.distance, self.distance, 0.0,
            *fields, 0, 0, 0, 0.0, 255,
        )
        return self.header(2) + car * CARS + b"\xff\xff"

    def participants(self) -> bytes:
        car = PARTICIPANT.pack(
            0, 50, 255, self.team_id, 0, 63, 10, self.name.encode("utf-8"), 1, 1, 0, 3, 0, bytes(12)
        )
        return self.header(4) + bytes([1]) + car * CARS

    def telemetry(self) -> bytes:
        _, _, speed, kappa, ahead = self.state_at(self.distance)
        braking = ahead < -0.25
        throttle = 0.0 if braking else 1.0 if ahead > 0 or speed > 80 else 0.45
        brake = min(1.0, -ahead / 1.3) if braking else 0.0
        kmh = speed * 3.6
        gear = max(1, min(8, int(kmh / 42) + 1))
        rpm = int(4000 + 9000 * ((kmh % 42) / 42) * 0.8 + 1400)
        heat = 90 + 15 * math.sin(self.distance / 400)
        rev_percent = min(100, max(0, (rpm - 8000) * 100 // 5000))
        rev_bits = (1 << (rev_percent * 15 // 100)) - 1
        car = TELEMETRY_CAR.pack(
            int(kmh), throttle, max(-1.0, min(1.0, kappa * 45)), brake, 0, gear, rpm,
            int(speed > 78), rev_percent, rev_bits,
            *[int(350 + 500 * brake)] * 4,
            *[int(heat + offset) for offset in (2, 2, -3, -3)], *[int(heat - 4)] * 4,
            105, 22.4, 22.4, 24.5, 24.5, 0, 0, 0, 0,
        )
        return self.header(6) + car * CARS + b"\xff\xff\x00"

    def status(self) -> bytes:
        store = 2_000_000 + 1_800_000 * math.sin(self.session_time / 11)
        car = STATUS_CAR.pack(
            0, 0, 1, 58, 0, self.fuel, 110.0, 1.4, 13000, 4000, 8, 1, 0, 17, 17, self.lap_num - 1, 0,
            0, 0, store, 2, 0, 0, 0, 0,
        )
        return self.header(7) + car * CARS

    def damage(self) -> bytes:
        wear = self.wear
        car = DAMAGE_CAR.pack(wear * 1.05, wear, wear * 1.15, wear * 1.1, *([0] * 30))
        return self.header(10) + car * CARS


def main() -> None:
    parser = argparse.ArgumentParser(description="Sends simulated F1 25 UDP data, to try the app without the game.")
    parser.add_argument("--track", type=int, default=4, help="track id (default: %(default)s = Barcelona)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=20777)
    parser.add_argument("--name", default="TEST DRIVER")
    parser.add_argument("--team", type=int, default=8, help="team id (default: %(default)s = McLaren)")
    parser.add_argument("--formula", type=int, default=0, help="0 = F1, 2 = F2")
    parser.add_argument("--session-type", type=int, default=15, help="default: %(default)s = race")
    parser.add_argument("--time-scale", type=float, default=1.0, help="speed-up, e.g. 4 = four times faster")
    parser.add_argument("--send-rate", type=int, default=60, choices=[10, 15, 20, 30, 35, 60], help="like UDP Send Rate in the game")
    parser.add_argument("--jitter-ms", type=float, default=0.0, help="random packet delay, like on Wi-Fi")
    args = parser.parse_args()

    tracks = {track["id"]: track for track in json.loads(TRACKS_FILE.read_text(encoding="utf-8"))}
    if args.track not in tracks:
        raise SystemExit(f"Unknown track id {args.track}. Available: {sorted(tracks)}")
    sim = Simulator(tracks[args.track], args.name, args.team, args.formula, args.session_type, args.send_rate)
    print(f"Simulating {sim.track['name']} → {args.host}:{args.port} (Ctrl+C to stop)")

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        interval = 1 / args.send_rate
        # Periods stay the same in real time whatever the send rate is.
        frames_per_second = args.send_rate
        next_frame = time.monotonic()
        try:
            while True:
                sim.advance(args.time_scale * interval)
                packets = [sim.motion(), sim.lap_data(), sim.telemetry(), sim.status()]
                if sim.frame % max(1, frames_per_second // 10) == 0:
                    packets.append(sim.damage())
                if sim.frame % max(1, frames_per_second // 2) == 1:
                    packets.append(sim.session())
                if sim.frame % (frames_per_second * 2) == 1:
                    packets.append(sim.participants())
                if args.jitter_ms:
                    time.sleep(random.uniform(0, args.jitter_ms) / 1000)
                for packet in packets:
                    sock.sendto(packet, (args.host, args.port))
                next_frame += interval
                delay = next_frame - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
        except KeyboardInterrupt:
            print("\nSimulation stopped.")


if __name__ == "__main__":
    main()
