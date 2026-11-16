import net   from 'network_sockets';
import tui   from 'tui';
import tls   from 'tls';
import image from 'image';
import zlib  from 'zlib';
import fs    from 'fs';
import dns   from 'dns';

import { buildKeyMap }      from 'src/base/keys.js';
import { createScheduler }  from 'src/base/scheduler.js';
import { createTimers }     from 'src/base/timers.js';
import { installGlobals }   from 'src/browser/globals.js';
import { installDomGlobals } from 'src/browser/dom-globals.js';
import { createTheme }      from 'src/ui/theme.js';
import { createConsole }    from 'src/ui/console.js';
import { createImageView }  from 'src/ui/image-view.js';
import { createHttpClient } from 'src/net/http-client.js';
import { createCookieJar }  from 'src/net/cookies.js';
import { createSettings }   from 'src/browser/settings.js';
import { createTabManager } from 'src/browser/tab-manager.js';
import { createController } from 'src/browser/controller.js';

tui.init();
tui.mouseEnable();

const settings  = createSettings(fs);
settings.load();

const cookieJar = createCookieJar(fs);
cookieJar.load();

const theme      = createTheme(tui);
const keys       = buildKeyMap(tui);
const epfd       = net.epoll_create1(0);
net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, 0, net.EPOLLIN);

const imageView  = createImageView(tui, theme);
const tabManager = createTabManager(tui, theme, imageView);
tabManager.add();

const scheduler  = createScheduler();
const timers     = createTimers();
const httpClient = createHttpClient(net, epfd, tls, cookieJar, zlib, dns);

let devConsole = null;

const realController = createController({
  tui, net, keys, epfd, httpClient, theme, tabManager, imageView,
  settings, cookieJar,
  onToggleConsole: () => {
    if (!devConsole) return;
    const was = devConsole.isVisible();
    devConsole.toggle();
    if (was && !devConsole.isVisible()) redrawAfterConsoleClosed();
  },
});

devConsole = createConsole({ tui, theme });

installGlobals({
  tui,
  timers,
  getUrl: () => {
    try {
      const tab = tabManager.active();
      return (tab && tab.currentUrl) || '';
    } catch (_) { return ''; }
  },
});

installDomGlobals();

/* Redirect every console.* call to the in-TUI console.
 *
 * Before this hook, console.log/console.error were the C-backed
 * js_console_log function, which does fputs("[js] ", stderr). Page-JS
 * errors therefore landed raw on fd 2, desyncing ncurses' model of the
 * physical screen — the [js] ... lines that bled into the status bar.
 *
 * After this hook, NOTHING goes to stderr: every log lands in
 * devConsole, reachable with F12. The old fallback that also wrote to
 * stderr when devConsole was hidden is removed: the hidden console is
 * not a reason to corrupt the TUI. */
(function hookConsole() {
  const _origClear = console.clear;

  function wrap(kind) {
    return function (...args) {
      try { devConsole.appendOutput(kind, args); } catch (_) {}
    };
  }

  console.log   = wrap('log');
  console.warn  = wrap('log');
  console.info  = wrap('log');
  console.debug = wrap('log');
  console.error = wrap('error');

  console.clear = function (...args) {
    try { if (typeof _origClear === 'function') _origClear.apply(console, args); }
    catch (_) {}
    try { devConsole.clearOutput(); } catch (_) {}
  };
})();

function redrawAfterConsoleClosed() {
  tui.erase();
  try { realController.render(); } catch (_) {}
  if (typeof tui.clearok === 'function') tui.clearok();
  tui.refresh();
}

function closeConsoleAndRedraw() {
  devConsole.toggle();
  if (!devConsole.isVisible()) redrawAfterConsoleClosed();
}

function routeInput() {
  if (devConsole.isVisible()) {
    let ch;
    while ((ch = tui.getch()) !== tui.ERR) {
      devConsole.handleKey(ch);
      if (!devConsole.isVisible()) { redrawAfterConsoleClosed(); return; }
    }
    devConsole.flushPending();
    return;
  }

  const ch = tui.getch();
  if (ch === tui.ERR) return;
  if (ch === tui.KEY_F12) { closeConsoleAndRedraw(); return; }

  if (typeof tui.ungetch !== 'function') {
    console.error('[console] tui.ungetch missing; rebuild lib/tui.so');
    return;
  }
  tui.ungetch(ch);
  realController.handleInput();
}

