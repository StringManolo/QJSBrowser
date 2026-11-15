/* Parse CSS color values → {r,g,b} or null.
 * Supports: #RGB, #RRGGBB, rgb(), rgba(), named colors. */

const NAMED = {
  black: [0, 0, 0], silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  white: [255, 255, 255], maroon: [128, 0, 0], red: [255, 0, 0],
  purple: [128, 0, 128], fuchsia: [255, 0, 255], magenta: [255, 0, 255],
  green: [0, 128, 0], lime: [0, 255, 0], olive: [128, 128, 0],
  yellow: [255, 255, 0], navy: [0, 0, 128], blue: [0, 0, 255],
  teal: [0, 128, 128], aqua: [0, 255, 255], cyan: [0, 255, 255],
  orange: [255, 165, 0], pink: [255, 192, 203], brown: [165, 42, 42],
  gold: [255, 215, 0], indigo: [75, 0, 130], violet: [238, 130, 238],
  darkgray: [169, 169, 169], darkgrey: [169, 169, 169],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211],
  darkred: [139, 0, 0], darkgreen: [0, 100, 0], darkblue: [0, 0, 139],
  darkorange: [255, 140, 0], crimson: [220, 20, 60], coral: [255, 127, 80],
  salmon: [250, 128, 114], tomato: [255, 99, 71], orchid: [218, 112, 214],
  steelblue: [70, 130, 180], skyblue: [135, 206, 235], royalblue: [65, 105, 225],
};

export function parseCssColor(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;

  /* #RGB */
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return {
      r: parseInt(s[1] + s[1], 16),
      g: parseInt(s[2] + s[2], 16),
      b: parseInt(s[3] + s[3], 16),
    };
  }

  /* #RRGGBB */
  if (/^#[0-9a-f]{6}$/i.test(s)) {
    return {
      r: parseInt(s.slice(1, 3), 16),
      g: parseInt(s.slice(3, 5), 16),
      b: parseInt(s.slice(5, 7), 16),
    };
  }

  /* rgb(...) / rgba(...) */
  const rgb = s.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    return {
      r: Math.min(255, +rgb[1]),
      g: Math.min(255, +rgb[2]),
      b: Math.min(255, +rgb[3]),
    };
  }

  if (NAMED[s]) return { r: NAMED[s][0], g: NAMED[s][1], b: NAMED[s][2] };

  /* CSS keywords that mean "don't override" */
  if (['inherit', 'initial', 'unset', 'currentcolor', 'transparent'].includes(s)) return null;

  return null;
}

/* 16 basic ANSI colors in RGB */
const ANSI_RGB = [
  [0,   0,   0  ], [128, 0,   0  ], [0,   128, 0  ], [128, 128, 0  ],
  [0,   0,   128], [128, 0,   128], [0,   128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0,   0  ], [0,   255, 0  ], [255, 255, 0  ],
  [0,   0,   255], [255, 0,   255], [0,   255, 255], [255, 255, 255],
];

/* Colors darker than this are assumed to be intended for light-background
 * sites (Google's #202124 body text, Bootstrap's #212529, etc). On dark
 * terminals they'd become invisible → fall back to the terminal default. */
const DARK_LUMINANCE_THRESHOLD = 50;

/* Returns ANSI color index 0-15 (or fallback for "default").
 * Skips near-black colors so dark text on dark terminals stays visible. */
export function snapToAnsi(rgb, fallback = -1) {
  if (!rgb) return fallback;

  const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  if (lum < DARK_LUMINANCE_THRESHOLD) return fallback;

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI_RGB.length; i++) {
    const [ar, ag, ab] = ANSI_RGB[i];
    const dr = rgb.r - ar, dg = rgb.g - ag, db = rgb.b - ab;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}
