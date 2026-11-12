export function formatLapTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const minutes = Math.floor(ms / 60000)
  const seconds = (ms - minutes * 60000) / 1000
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}

export function formatSector(ms: number | null | undefined): string {
  if (!ms) return '—'
  const seconds = ms / 1000
  return seconds >= 60 ? formatLapTime(ms) : seconds.toFixed(3)
}

export function formatDelta(seconds: number | null | undefined, digits = 3): string {
  if (seconds === null || seconds === undefined) return '—'
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : '±'
  return `${sign}${Math.abs(seconds).toFixed(digits)}`
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}
