import { drawWindow } from 'src/ui/window.js';

export function createSettingsDialog(
  tui, theme, settings, cookieJar, tabManager,
  onClearHistory, onToggleConsole
) {
  let open = false;
  let cursor = 0;
  let view = 'settings';   /* 'settings' | 'about' */
  let itemRects = [];

  function buildItems() {
    const engines = Object.entries(settings.SEARCH_ENGINES).map(([k, v]) => ({ label: v.label, value: k }));
    return [
      {
        id: 'homepage', label: 'Homepage', type: 'cycle',
        values: settings.HOMEPAGES,
        get: () => settings.get('homepage'),
        set: (v) => settings.set('homepage', v),
      },
      {
        id: 'searchEngine', label: 'Search engine', type: 'cycle',
        values: engines,
        get: () => settings.get('searchEngine'),
        set: (v) => settings.set('searchEngine', v),
      },
      {
        id: 'showImages', label: 'Show images', type: 'toggle',
        get: () => settings.get('showImages'),
        set: (v) => settings.set('showImages', v),
      },
      {
        id: 'acceptCookies', label: 'Accept cookies', type: 'toggle',
        get: () => settings.get('acceptCookies'),
        set: (v) => settings.set('acceptCookies', v),
      },
      {
        id: 'clearCookies', label: 'Clear cookies', type: 'action',
        action: () => { cookieJar.clear(); },
        suffix: () => `(${cookieJar.size})`,
      },
      {
        id: 'clearHistory', label: 'Clear history', type: 'action',
        action: () => { if (onClearHistory) onClearHistory(); },
      },
      {
        id: 'console', label: 'Developer Console', type: 'action',
        action: () => {
          /* Close the dialog first so the console opens onto a clean screen. */
          open = false;
          if (onToggleConsole) onToggleConsole();
        },
      },
      {
        id: 'about', label: 'About QJSBrowser', type: 'action',
        action: () => { view = 'about'; cursor = 0; },
      },
    ];
  }

  function displayValue(item) {
    if (item.type === 'cycle') {
      const v = item.get();
      const found = item.values.find(x => x.value === v);
      return '[' + (found ? found.label : String(v)) + ']';
    }
    if (item.type === 'toggle') {
      return '[' + (item.get() ? 'Yes' : 'No') + ']';
    }
    if (item.type === 'action') {
      return item.suffix ? item.suffix() : '▶';
    }
    return '';
  }

  function handleKey(ch, keys) {
    if (view === 'about') {
      if (ch === keys.ESC || ch === keys.ENTER || ch === keys.ENTER2 ||
          ch === keys.NC_ENTER || ch === 'q'.charCodeAt(0)) {
        view = 'settings';
        cursor = buildItems().length - 1;
      }
      return { action: 'noop' };
    }

    const items = buildItems();

    if (ch === keys.ESC || ch === 'q'.charCodeAt(0)) {
      open = false;
      return { action: 'close' };
    }
    if (ch === keys.ARROW_UP || ch === 'k'.charCodeAt(0)) {
      cursor = (cursor - 1 + items.length) % items.length;
      return { action: 'move' };
    }
    if (ch === keys.ARROW_DOWN || ch === 'j'.charCodeAt(0)) {
      cursor = (cursor + 1) % items.length;
      return { action: 'move' };
    }
    if (ch === keys.ENTER || ch === keys.ENTER2 || ch === keys.NC_ENTER ||
        ch === keys.SPACE || ch === '\n'.charCodeAt(0)) {
      const item = items[cursor];
      if (!item) return { action: 'noop' };

      if (item.type === 'cycle') {
        const current = item.get();
        let idx = item.values.findIndex(v => v.value === current);
        if (idx < 0) idx = 0;
        idx = (idx + 1) % item.values.length;
        item.set(item.values[idx].value);
        return { action: 'change', id: item.id };
      }
      if (item.type === 'toggle') {
        item.set(!item.get());
        return { action: 'change', id: item.id };
      }
      if (item.type === 'action') {
        item.action();
        return { action: 'exec', id: item.id };
      }
    }
    return { action: 'noop' };
  }

  function hitTest(mx, my) {
    for (let i = 0; i < itemRects.length; i++) {
      const r = itemRects[i];
      if (my === r.y && mx >= r.x && mx < r.x + r.w) {
        return { index: i };
      }
    }
    return null;
  }

  function handleMouseClick(mx, my) {
    if (view === 'about') { view = 'settings'; return { action: 'change' }; }
    const hit = hitTest(mx, my);
    if (!hit) return { action: 'noop' };
    cursor = hit.index;
    return handleKey(10, {});
  }

  function render(rows, cols) {
    if (!open) { itemRects = []; return; }
    const P = theme.pairs;
    itemRects = [];

    if (view === 'about') {
      const w = Math.min(56, cols - 8);
      const h = Math.min(20, rows - 6);
      const x = Math.floor((cols - w) / 2);
      const y = Math.floor((rows - h) / 2);
      drawWindow(tui, theme, { x, y, w, h, title: 'About', focused: true, style: 1 });

      const lines = [
        '',
        '  QJSBrowser v0.1',
        '',
        '  A browser written in JavaScript',
        '  on top of QuickJS.',
        '',
        '  Modules loaded:',
        '   • network_sockets  • tui',
        '   • tls  •  image  •  zlib  •  fs',
        '',
        '  Config: ~/.config/qjsbrowser',
        '',
        '  Press Esc to close',
      ];
      for (let i = 0; i < lines.length && i < h - 2; i++) {
        tui.fillPair(y + 1 + i, x + 1, 1, w - 2, P.page);
        tui.printPair(y + 1 + i, x + 1, lines[i], P.page);
      }
      return;
    }

    const items = buildItems();
    const w = Math.min(60, cols - 8);
    const h = Math.min(items.length + 5, rows - 6);
    const x = Math.floor((cols - w) / 2);
    const y = Math.floor((rows - h) / 2);

    drawWindow(tui, theme, { x, y, w, h, title: 'Settings', focused: true, style: 1 });

    for (let i = 0; i < items.length && i < h - 4; i++) {
      const item = items[i];
      const active = i === cursor;
      const rowY = y + 2 + i;

      if (rowY >= y + h - 1) break;
      tui.fillPair(rowY, x + 1, 1, w - 2, active ? P.inputFocus : P.page);

      const label = (active ? '▶ ' : '  ') + item.label;
      const val   = displayValue(item);
      tui.printPair(rowY, x + 2, label, active ? P.inputFocus : P.page);

      if (val) {
        const vx = x + w - 3 - val.length;
        if (vx > x + label.length + 3) {
          tui.printPair(rowY, vx, val, active ? P.inputFocus : P.warning);
        }
      }

      itemRects.push({ x: x + 1, y: rowY, w: w - 2 });
    }

    const hint = ' ↑/↓ move · Enter select · Esc close ';
    if (h >= 3) {
      const hy = y + h - 1;
      tui.printPair(hy, x + 2, hint, P.separator);
    }
  }

  return {
    isOpen: () => open,
    open:   () => { open = true; cursor = 0; view = 'settings'; },
    close:  () => { open = false; },
    handleKey,
    handleMouseClick,
    render,
  };
}
