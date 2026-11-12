// Pieces shared by the live chart and the lap analysis chart.

import type { MessageKey } from '../i18n'
import { GRID_M, type Channel } from './lapRecorder'

export interface Lane {
  id: Channel | 'delta' | 'realDelta'
  label: MessageKey
  weight: number
  min: number
  max: number
  ticks?: number[]
  format: (value: number) => string
  step?: boolean
  wash?: boolean
  zero?: boolean
}

export const percent = (value: number) => `${Math.round(value * 100)} %`
export const gearText = (value: number) => (value < 0 ? 'R' : value === 0 ? 'N' : String(Math.round(value)))

/** The lanes both charts show for the car itself. */
export const DRIVING_LANES: Lane[] = [
  { id: 'speed', label: 'lane.speed', weight: 2.7, min: 0, max: 360, ticks: [100, 200, 300], format: (v) => `${Math.round(v)} km/h` },
  { id: 'throttle', label: 'lane.throttle', weight: 1, min: 0, max: 1, format: percent, wash: true },
  { id: 'brake', label: 'lane.brake', weight: 1, min: 0, max: 1, format: percent, wash: true },
  { id: 'gear', label: 'lane.gear', weight: 1, min: 0, max: 9, format: gearText, step: true },
  { id: 'steer', label: 'lane.steer', weight: 1, min: -1, max: 1, format: (v) => v.toFixed(2), zero: true },
]

/** Draws one series over a range of 2 m cells; NaN leaves a gap. An optional wash fills down to a baseline. */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  fromCell: number,
  toCell: number,
  xOf: (metres: number) => number,
  yOf: (value: number) => number,
  value: (cell: number) => number,
  color: string,
  step: boolean,
  washBase: number | null,
) {
  ctx.beginPath()
  let drawing = false
  let lastY = 0
  let wash: Path2D | null = washBase !== null ? new Path2D() : null
  let washStart: number | null = null
  let lastX = 0
  const closeWash = () => {
    if (wash && washStart !== null) {
      wash.lineTo(lastX, washBase!)
      wash.lineTo(washStart, washBase!)
      wash.closePath()
    }
    washStart = null
  }
  for (let cell = fromCell; cell <= toCell; cell++) {
    const v = value(cell)
    if (Number.isNaN(v)) {
      drawing = false
      closeWash()
      continue
    }
    const x = xOf(cell * GRID_M)
    const y = yOf(v)
    if (!drawing) {
      ctx.moveTo(x, y)
      drawing = true
    } else {
      if (step) ctx.lineTo(x, lastY)
      ctx.lineTo(x, y)
    }
    if (wash) {
      if (washStart === null) {
        washStart = x
        wash.moveTo(x, washBase!)
      }
      wash.lineTo(x, y)
    }
    lastY = y
    lastX = x
  }
  closeWash()
  ctx.strokeStyle = color
  ctx.stroke()
  if (wash) {
    ctx.globalAlpha = 0.1
    ctx.fillStyle = color
    ctx.fill(wash)
    ctx.globalAlpha = 1
  }
}
