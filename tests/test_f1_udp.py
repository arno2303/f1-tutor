import math
import pathlib
import signal
import socket
import struct
import subprocess
import sys
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import f1_udp

# Complete on-wire layouts written out field by field, independent of the
# skip-based layouts in f1_udp, so a wrong offset there can't hide here.
FULL_HEADER = "<HBBBBBQfIIBB"
FULL_MOTION = "<6f6h6f"
FULL_LAP = "<IIHBHBHBHBfff15BHHBfB"
FULL_TELEMETRY = "<HfffBbHBBH4H4B4BH4f4B"
PLAYER = 19
DATA_DIR = pathlib.Path(__file__).resolve().parent / "data"


def header(packet_id, packet_format=2025, player=PLAYER):
    return struct.pack(FULL_HEADER, packet_format, 25, 1, 18, 1, packet_id, 123, 1.5, 7, 7, player, 255)


def motion_car(i):
    return struct.pack(
        FULL_MOTION, 100.0 + i, 5.0, -200.0 - i, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1.25, -2.5, 0.5, 0.1, 0.2, 0.3
    )


def lap_car(i):
    u8s = [11, 3 + i, 1, 0, 2, 1, 0, 0, 0, 0, 0, 5, 4, 2, 0]
    return struct.pack(FULL_LAP, 89496, 45123, 1, 2, 3, 4, 5, 6, 7, 8, 1543.5 + i, 9e3, 0.0, *u8s, 0, 0, 0, 300.0, 2)


def telemetry_car(i):
    return struct.pack(
        FULL_TELEMETRY,
        250 + i, 0.75, -0.5, 0.25, 0, 5, 11234, 1, 50, 3,
        *[500] * 4, *[90] * 4, *[95] * 4, 110, *[22.5] * 4, *[0] * 4,
    )


def packet(packet_id, car, trailer, **kwargs):
    return header(packet_id, **kwargs) + b"".join(car(i) for i in range(22)) + trailer


def motion_packet(**kwargs):
    return packet(0, motion_car, b"", **kwargs)


def lap_packet(**kwargs):
    return packet(2, lap_car, b"\xff\xff", **kwargs)


def telemetry_packet(**kwargs):
    return packet(6, telemetry_car, b"\xff\xff\x00", **kwargs)


def decode(data):
    return f1_udp.decode_player_car(f1_udp.parse_header(data), data)


class LayoutTests(unittest.TestCase):
    def test_struct_sizes_match_the_spec(self):
        self.assertEqual(f1_udp.HEADER.size, 29)
        self.assertEqual(f1_udp.MOTION.size, 60)
        self.assertEqual(f1_udp.LAP_DATA.size, 57)
        self.assertEqual(f1_udp.CAR_TELEMETRY.size, 60)
        self.assertEqual(f1_udp.SESSION.size, 724)
        self.assertEqual(f1_udp.PARTICIPANT.size, 57)
        self.assertEqual(f1_udp.CAR_STATUS.size, 55)
        self.assertEqual(f1_udp.CAR_DAMAGE.size, 46)
        self.assertEqual(struct.calcsize(FULL_LAP), 57)
        self.assertEqual(struct.calcsize(FULL_TELEMETRY), 60)
        self.assertEqual(struct.calcsize(FULL_MOTION), 60)

    def test_packet_sizes_match_the_table(self):
        for build in (motion_packet, lap_packet, telemetry_packet):
            data = build()
            self.assertEqual(len(data), f1_udp.PACKETS[f1_udp.parse_header(data).packet_id].size)


