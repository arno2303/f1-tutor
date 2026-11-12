// Mirrors the messages built by server.py. Tick records keep the field names of
// the decoded packets in f1_udp.py; per-wheel arrays are ordered RL, RR, FL, FR.

export interface SessionMeta {
  weather: number
  trackTemp: number
  airTemp: number
  totalLaps: number
  trackLength: number
  sessionType: number
  trackId: number
  formula: number
  sector2Start: number
  sector3Start: number
}

export interface PlayerMeta {
  name: string
  teamId: number
  raceNumber: number
  nationality: number
  aiControlled: boolean
}

export interface Meta {
  type: 'meta'
  build: string | null
  udp: { ip: string | null; port: number }
  warning: { code: 'format'; format: number } | { code: 'packetSize'; packet: number; size: number; expected: number } | null
  sessionUid: string | null
  gameVersion: string | null
  session: SessionMeta | null
  player: PlayerMeta | null
}

export interface LapTick {
  last_lap_ms: number
  current_lap_ms: number
  sector1_ms: number
  sector1_min: number
  sector2_ms: number
  sector2_min: number
  lap_distance: number
  position: number
  lap_num: number
  pit_status: number
  pit_stops: number
  sector: number
  lap_invalid: number
  penalties_s: number
  warnings: number
  corner_cutting_warnings: number
  driver_status: number
}

export interface CarTick {
  speed: number
  throttle: number
  steer: number
  brake: number
  clutch: number
  gear: number
  rpm: number
  drs: number
  rev_percent: number
  rev_lights: number
  brake_temps: number[]
  tyre_surface_temps: number[]
  tyre_inner_temps: number[]
  engine_temp: number
  tyre_pressures: number[]
}

export interface MotionTick {
  x: number
  y: number
  z: number
  g_lat: number
  g_long: number
  g_vert: number
}

export interface StatusTick {
  fuel_mix: number
  brake_bias: number
  pit_limiter: number
  fuel_kg: number
  fuel_capacity_kg: number
  fuel_laps: number
  max_rpm: number
  idle_rpm: number
  drs_allowed: number
  drs_distance: number
  actual_compound: number
  visual_compound: number
  tyre_age_laps: number
  fia_flag: number
  ers_store_j: number
  ers_mode: number
  ers_deployed_j: number
}

export interface DamageTick {
  tyre_wear: number[]
  tyre_damage: number[]
  brake_damage: number[]
  front_left_wing: number
  front_right_wing: number
  rear_wing: number
  floor: number
  diffuser: number
  sidepod: number
  drs_fault: number
  ers_fault: number
  gearbox: number
  engine: number
}

export interface Tick {
  type: 'tick'
  live: boolean
  sessionTime: number | null
  frame: number | null
  udp: { hz: number; maxGapMs: number }
  paused: boolean
  safetyCar: number
  timeLeft: number | null
  lap: LapTick | null
  car: CarTick | null
  motion: MotionTick | null
  status: StatusTick | null
  damage: DamageTick | null
}
