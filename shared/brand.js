/**
 * Sam brand tokens.
 *
 * Fixed by the build brief: Teal 4EC8C2, black 0D0D0D, DM Sans. Every rendered
 * surface — the Snapshot PDF, the hosted page, the mockup screens — reads its
 * colours from here so the brand cannot drift between them.
 */

export const SAM = {
  teal: '#4EC8C2',
  black: '#0D0D0D',
  font: "'DM Sans'",
  fontStack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

/** Tints derived from the brand teal, for fills and rules that must not compete with it. */
export const TEAL = {
  base: '#4EC8C2',
  deep: '#2A8C88',
  ink: '#12403E',
  wash: '#EAF7F6',
  line: '#BFE6E3',
};

/** Neutral ramp built on the brand black rather than a generic grey. */
export const INK = {
  900: '#0D0D0D',
  700: '#2B2F31',
  500: '#5A6265',
  400: '#7C8487',
  300: '#AEB5B7',
  200: '#DDE2E3',
  100: '#EFF2F2',
  0: '#FFFFFF',
};

/**
 * Anchor states carry meaning, so they get their own ramp separate from the accent.
 * NOT_COLLECTED is deliberately distinct from NOT_MET — the difference between
 * "we never asked" and "they could not show it" is the point of the engine.
 */
export const STATE_COLOR = {
  MET: { fg: '#1F6B45', bg: '#E4F0E9' },
  PARTIAL: { fg: '#2C5A8A', bg: '#E3EDF6' },
  NOT_MET: { fg: '#A93A2C', bg: '#F6E5E2' },
  NOT_COLLECTED: { fg: '#8A6212', bg: '#F6EEDC' },
};

/** Converts "#RRGGBB" into the 0..1 triplet pdf-lib's rgb() expects. */
export const toRgb = (hex) => {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
};