class DecodeTests(unittest.TestCase):
    def test_header(self):
        parsed = f1_udp.parse_header(telemetry_packet())
        self.assertEqual(parsed.packet_format, 2025)
        self.assertEqual(parsed.packet_id, 6)
        self.assertEqual(parsed.session_uid, 123)
        self.assertEqual(parsed.player_car_index, PLAYER)
        self.assertEqual(parsed.secondary_player_car_index, 255)

    def test_short_datagram_has_no_header(self):
        self.assertIsNone(f1_udp.parse_header(b"\x00" * 28))

    def test_motion_reads_the_players_car(self):
        car = decode(motion_packet())
        self.assertIsInstance(car, f1_udp.Motion)
        self.assertEqual(car, (100.0 + PLAYER, 5.0, -200.0 - PLAYER, 1.25, -2.5, 0.5))

    def test_lap_data_reads_the_players_car(self):
        car = decode(lap_packet())
        self.assertIsInstance(car, f1_udp.LapData)
        self.assertEqual(car.last_lap_ms, 89496)
        self.assertEqual(car.current_lap_ms, 45123)
        self.assertEqual((car.sector1_ms, car.sector1_min, car.sector2_ms, car.sector2_min), (1, 2, 3, 4))
        self.assertEqual(car.lap_distance, 1543.5 + PLAYER)
        self.assertEqual((car.position, car.lap_num, car.pit_status, car.sector, car.lap_invalid), (11, 3 + PLAYER, 1, 2, 1))
        self.assertEqual(car.driver_status, 4)

    def test_telemetry_reads_the_players_car(self):
        car = decode(telemetry_packet())
        self.assertIsInstance(car, f1_udp.CarTelemetry)
        self.assertEqual(car[:10], (250 + PLAYER, 0.75, -0.5, 0.25, 0, 5, 11234, 1, 50, 3))
        self.assertEqual(car.brake_temps, (500,) * 4)
        self.assertEqual(car.tyre_surface_temps, (90,) * 4)
        self.assertEqual(car.tyre_inner_temps, (95,) * 4)
        self.assertEqual(car.engine_temp, 110)
        self.assertEqual(car.tyre_pressures, (22.5,) * 4)

    def test_first_and_last_car_slots_are_in_bounds(self):
        self.assertEqual(decode(telemetry_packet(player=0)).speed, 250)
        self.assertEqual(decode(telemetry_packet(player=21)).speed, 271)
        self.assertEqual(decode(lap_packet(player=21)).lap_num, 24)

    def test_unknown_packet_type_is_ignored(self):
        data = header(3) + b"\x00" * 16
        self.assertIsNone(decode(data))

    def test_invalid_player_index_is_ignored(self):
        self.assertIsNone(decode(telemetry_packet(player=255)))

    def test_session_is_read_while_spectating(self):
        data = bytearray((DATA_DIR / "Session.bin").read_bytes())
        data[27] = 255  # no player car
        self.assertEqual(decode(bytes(data)).track_id, 11)

    def test_wrong_size_is_rejected(self):
        with self.assertRaises(f1_udp.PacketSizeError) as raised:
            decode(telemetry_packet()[:-1])
        self.assertEqual((raised.exception.packet_id, raised.exception.size, raised.exception.expected), (6, 1351, 1352))


class FormatTests(unittest.TestCase):
    def test_lap_time(self):
        self.assertEqual(f1_udp.format_lap_time(89496), "1:29.496")
        self.assertEqual(f1_udp.format_lap_time(0), "0:00.000")
        self.assertEqual(f1_udp.format_lap_time(59999), "0:59.999")

    def test_line_shows_only_the_data_received_so_far(self):
        self.assertEqual(f1_udp.format_status_line({}), "")
        line = f1_udp.format_status_line({f1_udp.CarTelemetry: decode(telemetry_packet())})
        self.assertIn("269 km/h", line)
        self.assertNotIn("lap", line)

    def test_full_line(self):
        latest = {type(c): c for c in map(decode, (motion_packet(), lap_packet(), telemetry_packet()))}
        line = f1_udp.format_status_line(latest)
        for expected in (
            "lap 22 INVALID", "1562.5 m", "0:45.123", "269 km/h", "gear 5", "11234 rpm",
            "throttle  75%", "brake  25%", "steer -0.50", "DRS ON", "gLat +1.25", "gLong -2.50", "X +119.0", "Z -219.0",
        ):
            self.assertIn(expected, line)

    def test_neutral_and_reverse_gears(self):
        car = decode(telemetry_packet())
        self.assertIn("gear N", f1_udp.format_status_line({f1_udp.CarTelemetry: car._replace(gear=0)}))
        self.assertIn("gear R", f1_udp.format_status_line({f1_udp.CarTelemetry: car._replace(gear=-1)}))


