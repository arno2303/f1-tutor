import { describe, expect, it } from 'vitest'
import en from './en'
import sk from './sk'
import { locale, t, tn, tx } from './index'

describe('translations', () => {
  it('has every English key in Slovak, with the same placeholders', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(sk[key], key).toBeTruthy()
      const holes = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
      expect(holes(sk[key]), key).toEqual(holes(en[key]))
    }
  })

  it('fills placeholders and switches language', () => {
    locale.value = 'en'
    expect(t('top.link.rate', { hz: 60 })).toBe('Game 60 Hz')
    locale.value = 'sk'
    expect(t('top.link.rate', { hz: 60 })).toBe('Hra 60 Hz')
    locale.value = 'en'
  })

  it('picks plural forms for each language', () => {
    locale.value = 'en'
    expect([1, 2, 5].map((n) => tn('unit.laps', n))).toEqual(['1 lap', '2 laps', '5 laps'])
    locale.value = 'sk'
    expect([1, 2, 4, 5, 0].map((n) => tn('unit.laps', n))).toEqual(['1 kolo', '2 kolá', '4 kolá', '5 kôl', '0 kôl'])
    locale.value = 'en'
  })

  it('falls back for keys built at run time', () => {
    locale.value = 'sk'
    expect(tx('track.2', 'Shanghai')).toBe('Šanghaj')
    expect(tx('track.4', 'Barcelona')).toBe('Barcelona')
    locale.value = 'en'
    expect(tx('track.2', 'Shanghai')).toBe('Shanghai')
    expect(tx('session.99', 'x')).toBe('x')
  })
})
