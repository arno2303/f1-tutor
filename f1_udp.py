"""Decoder and console reader for the F1 25 UDP telemetry stream (packet format 2025).

The telemetry app is server.py; running this file directly prints the live data,
which is handy for checking the connection to the game without a browser.

Usage: python3 f1_udp.py [--port 20777] [--hz 10]

In-game settings: UDP Telemetry = On, UDP Format = 2025, UDP Port = 20777,
UDP IP Address = the IP of this computer.
"""

import argparse
import socket
import struct
import time
from collections.abc import Callable, Iterator
from typing import NamedTuple

DEFAULT_PORT = 20777
PACKET_FORMAT = 2025
CAR_COUNT = 22
IDLE_TIMEOUT_S = 5.0


class Header(NamedTuple):
    packet_format: int
    game_year: int
    game_major_version: int
    game_minor_version: int
    packet_version: int
    packet_id: int
    session_uid: int
    session_time: float
    frame_id: int
    overall_frame_id: int
    player_car_index: int
    secondary_player_car_index: int


class Motion(NamedTuple):
    x: float  # metres; the track plane is X/Z, Y points up
    y: float
    z: float
    g_lat: float
    g_long: float
    g_vert: float


class Session(NamedTuple):
    weather: int
    track_temp: int
    air_temp: int
    total_laps: int
    track_length: int  # metres
    session_type: int
    track_id: int  # -1 = unknown
    formula: int
    time_left: int  # seconds
    duration: int  # seconds
    pit_speed_limit: int
    game_paused: int
    safety_car: int
    sector2_start: float  # metres
    sector3_start: float  # metres


class LapData(NamedTuple):
    last_lap_ms: int
    current_lap_ms: int
    sector1_ms: int
    sector1_min: int
    sector2_ms: int
    sector2_min: int
    lap_distance: float  # metres from the start line, negative before crossing it
    position: int
    lap_num: int
    pit_status: int
    pit_stops: int
    sector: int  # 0-based
    lap_invalid: int
    penalties_s: int
    warnings: int
    corner_cutting_warnings: int
    driver_status: int  # 0 garage, 1 flying lap, 2 in lap, 3 out lap, 4 on track


class Participant(NamedTuple):
    ai_controlled: int
    team_id: int
    race_number: int
    nationality: int
    raw_name: bytes
    platform: int

    @property
    def name(self) -> str:
        return self.raw_name.split(b"\0", 1)[0].decode("utf-8", "replace")


class CarTelemetry(NamedTuple):
    speed: int  # km/h
    throttle: float  # 0..1
    steer: float  # -1 (full left) .. 1 (full right)
    brake: float  # 0..1
    clutch: int
    gear: int  # -1 = reverse, 0 = neutral
    rpm: int
    drs: int
    rev_percent: int
    rev_lights: int  # bit 0 = leftmost of 15 LEDs
    # Per-wheel values are ordered rear left, rear right, front left, front right.
    brake_temps: tuple[int, ...]
    tyre_surface_temps: tuple[int, ...]
    tyre_inner_temps: tuple[int, ...]
    engine_temp: int
    tyre_pressures: tuple[float, ...]


class CarStatus(NamedTuple):
    fuel_mix: int
    brake_bias: int
    pit_limiter: int
    fuel_kg: float
    fuel_capacity_kg: float
    fuel_laps: float
    max_rpm: int
    idle_rpm: int
    drs_allowed: int
    drs_distance: int  # metres until DRS opens, 0 = not available yet
    actual_compound: int
    visual_compound: int
    tyre_age_laps: int
    fia_flag: int
    ers_store_j: float
    ers_mode: int
    ers_deployed_j: float


class CarDamage(NamedTuple):
    tyre_wear: tuple[float, ...]  # percent, same wheel order as CarTelemetry
    tyre_damage: tuple[int, ...]
    brake_damage: tuple[int, ...]
    front_left_wing: int
    front_right_wing: int
    rear_wing: int
    floor: int
    diffuser: int
    sidepod: int
    drs_fault: int
    ers_fault: int
    gearbox: int
    engine: int


HEADER = struct.Struct("<HBBBBBQfIIBB")

