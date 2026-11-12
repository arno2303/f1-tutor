"""SQLite storage for saved driving sessions: lap times plus each lap's telemetry."""

import contextlib
import datetime
import pathlib
import sqlite3
import threading
import zlib

SCHEMA_VERSION = 1
# A trace is these channels one after another, each `cells` little-endian 32-bit floats.
TRACE_CHANNELS = ("speed", "throttle", "brake", "gear", "steer", "time", "x", "z")
BYTES_PER_CELL = len(TRACE_CHANNELS) * 4

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    session_uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    saved_at TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    track_name TEXT NOT NULL,
    track_length INTEGER NOT NULL,
    session_type INTEGER NOT NULL,
    formula INTEGER NOT NULL,
    team_id INTEGER,
    driver_name TEXT NOT NULL DEFAULT '',
    race_number INTEGER,
    weather INTEGER,
    track_temp INTEGER,
    air_temp INTEGER,
    game_version TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_track ON sessions (track_id, saved_at);
CREATE TABLE IF NOT EXISTS laps (
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    lap_number INTEGER NOT NULL,
    lap_ms INTEGER NOT NULL,
    s1_ms INTEGER,
    s2_ms INTEGER,
    s3_ms INTEGER,
    valid INTEGER NOT NULL,
    clean INTEGER NOT NULL,
    cells INTEGER NOT NULL,
    trace BLOB NOT NULL,
    PRIMARY KEY (session_id, lap_number)
);
"""

SESSION_COLUMNS = {
    "session_uid": "sessionUid",
    "track_id": "trackId",
    "track_name": "trackName",
    "track_length": "trackLength",
    "session_type": "sessionType",
    "formula": "formula",
    "team_id": "teamId",
    "driver_name": "driverName",
    "race_number": "raceNumber",
    "weather": "weather",
    "track_temp": "trackTemp",
    "air_temp": "airTemp",
    "game_version": "gameVersion",
}


NULLABLE_DETAILS = {"team_id", "race_number", "weather", "track_temp", "air_temp", "game_version"}


def utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


class ResultsDb:
    """Opens a connection per call, because API requests run on different threads.

    The file is created on first use, so an install that never saves leaves none behind.
    """

    def __init__(self, path: pathlib.Path) -> None:
        self.path = path
        self._ready = False
        self._setup_lock = threading.Lock()

    def _setup(self) -> None:
        # Two first requests can arrive together; the schema is made once, in one transaction.
        with self._setup_lock:
            if self._ready:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with contextlib.closing(sqlite3.connect(self.path, timeout=10)) as connection:
                if connection.execute("PRAGMA user_version").fetchone()[0] == 0:
                    connection.executescript(f"BEGIN IMMEDIATE; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;")
            self._ready = True

    @contextlib.contextmanager
    def _connect(self):
        """A connection for one call: committed on success, rolled back on error, always closed."""
        self._setup()
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            with connection:
                yield connection
        finally:
            connection.close()

    def save_session(self, session: dict) -> int:
        """Store a session and its laps. Saving the same session again adds to it.

        Laps already stored are kept unless the new save has the same lap number:
        the browser forgets its laps on a reload, and that mustn't erase saved ones.
        """
        values = {column: session.get(field) for column, field in SESSION_COLUMNS.items()}
        with self._connect() as connection:
            names = ", ".join(values)
            marks = ", ".join(f":{column}" for column in values)
            # A later save made before the game resent the driver details keeps the earlier ones.
            def keep_known(column: str) -> str:
                if column == "driver_name":
                    return f"{column} = COALESCE(NULLIF(excluded.{column}, ''), sessions.{column})"
                if column in NULLABLE_DETAILS:
                    return f"{column} = COALESCE(excluded.{column}, sessions.{column})"
                return f"{column} = excluded.{column}"

            updates = ", ".join(keep_known(column) for column in values if column != "session_uid")
            # An empty name on a later save keeps the name given earlier.
            session_id = connection.execute(
                f"""
                INSERT INTO sessions ({names}, name, saved_at) VALUES ({marks}, :name, :saved_at)
                ON CONFLICT (session_uid) DO UPDATE SET
                    {updates},
                    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE sessions.name END,
                    saved_at = excluded.saved_at
                RETURNING id
                """,
                {**values, "name": session.get("name") or "", "saved_at": utc_now()},
            ).fetchone()["id"]
            connection.executemany(
                """
                INSERT OR REPLACE INTO laps
                    (session_id, lap_number, lap_ms, s1_ms, s2_ms, s3_ms, valid, clean, cells, trace)
                VALUES (:session_id, :lap, :ms, :s1, :s2, :s3, :valid, :clean, :cells, :trace)
                """,
                [
                    {**lap, "session_id": session_id, "trace": zlib.compress(lap["trace"], 6)}
                    for lap in session["laps"]
                ],
            )
        return session_id

    def list_sessions(self, track_id: int | None = None) -> list[dict]:
        """Saved sessions with their summary, newest first."""
        with self._connect() as connection:
            where = "" if track_id is None else "WHERE track_id = ?"
            sessions = connection.execute(
                f"SELECT * FROM sessions {where} ORDER BY saved_at DESC, id DESC",
                () if track_id is None else (track_id,),
            ).fetchall()
            return [self._summary(connection, row) for row in sessions]

    def get_session(self, session_id: int) -> dict | None:
        """A session with its lap table, without the telemetry."""
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None:
                return None
            laps = connection.execute(
                """
                SELECT lap_number, lap_ms, s1_ms, s2_ms, s3_ms, valid, clean
                FROM laps WHERE session_id = ? ORDER BY lap_number
                """,
                (session_id,),
            ).fetchall()
            return {
                **self._summary(connection, row),
                "laps": [
                    {
                        "lap": lap["lap_number"],
                        "ms": lap["lap_ms"],
                        "s1": lap["s1_ms"],
                        "s2": lap["s2_ms"],
                        "s3": lap["s3_ms"],
                        "valid": bool(lap["valid"]),
                        "clean": bool(lap["clean"]),
                    }
                    for lap in laps
                ],
            }

    def get_trace(self, session_id: int, lap_number: int) -> tuple[int, bytes] | None:
        """A lap's telemetry as (cells, raw channels)."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT cells, trace FROM laps WHERE session_id = ? AND lap_number = ?", (session_id, lap_number)
            ).fetchone()
            return None if row is None else (row["cells"], zlib.decompress(row["trace"]))

    def delete_session(self, session_id: int) -> bool:
        with self._connect() as connection:
            return connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,)).rowcount > 0

    @staticmethod
    def _summary(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
        stats = connection.execute(
            """
            SELECT COUNT(*) AS lap_count,
                   COALESCE(SUM(valid), 0) AS valid_count,
                   MIN(CASE WHEN valid THEN s1_ms END) AS best_s1,
                   MIN(CASE WHEN valid THEN s2_ms END) AS best_s2,
                   MIN(CASE WHEN valid THEN s3_ms END) AS best_s3
            FROM laps WHERE session_id = ?
            """,
            (row["id"],),
        ).fetchone()
        best = connection.execute(
            "SELECT lap_number, lap_ms FROM laps WHERE session_id = ? AND valid ORDER BY lap_ms LIMIT 1",
            (row["id"],),
        ).fetchone()
        return {
            "id": row["id"],
            "name": row["name"],
            "savedAt": row["saved_at"],
            **{field: row[column] for column, field in SESSION_COLUMNS.items()},
            "lapCount": stats["lap_count"],
            "validLapCount": stats["valid_count"],
            "bestLapNumber": best["lap_number"] if best else None,
            "bestLapMs": best["lap_ms"] if best else None,
            "bestS1": stats["best_s1"],
            "bestS2": stats["best_s2"],
            "bestS3": stats["best_s3"],
        }
