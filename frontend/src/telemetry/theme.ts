// Canvas colours; the same values as the tokens in styles.css.
export const COLOR = {
  card: '#151a23',
  hairline: '#262e3b',
  hairlineStrong: '#3a4453',
  text: '#e8ecf2',
  text2: '#a7b0be',
  text3: '#8791a1',
  you: '#e8650a',
  ref: '#2e9fd9',
  best: '#8e6bd6',
  warn: '#ffb020',
  throttle: '#3ddc84',
  brake: '#ff3b47',
  coast: '#c3cad6',
}

// Canvas labels never go below 10 px, so axis and corner labels stay readable on small screens.
export const font = (remPx: number, size: number, weight = 500) =>
  `${weight} ${Math.max(size * remPx, 10)}px 'Inter Variable', system-ui, sans-serif`