# Per-car layouts. "x" skips fields we don't use while keeping each struct at
# its full on-wire size, so layout.size is also the distance between cars.
MOTION = struct.Struct(
    "<fff"  # world position
    "12x"  # world velocity
    "12x"  # forward and right direction vectors
    "fff"  # g-force lateral, longitudinal, vertical
    "12x"  # yaw, pitch, roll
)
SESSION = struct.Struct(
    "<BbbBH"  # weather, track and air temperature, total laps, track length
    "BbB"  # session type, track id, formula
    "HH"  # session time left, duration
    "BB"  # pit speed limit, game paused
    "4x"  # spectating, spectator car, SLI Pro, number of marshal zones
    "105x"  # marshal zones
    "B"  # safety car status
    "2x"  # network game, number of forecast samples
    "512x"  # weather forecast samples
    "77x"  # assists, rules and weekend settings
    "ff"  # sector 2 and sector 3 start distance
)
LAP_DATA = struct.Struct(
    "<II"  # last and current lap time
    "HBHB"  # sector 1 and sector 2 time (milliseconds part, minutes part)
    "6x"  # deltas to the car in front and to the leader
    "f"  # lap distance
    "8x"  # total distance, safety car delta
    "BBBBBB"  # car position, lap number, pit status, pit stops, sector, lap invalid
    "BBB"  # penalties, total warnings, corner cutting warnings
    "2x"  # unserved drive-through and stop-go penalties
    "x"  # grid position
    "B"  # driver status
    "12x"  # result status, pit timers, speed trap
)
PARTICIPANT = struct.Struct(
    "<B"  # AI controlled
    "2x"  # driver id, network id
    "B"  # team id
    "x"  # my team
    "BB"  # race number, nationality
    "32s"  # name
    "2x"  # your telemetry, show online names
    "2x"  # tech level
    "B"  # platform
    "13x"  # number of colours, livery colours
)
CAR_TELEMETRY = struct.Struct(
    "<H"  # speed
    "fff"  # throttle, steer, brake
    "Bb"  # clutch, gear
    "H"  # engine rpm
    "BBH"  # drs, rev lights percent, rev lights bits
    "4H"  # brake temperatures
    "4B4B"  # tyre surface and inner temperatures
    "H"  # engine temperature
    "4f"  # tyre pressures
    "4x"  # surface type
)
CAR_STATUS = struct.Struct(
    "<2x"  # traction control, ABS
    "BBB"  # fuel mix, brake bias, pit limiter
    "fff"  # fuel in tank, capacity, remaining laps
    "HH"  # max rpm, idle rpm
    "x"  # max gears
    "BH"  # DRS allowed, DRS activation distance
    "BBBb"  # actual compound, visual compound, tyre age, FIA flag
    "8x"  # engine power ICE, MGU-K
    "fB"  # ERS store energy, ERS mode
    "8x"  # harvested MGU-K, MGU-H
    "f"  # ERS deployed this lap
    "x"  # network paused
)
CAR_DAMAGE = struct.Struct(
    "<4f"  # tyre wear
    "4B4B"  # tyre damage, brake damage
    "4x"  # tyre blisters
    "6B"  # wings, floor, diffuser, sidepod
    "2B"  # DRS fault, ERS fault
    "2B"  # gearbox, engine
    "6x"  # power unit component wear
    "2x"  # engine blown, seized
)


def _car_telemetry(v: tuple) -> CarTelemetry:
    return CarTelemetry(*v[:10], v[10:14], v[14:18], v[18:22], v[22], v[23:27])


def _car_damage(v: tuple) -> CarDamage:
    return CarDamage(v[:4], v[4:8], v[8:12], *v[12:])


class PacketSpec(NamedTuple):
    build: Callable[[tuple], NamedTuple]
    layout: struct.Struct
    size: int  # total datagram size
    per_car: bool = True  # False: one record for the session, not one per car
    payload_prefix: int = 0  # bytes between the header and the first record


PACKETS = {
    0: PacketSpec(Motion._make, MOTION, 1349),
    1: PacketSpec(Session._make, SESSION, 753, per_car=False),
    2: PacketSpec(LapData._make, LAP_DATA, 1285),
    4: PacketSpec(Participant._make, PARTICIPANT, 1284, payload_prefix=1),  # prefix: active car count
    6: PacketSpec(_car_telemetry, CAR_TELEMETRY, 1352),
    7: PacketSpec(CarStatus._make, CAR_STATUS, 1239),
    10: PacketSpec(_car_damage, CAR_DAMAGE, 1041),
}


def parse_header(data: bytes) -> Header | None:
    """Return the packet header, or None if the datagram is too short to hold one."""
    if len(data) < HEADER.size:
        return None
    return Header._make(HEADER.unpack_from(data))


class PacketSizeError(ValueError):
    """A datagram whose size doesn't match the 2025 layout of its packet type."""

    def __init__(self, packet_id: int, size: int, expected: int) -> None:
        super().__init__(f"Packet {packet_id} is {size} B instead of {expected} B, so it is skipped.")
        self.packet_id = packet_id
        self.size = size
        self.expected = expected