class RealCaptureTests(unittest.TestCase):
    """Packets captured from F1 25 v1.18: lap 1 of a race at Monza, player in car 19."""

    @staticmethod
    def load(name):
        return decode((DATA_DIR / f"{name}.bin").read_bytes())

    def test_session(self):
        session = self.load("Session")
        self.assertEqual(session.track_id, 11)
        self.assertEqual(session.track_length, 5798)
        self.assertEqual((session.session_type, session.formula, session.total_laps), (15, 0, 19))
        self.assertEqual((session.weather, session.track_temp, session.air_temp), (2, 35, 25))
        self.assertEqual((session.time_left, session.duration, session.pit_speed_limit), (7198, 7200, 80))
        self.assertAlmostEqual(session.sector2_start, 1897.794, places=2)
        self.assertAlmostEqual(session.sector3_start, 3726.976, places=2)

    def test_participant(self):
        player = self.load("Participants")
        self.assertEqual(player.name, "RUSSELL")
        self.assertEqual((player.team_id, player.race_number, player.ai_controlled), (0, 63, 0))

    def test_lap_data_field_order(self):
        lap = self.load("LapData")
        self.assertAlmostEqual(lap.lap_distance, 290.89, places=1)
        self.assertEqual((lap.current_lap_ms, lap.lap_num, lap.position), (1675, 1, 4))
        # An EA forum post doubted the order of driver status and grid position.
        # Here the grid position would be 4 and only a status of 4 means "on track".
        self.assertEqual(lap.driver_status, 4)

    def test_telemetry(self):
        car = self.load("CarTelemetry")
        self.assertEqual((car.speed, car.gear, car.rpm), (41, 1, 4819))
        self.assertEqual(car.tyre_surface_temps, (79, 79, 70, 70))
        self.assertEqual(car.engine_temp, 110)
        self.assertAlmostEqual(car.tyre_pressures[0], 21.96, places=2)
        self.assertAlmostEqual(car.tyre_pressures[2], 24.45, places=2)

    def test_status(self):
        status = self.load("CarStatus")
        self.assertAlmostEqual(status.fuel_kg, 38.79, places=2)
        self.assertEqual(status.fuel_capacity_kg, 110.0)
        self.assertEqual((status.max_rpm, status.idle_rpm, status.brake_bias), (13099, 4000, 58))
        self.assertEqual((status.actual_compound, status.visual_compound), (17, 17))
        self.assertEqual((status.ers_store_j, status.ers_mode), (4_000_000.0, 1))

    def test_damage(self):
        damage = self.load("CarDamage")
        self.assertAlmostEqual(damage.tyre_wear[0], 0.42, places=2)
        self.assertEqual(damage.tyre_damage, (0, 0, 0, 0))
        self.assertEqual((damage.gearbox, damage.engine), (0, 0))

    def test_speed_matches_motion_velocity_for_every_car(self):
        motion = (DATA_DIR / "Motion.bin").read_bytes()
        telemetry = (DATA_DIR / "CarTelemetry.bin").read_bytes()
        for i in range(22):
            velocity = struct.unpack_from("<3f", motion, 29 + i * 60 + 12)
            speed = struct.unpack_from("<H", telemetry, 29 + i * 60)[0]
            self.assertAlmostEqual(math.hypot(*velocity) * 3.6, speed, delta=1.0, msg=f"car {i}")

    def test_name_with_accents_and_invalid_bytes(self):
        padded = "ŠTEFÁNIK".encode("utf-8").ljust(32, b"\0")
        self.assertEqual(f1_udp.Participant(0, 0, 0, 0, padded, 0).name, "ŠTEFÁNIK")
        self.assertEqual(f1_udp.Participant(0, 0, 0, 0, b"AB\xff\0", 0).name, "AB\ufffd")


def free_udp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LiveSocketTests(unittest.TestCase):
    """Runs the real script as a process and sends it real UDP datagrams."""

    def run_listener(self, packets, seconds=1.2, hz="5"):
        port = free_udp_port()
        script = pathlib.Path(f1_udp.__file__)
        proc = subprocess.Popen(
            [sys.executable, str(script), "--port", str(port), "--hz", hz],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.addCleanup(proc.kill)
        time.sleep(0.4)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                for data in packets:
                    sender.sendto(data, ("127.0.0.1", port))
                time.sleep(1 / 60)
        proc.send_signal(signal.SIGINT)
        out, err = proc.communicate(timeout=5)
        return proc.returncode, out, err

    def test_prints_live_data_at_the_requested_rate(self):
        code, out, err = self.run_listener([motion_packet(), lap_packet(), telemetry_packet()])
        self.assertEqual((code, err), (0, ""))
        self.assertIn("Receiving data from 127.0.0.1 – F1 25 v1.18, format 2025.", out)
        self.assertIn("Stopped.", out)
        lines = [line for line in out.splitlines() if "km/h" in line]
        self.assertIn("269 km/h", lines[-1])
        self.assertIn("lap 22", lines[-1])
        self.assertTrue(3 <= len(lines) <= 9, f"{len(lines)} lines at 5 Hz for 1.2 s")

    def test_other_packet_format_warns_once_and_prints_no_data(self):
        code, out, _ = self.run_listener([telemetry_packet(packet_format=2026)])
        self.assertEqual(code, 0)
        self.assertEqual(out.count("Receiving UDP format 2026"), 1)
        self.assertNotIn("km/h", out)

    def test_garbage_and_wrong_sizes_do_not_stop_the_listener(self):
        code, out, err = self.run_listener([b"x", telemetry_packet()[:-1], b"\xff" * 2000, telemetry_packet()])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out.count("is 1351 B instead of 1352 B"), 1)
        self.assertIn("269 km/h", out)

    def test_port_in_use_gives_a_clean_error(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as holder:
            holder.bind(("0.0.0.0", 0))
            port = holder.getsockname()[1]
            result = subprocess.run(
                [sys.executable, str(pathlib.Path(f1_udp.__file__)), "--port", str(port)],
                capture_output=True, text=True, timeout=5,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"Port {port} can't be opened", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
