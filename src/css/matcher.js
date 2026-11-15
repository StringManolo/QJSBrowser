/* Match a CSS selector against an element { tag, id, classes }.
 * Supported forms: tag | .class | #id | tag.class1.class2
 * Anything else (combinators, pseudo) → no match. */

export function matches(selector, el) {
  if (!selector || !el) return false;
  selector = selector.trim();
  if (!selector) return false;

  // Reject unsupported selectors
  if (/[\s>+~:]/.test(selector)) return false;

  let rest = selector;
  let tag = null;
  const classes = [];
  let id = null;

  const idMatch = rest.match(/#([\w-]+)/);
  if (idMatch) {
    id = idMatch[1];
    rest = rest.replace(idMatch[0], '');
  }

  let classMatch;
  const classRe = /\.([\w-]+)/g;
  while ((classMatch = classRe.exec(rest)) !== null) {
    classes.push(classMatch[1]);
  }
  rest = rest.replace(/\.[\w-]+/g, '');

  if (rest) {
    if (!/^[a-zA-Z][\w-]*$/.test(rest)) return false;
    tag = rest.toLowerCase();
  }

  if (tag && el.tag !== tag) return false;
  if (id && el.id !== id) return false;
  for (const c of classes) {
    if (!el.classes || !el.classes.has(c)) return false;
  }
  return true;
}

/* Specificity of a selector as a number: (id × 10000) + (class × 100) + tag. */
export function specificity(selector) {
  let ids = 0, classes = 0, tags = 0;
  const idRe = /#[\w-]+/g;
  const classRe = /\.[\w-]+/g;
  while (idRe.exec(selector) !== null)    ids++;
  while (classRe.exec(selector) !== null) classes++;
  const tagMatch = selector.replace(/#[\w-]+|\.[\w-]+/g, '').trim();
  if (tagMatch) tags++;
  return ids * 10000 + classes * 100 + tags;
}