def decode_player_car(header: Header, data: bytes) -> tuple | None:
    """Return the session record or the player's car data, or None if this packet type isn't decoded.

    Raises PacketSizeError if the datagram size doesn't match the 2025 layout.
    """
    spec = PACKETS.get(header.packet_id)
    # While spectating there is no player car (index 255), but the session record still applies.
    if spec is None or (spec.per_car and header.player_car_index >= CAR_COUNT):
        return None
    if len(data) != spec.size:
        raise PacketSizeError(header.packet_id, len(data), spec.size)
    car = header.player_car_index if spec.per_car else 0
    return spec.build(spec.layout.unpack_from(data, HEADER.size + spec.payload_prefix + car * spec.layout.size))


def receive_datagrams(
    port: int = DEFAULT_PORT, idle_timeout: float = IDLE_TIMEOUT_S
) -> Iterator[tuple[bytes, str] | None]:
    """Yield (datagram, sender IP) as they arrive, or None after idle_timeout seconds of silence."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("0.0.0.0", port))
        sock.settimeout(idle_timeout)
        while True:
            try:
                data, (sender_ip, _) = sock.recvfrom(2048)
            except TimeoutError:
                yield None
            else:
                yield data, sender_ip


def format_lap_time(ms: int) -> str:
    minutes, rest = divmod(ms, 60_000)
    return f"{minutes}:{rest / 1000:06.3f}"


def format_status_line(latest: dict[type, NamedTuple]) -> str:
    """Build one printable line from the newest data received for each packet type."""
    parts = []
    if lap := latest.get(LapData):
        invalid = " INVALID" if lap.lap_invalid else ""
        parts += [
            f"lap {lap.lap_num:2d}{invalid}",
            f"{lap.lap_distance:7.1f} m",
            format_lap_time(lap.current_lap_ms),
        ]
    if tel := latest.get(CarTelemetry):
        gear = {-1: "R", 0: "N"}.get(tel.gear, str(tel.gear))
        parts += [
            f"{tel.speed:3d} km/h",
            f"gear {gear}",
            f"{tel.rpm:5d} rpm",
            f"throttle {tel.throttle:4.0%}",
            f"brake {tel.brake:4.0%}",
            f"steer {tel.steer:+.2f}",
            "DRS ON" if tel.drs else "DRS OFF",
        ]
    if motion := latest.get(Motion):
        parts += [
            f"gLat {motion.g_lat:+.2f} gLong {motion.g_long:+.2f}",
            f"X {motion.x:+.1f} Z {motion.z:+.1f}",
        ]
    return " | ".join(parts)


def print_udp_telemetry(port: int = DEFAULT_PORT, print_hz: float = 10.0) -> None:
    """Listen for F1 25 UDP packets and print the player's live data until interrupted."""
    print(f"Listening on UDP port {port}… (Ctrl+C to stop)", flush=True)
    print_interval = 1.0 / print_hz
    next_print = 0.0
    latest: dict[type, NamedTuple] = {}
    warned: set[str] = set()
    connected = False

    def warn_once(message: str) -> None:
        if message not in warned:
            warned.add(message)
            print(message, flush=True)

    for datagram in receive_datagrams(port):
        if datagram is None:
            connected = False
            print(
                f"No data for {IDLE_TIMEOUT_S:.0f} s. In the game, check: UDP Telemetry = On, "
                f"UDP Port = {port}, UDP IP Address = this computer's IP.",
                flush=True,
            )
            continue

        data, sender_ip = datagram
        header = parse_header(data)
        if header is None:
            continue
        if header.packet_format != PACKET_FORMAT:
            warn_once(
                f"Receiving UDP format {header.packet_format} from {sender_ip}; only {PACKET_FORMAT} is "
                f"supported. In the game, set UDP Format = {PACKET_FORMAT}."
            )
            continue
        if not connected:
            connected = True
            print(
                f"Receiving data from {sender_ip} – F1 {header.game_year} "
                f"v{header.game_major_version}.{header.game_minor_version:02d}, "
                f"format {header.packet_format}.",
                flush=True,
            )

        try:
            car = decode_player_car(header, data)
        except ValueError as err:
            warn_once(str(err))
            continue
        if car is None:
            continue
        latest[type(car)] = car

        now = time.monotonic()
        if now >= next_print:
            next_print = now + print_interval
            print(format_status_line(latest), flush=True)


def positive_float(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return number


def main() -> None:
    parser = argparse.ArgumentParser(description="Print live F1 25 telemetry received over UDP.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="UDP port (default: %(default)s)")
    parser.add_argument(
        "--hz", type=positive_float, default=10.0, help="lines printed per second (default: %(default)s)"
    )
    args = parser.parse_args()
    try:
        print_udp_telemetry(args.port, args.hz)
    except KeyboardInterrupt:
        print("\nStopped.")
    except OSError as err:
        raise SystemExit(f"Port {args.port} can't be opened: {err}")


if __name__ == "__main__":
    main()