const controller = {
  ...realController,
  handleInput: routeInput,
  flushRender() {
    realController.flushRender();
    if (devConsole.isVisible()) {
      const sz = tui.size();
      devConsole.render(0, 0, sz.cols, sz.rows);
      tui.refresh();
    }
  },
};

function pumpAndDrain() {
  if (typeof pumpJobs === 'function') {
    try { pumpJobs(200); } catch (e) {
      console.error('[pumpJobs] ' + (e && e.message));
      console.error('[pumpJobs] ' + (e && e.stack));
    }
  }
  const err = globalThis._lastPumpError;
  if (err) {
    globalThis._lastPumpError = '';
    try { devConsole.appendOutput('error', [String(err)]); } catch (_) {}
  }
}

httpClient.setCallbacks({
  onStatus:   (url, msg, opts)  => {
    if (opts && opts.imageFor) return;
    try { controller.handleStatus(opts && opts.tabId, msg); }
    catch (e) { console.log('[onStatus] ' + (e.message || String(e))); }
  },
  onResponse: (url, resp, opts) => {
    const ct = (resp.contentType || resp.headers['content-type'] || '').toLowerCase();
    const isImageResponse = ct.startsWith('image/') ||
                            (opts && opts.binary && opts.imageFor);

    const finish = () => {
      try {
        if (controller.isStale(opts)) return;
        if (isImageResponse && resp.rawBytes) {
          try {
            const decoded = image.decode(resp.rawBytes);
            if (decoded) {
              resp.rawBytes    = decoded.rgba;
              resp.imageWidth  = decoded.width;
              resp.imageHeight = decoded.height;
            }
          } catch (e) { console.log('[image.decode] ' + (e.message || String(e))); }
        }
        controller.handleResponse(opts && opts.tabId, url, resp, opts || {});
      } catch (e) {
        console.log('[onResponse] ' + (e.message || String(e)));
        try { controller.handleError(opts && opts.tabId, url, e.message || String(e), opts); }
        catch (_) {}
      }
    };

    if (isImageResponse && resp.rawBytes) scheduler.defer(finish);
    else finish();
  },
  onError: (url, msg, opts) => {
    if (opts && opts.imageFor) return;
    try { controller.handleError(opts && opts.tabId, url, msg, opts); }
    catch (e) { console.log('[onError] ' + (e.message || String(e))); }
  },
});

controller.render();

while (controller.isRunning()) {
  let timeout = -1;
  if (scheduler.hasWork()) timeout = 0;
  else {
    timeout = controller.msUntilRender();
    if (httpClient.hasJobs() && (timeout < 0 || timeout > 1000)) timeout = 1000;
  }

  const due = timers.nextDue();
  if (due !== Infinity) {
    const ms = Math.max(0, due - Date.now());
    if (timeout < 0 || ms < timeout) timeout = ms;
  }

  let events;
  try { events = net.epoll_wait(epfd, 16, timeout); }
  catch (e) {
    const msg = e.message || String(e);
    if (!/Interrupted system call|EINTR/i.test(msg)) console.error('[epoll_wait] ' + msg);
    continue;
  }

  for (const ev of (events || [])) {
    try {
      if (ev.fd === 0) controller.handleInput();
      else httpClient.onEvent(ev);
    } catch (e) { console.error('[event loop] ' + (e.message || String(e))); }
  }

  try { timers.runDue(Date.now(), 50); }
  catch (e) { console.error('[timers] ' + (e.message || String(e))); }

  pumpAndDrain();

  if (scheduler.hasWork()) {
    try { scheduler.runOne(); }
    catch (e) { console.error('[task] ' + (e.message || String(e))); }
  }

  try { controller.flushRender(); }
  catch (e) { console.error('[render] ' + (e.message || String(e))); }

  try { httpClient.tick(); }
  catch (e) { console.error('[tick] ' + (e.message || String(e))); }
}

cookieJar.save();

tui.mouseDisable();
tui.end();
