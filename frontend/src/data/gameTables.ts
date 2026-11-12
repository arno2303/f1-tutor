// F1 25 UDP id tables. Display text comes from the translations.

import { t, tx } from '../i18n'

export interface Team {
  name: string
  color?: string
}

const CURRENT_TEAMS: Record<number, Team> = {
  0: { name: 'Mercedes', color: '#27F4D2' },
  1: { name: 'Ferrari', color: '#E80020' },
  2: { name: 'Red Bull Racing', color: '#3671C6' },
  3: { name: 'Williams', color: '#64C4FF' },
  4: { name: 'Aston Martin', color: '#229971' },
  5: { name: 'Alpine', color: '#FF87BC' },
  6: { name: 'Racing Bulls', color: '#6692FF' },
  7: { name: 'Haas', color: '#B6BABD' },
  8: { name: 'McLaren', color: '#FF8000' },
  9: { name: 'Sauber', color: '#52E252' },
}

const OTHER_TEAMS: Record<number, string> = {
  41: 'F1 Generic',
  129: 'Konnersport',
  142: "APXGP '24",
  154: "APXGP '25",
  155: "Konnersport '24",
  158: "ART Grand Prix '24",
  159: "Campos '24",
  160: "Rodin Motorsport '24",
  161: "AIX Racing '24",
  162: "DAMS '24",
  163: "Hitech '24",
  164: "MP Motorsport '24",
  165: "Prema '24",
  166: "Trident '24",
  167: "Van Amersfoort Racing '24",
  168: "Invicta '24",
  185: "Mercedes '24",
  186: "Ferrari '24",
  187: "Red Bull Racing '24",
  188: "Williams '24",
  189: "Aston Martin '24",
  190: "Alpine '24",
  191: "Racing Bulls '24",
  192: "Haas '24",
  193: "McLaren '24",
  194: "Sauber '24",
}

export function teamInfo(id: number): Team {
  if (id === 104) return { name: t('team.custom') }
  return CURRENT_TEAMS[id] ?? { name: OTHER_TEAMS[id] ?? t('team.unknown', { id }) }
}

const FORMULAS: Record<number, string> = {
  0: 'F1',
  1: 'F1 Classic',
  2: 'F2',
  3: 'F1 Generic',
  4: 'F1 Beta',
  6: 'Esports',
  8: 'F1 World',
  9: 'F1 Elimination',
}

export const formulaName = (id: number) => FORMULAS[id] ?? t('formula.unknown', { id })
export const hasErs = (formula: number | undefined) => formula !== 2

export const sessionName = (id: number) => tx(`session.${id}`, t('session.unknown'))

export const weatherName = (id: number) => tx(`weather.${id}`, '—')

// Visual compound: what the tyre looks like. Colour keys the sidewall marking.
const COMPOUND_COLORS: Record<number, string> = {
  7: '#3DDC84',
  8: '#2E9FD9',
  9: '#E8ECF2',
  10: '#2E9FD9',
  15: '#2E9FD9',
  16: '#FF3B47',
  17: '#FFB020',
  18: '#E8ECF2',
  19: '#C86BE0',
  20: '#FF3B47',
  21: '#FFB020',
  22: '#E8ECF2',
}

export const compoundInfo = (id: number | undefined) =>
  id !== undefined && COMPOUND_COLORS[id]
    ? { name: tx(`compound.${id}`, '—'), color: COMPOUND_COLORS[id] }
    : { name: '—', color: '#8791A1' }

const ACTUAL_COMPOUNDS: Record<number, string> = {
  16: 'C5',
  17: 'C4',
  18: 'C3',
  19: 'C2',
  20: 'C1',
  21: 'C0',
  22: 'C6',
}

export const actualCompoundName = (id: number | undefined) => (id !== undefined && ACTUAL_COMPOUNDS[id]) || ''

export const ersModeName = (id: number | undefined) => (id === undefined ? '—' : tx(`ers.${id}`, '—'))

export const fuelMixName = (id: number | undefined) => (id === undefined ? '—' : tx(`fuelMix.${id}`, '—'))

export const safetyCarName = (id: number) => (id ? tx(`safetyCar.${id}`, '') : '')

// vehicleFiaFlags: -1 unknown, 0 none, 1 green, 2 blue, 3 yellow
const FLAG_COLORS: Record<number, string> = { 1: '#3DDC84', 2: '#2E9FD9', 3: '#FFB020' }
export const flagInfo = (id: number | undefined) =>
  id !== undefined && FLAG_COLORS[id] ? { name: tx(`flag.${id}`, ''), color: FLAG_COLORS[id] } : undefined
