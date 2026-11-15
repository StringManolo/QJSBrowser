/* Browser default styles per tag. Keys are tag names; values are
 * declaration objects using the same CSS-ish property names. */
export const TAG_DEFAULTS = {
  h1: { 'font-weight': 'bold', 'color': 'brightwhite', 'font-size': '32px' },
  h2: { 'font-weight': 'bold', 'color': 'brightwhite', 'font-size': '24px' },
  h3: { 'font-weight': 'bold', 'color': 'brightwhite', 'font-size': '20px' },
  h4: { 'font-weight': 'bold', 'color': 'white',       'font-size': '18px' },
  h5: { 'font-weight': 'bold', 'color': 'white',       'font-size': '16px' },
  h6: { 'font-weight': 'bold', 'color': 'white',       'font-size': '14px' },

  b:      { 'font-weight': 'bold' },
  strong: { 'font-weight': 'bold' },
  i:      { 'font-style': 'italic' },
  em:     { 'font-style': 'italic' },
  u:      { 'text-decoration': 'underline' },
  ins:    { 'text-decoration': 'underline' },
  s:      { 'text-decoration': 'underline' },
  del:    { 'text-decoration': 'underline' },

  code: { 'color': 'brightyellow' },
  kbd:  { 'color': 'brightyellow' },
  samp: { 'color': 'brightyellow' },
  pre:  { 'color': 'brightyellow' },
  tt:   { 'color': 'brightyellow' },

  a: { 'color': 'brightcyan', 'text-decoration': 'underline' },

  blockquote: { 'color': 'gray' },
};
