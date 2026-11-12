// Moves the car evenly between the game's updates, even if they arrive unevenly.

const MAX_PREDICTION_S = 0.25
// How quickly the shown position catches up with the prediction.
const CATCH_UP_MS = 80
// Further apart than this is a real jump: a new lap, a flashback, or data after a gap.
const SNAP_M = 40

export class DistanceSmoother {
  private sampleM: number | null = null
  private speedMs = 0
  private sampleAt = 0
  private shown: number | null = null
  private shownAt = 0

  /** Call only for new game data. A repeated value must not restart the prediction. */
  sample(distanceM: number, speedKmh: number, now: number): void {
    this.sampleM = distanceM
    this.speedMs = speedKmh / 3.6
    this.sampleAt = now
  }

  value(now: number): number | null {
    if (this.sampleM === null) return null
    const elapsed = Math.min((now - this.sampleAt) / 1000, MAX_PREDICTION_S)
    const predicted = this.sampleM + this.speedMs * Math.max(0, elapsed)
    if (this.shown === null || Math.abs(predicted - this.shown) > SNAP_M) {
      this.shown = predicted
    } else {
      const step = (predicted - this.shown) * (1 - Math.exp(-(now - this.shownAt) / CATCH_UP_MS))
      // Small corrections only ever slow the car down: it never drives backwards on screen.
      if (step > 0) this.shown += step
    }
    this.shownAt = now
    return this.shown
  }
}
