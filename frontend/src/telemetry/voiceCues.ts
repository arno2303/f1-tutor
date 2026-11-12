// Decides when to say "brake", "turn" and "throttle" as the car approaches each corner.

import { toGame, type Alignment } from './alignment'
import { brakingDistance, type BrakeEnvelope, type CornerAnalysis, type CornerZone, type DrivingPoints } from './analysis'

export type CueKind = 'brake' | 'turn' | 'throttle'
export type BrakeMode = 'driver' | 'car'

export interface Cue {
  kind: CueKind
  corner: string
  /** Lap distance in the game's own metres. */
  atM: number
}

export interface CueInput {
  zones: CornerZone[]
  refPoints: (DrivingPoints | null)[]
  /** The player's latest lap per corner, when there is one. */
  corners: CornerAnalysis[] | null
  mode: BrakeMode
  envelope: BrakeEnvelope
  alignment: Alignment
  gameLengthM: number
}

// A kink the real driver takes flat isn't worth interrupting for: radius over 300 m.
const MIN_TURN_KAPPA = 1 / 300

/** Where to start braking so the corner still works in the player's car. */
export function brakeTarget(
  ref: DrivingPoints,
  own: DrivingPoints | null,
  reserveM: number | null,
  envelope: BrakeEnvelope,
): number | null {
  if (ref.brakeM === null) return null
  if (own && own.brakeM !== null) {
    // Own point plus what the car has left, never later than the real driver.
    return Math.min(ref.brakeM, own.brakeM + Math.max(0, reserveM ?? 0))
  }
  // No lap of the player's yet: the distance this car would need for the driver's speeds.
  if (ref.brakeEndM === null || ref.speedAtBrake === null || ref.speedAtBrakeEnd === null) return ref.brakeM
  return Math.min(ref.brakeM, ref.brakeEndM - brakingDistance(ref.speedAtBrake, ref.speedAtBrakeEnd, envelope))
}

export function buildCues(input: CueInput): Cue[] {
  const { zones, refPoints, corners, mode, envelope, alignment, gameLengthM } = input
  const cues: Cue[] = []
  const place = (refM: number) => ((toGame(alignment, refM) % gameLengthM) + gameLengthM) % gameLengthM
  zones.forEach((zone, i) => {
    const ref = refPoints[i]
    if (!ref) return
    if (ref.brakeM !== null) {
      const corner = corners?.[i]
      const atM = mode === 'car' ? brakeTarget(ref, corner?.own ?? null, corner?.reserveM ?? null, envelope) : ref.brakeM
      if (atM !== null) cues.push({ kind: 'brake', corner: zone.label, atM: place(atM) })
    }
    if (ref.turnInM !== null && zone.peakKappa >= MIN_TURN_KAPPA) {
      cues.push({ kind: 'turn', corner: zone.label, atM: place(ref.turnInM) })
    }
    // Only where the driver actually came off the throttle.
    if (ref.throttleOnM !== null && ref.liftM !== null) {
      cues.push({ kind: 'throttle', corner: zone.label, atM: place(ref.throttleOnM) })
    }
  })
  return cues.sort((a, b) => a.atM - b.atM)
}

export interface CueUpdate {
  distanceM: number
  speedKmh: number
  nowMs: number
}

const MIN_SPEED_KMH = 30
// The trimmed clips last about 0.4 s. Closer than this they would talk over each
// other, so only braking may interrupt.
const MIN_GAP_MS = 500
// A rebuilt list can move a cue the driver has just heard; it isn't repeated within this time.
const REBUILD_MEMORY_MS = 5000
const cueKey = (cue: Cue) => `${cue.kind}:${cue.corner}`

/** Fires each cue once per pass, `leadS` before the car gets there. */
export class CueEngine {
  private cues: Cue[] = []
  private armed: boolean[] = []
  private lengthM = 1
  private lastFiredAt = -Infinity
  private nowMs = -Infinity
  private readonly passedAt = new Map<string, number>()

  constructor(public leadS = 1.2) {}

  setCues(cues: Cue[], gameLengthM: number): void {
    this.cues = cues
    this.lengthM = gameLengthM
    this.armed = cues.map((cue) => !(this.nowMs - (this.passedAt.get(cueKey(cue)) ?? -Infinity) < REBUILD_MEMORY_MS))
  }

  get all(): readonly Cue[] {
    return this.cues
  }

  /** The next cue ahead of a lap distance, and how far away it is. */
  next(distanceM: number): { cue: Cue; inM: number } | null {
    let best: { cue: Cue; inM: number } | null = null
    for (const cue of this.cues) {
      const inM = ((cue.atM - distanceM) % this.lengthM + this.lengthM) % this.lengthM
      if (!best || inM < best.inM) best = { cue, inM }
    }
    return best
  }

  update({ distanceM, speedKmh, nowMs }: CueUpdate): Cue | null {
    if (distanceM < 0) return null
    this.nowMs = nowMs
    const speed = speedKmh / 3.6
    const due: { cue: Cue; ahead: number }[] = []
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i]
      const ahead = ((cue.atM - distanceM) % this.lengthM + this.lengthM) % this.lengthM
      // In the half of the lap behind the car, the cue is ready for the next pass.
      if (ahead > this.lengthM / 2) {
        this.armed[i] = true
        continue
      }
      if (!this.armed[i] || speedKmh < MIN_SPEED_KMH || ahead / speed > this.leadS) continue
      this.armed[i] = false
      this.passedAt.set(cueKey(cue), nowMs)
      due.push({ cue, ahead })
    }
    if (!due.length) return null
    // Several can fall due at once (after a dropout, or close together): one clip plays,
    // braking first, then whatever the car reaches first. The rest would only talk over it.
    due.sort((x, y) => Number(y.cue.kind === 'brake') - Number(x.cue.kind === 'brake') || x.ahead - y.ahead)
    const fired = due[0].cue
    if (nowMs - this.lastFiredAt < MIN_GAP_MS && fired.kind !== 'brake') return null
    this.lastFiredAt = nowMs
    return fired
  }
}
