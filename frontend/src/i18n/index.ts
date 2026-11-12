// UI language. English is the default; Slovak can be chosen in the top bar.

import { computed, ref } from 'vue'
import en, { type MessageKey } from './en'
import sk from './sk'

export type { MessageKey }
export type Locale = 'en' | 'sk'
export type Params = Record<string, string | number>

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'sk', label: 'Slovenčina' },
]

const MESSAGES: Record<Locale, Record<string, string>> = { en, sk }
const STORAGE_KEY = 'f1tutor.locale'

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'sk') return saved
  } catch {
    // Without storage the language just isn't remembered.
  }
  return 'en'
}

export const locale = ref<Locale>(initialLocale())

export function setLocale(next: Locale): void {
  locale.value = next
  document.documentElement.lang = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Without storage the language just isn't remembered.
  }
}

/** Locale for dates and times. */
export const dateLocale = computed(() => (locale.value === 'sk' ? 'sk-SK' : 'en-GB'))

function fill(message: string, params?: Params): string {
  return params ? message.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : message
}

/** A translated text. Reading it in a template or computed makes that re-render when the language changes. */
export function t(key: MessageKey, params?: Params): string {
  return fill(MESSAGES[locale.value][key] ?? en[key], params)
}

/** A text looked up by a key built at run time, such as a session type id; `fallback` when there's none. */
export function tx(key: string, fallback: string, params?: Params): string {
  const message = MESSAGES[locale.value][key] ?? (en as Record<string, string>)[key]
  return message === undefined ? fallback : fill(message, params)
}

/**
 * A text with plural forms separated by "|", picked by `count` and filled with {n}.
 * English: one|other. Slovak: one (1) | few (2-4) | other.
 */
export function tn(key: MessageKey, count: number, params?: Params): string {
  const forms = (MESSAGES[locale.value][key] ?? en[key]).split('|')
  let index: number
  if (locale.value === 'sk') index = count === 1 ? 0 : count >= 2 && count <= 4 ? 1 : 2
  else index = count === 1 ? 0 : 1
  return fill(forms[Math.min(index, forms.length - 1)], { n: count, ...params })
}
