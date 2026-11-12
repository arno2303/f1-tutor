// Track and country names in the chosen language; the track data holds the English ones.

import { tx } from '../i18n'

export const trackName = (track: { id: number; name: string }) => tx(`track.${track.id}`, track.name)
export const trackCountry = (track: { id: number; country: string }) => tx(`country.${track.id}`, track.country)
