export function createOmnibox() {
  let text = '';
  let cursor = 0;

  function setText(v) { text = v; cursor = v.length; }
  function clear() { text = ''; cursor = 0; }

  function handleKey(ch, keys) {
    switch (ch) {
      case keys.BACKSPACE: case keys.NC_BACKSP: case keys.BACKSPACE2:
        if (cursor > 0) {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
        }
        return null;
      case keys.DELETE:
        if (cursor < text.length)
          text = text.slice(0, cursor) + text.slice(cursor + 1);
        return null;
      case keys.ARROW_LEFT:  if (cursor > 0) cursor--; return null;
      case keys.ARROW_RIGHT: if (cursor < text.length) cursor++; return null;
      case keys.HOME: cursor = 0; return null;
      case keys.END:  cursor = text.length; return null;
      case keys.CTRL_U: case keys.CTRL_L: clear(); return null;
      case keys.CTRL_W:
        while (cursor > 0 && text[cursor - 1] === ' ') {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
        }
        while (cursor > 0 && text[cursor - 1] !== ' ') {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
        }
        return null;
      case keys.ENTER: case keys.ENTER2: case keys.NC_ENTER:
        return { submitted: text };
    }
    if (ch >= 32 && ch < 127) {
      text = text.slice(0, cursor) + String.fromCharCode(ch) + text.slice(cursor);
      cursor++;
    }
    return null;
  }

  return {
    setText, clear, handleKey,
    get text()   { return text; },
    get cursor() { return cursor; },
  };
}
