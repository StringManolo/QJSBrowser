import net   from 'network_sockets';
import tui   from 'tui';
import tls   from 'tls';
import image from 'image';
import zlib  from 'zlib';
import fs    from 'fs';
import dns   from 'dns';

import { buildKeyMap }      from 'src/base/keys.js';
import { createScheduler }  from 'src/base/scheduler.js';
import { createTheme }      from 'src/ui/theme.js';
import { createImageView }  from 'src/ui/image-view.js';
import { createHttpClient } from 'src/net/http-client.js';
import { createCookieJar }  from 'src/net/cookies.js';
import { createSettings }   from 'src/browser/settings.js';
import { createTabManager } from 'src/browser/tab-manager.js';
import { createController } from 'src/browser/controller.js';

tui.init();
tui.mouseEnable();

/* Load persistent state before creating anything that reads it */
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
const httpClient = createHttpClient(net, epfd, tls, cookieJar, zlib, dns);

const controller = createController({
  tui, net, keys, epfd, httpClient, theme, tabManager, imageView,
  settings, cookieJar,
});

httpClient.setCallbacks({
  onStatus:   (url, msg, opts)  => {
    if (opts && opts.imageFor) return;   /* image progress would overwrite the page status */
    try { controller.handleStatus(opts && opts.tabId, msg); }
    catch (e) { console.log('[onStatus] ' + (e.message || String(e))); }
  },
  onResponse: (url, resp, opts) => {
    const ct = (resp.contentType || resp.headers['content-type'] || '').toLowerCase();
    const isImageResponse = ct.startsWith('image/') ||
                            (opts && opts.binary && opts.imageFor);

    const finish = () => {
      try {
        /* The tab navigated away / closed while this was waiting in the queue */
        if (controller.isStale(opts)) return;

        if (isImageResponse && resp.rawBytes) {
          try {
            const decoded = image.decode(resp.rawBytes);
            if (decoded) {
              resp.rawBytes    = decoded.rgba;
              resp.imageWidth  = decoded.width;
              resp.imageHeight = decoded.height;
            }
          } catch (e) {
            console.log('[image.decode] ' + (e.message || String(e)));
          }
        }
        controller.handleResponse(opts && opts.tabId, url, resp, opts || {});
      } catch (e) {
        console.log('[onResponse] ' + (e.message || String(e)));
        try { controller.handleError(opts && opts.tabId, url, e.message || String(e)); }
        catch (_) {}
      }
    };

    /* Decoding + resampling an image can take 10-300 ms on a phone. Queue it so
     * the loop can serve input between images instead of decoding all at once. */
    if (isImageResponse && resp.rawBytes) scheduler.defer(finish);
    else finish();
  },
  onError: (url, msg, opts) => {
    /* A broken image must not replace the whole page with "Failed: <image url>"
     * (handleError rewrites the tab content). Ignore it silently: the page
     * keeps its [IMG: alt] placeholder. Don't console.log here, stderr
     * would scribble over the ncurses screen. */
    if (opts && opts.imageFor) return;
    try { controller.handleError(opts && opts.tabId, url, msg); }
    catch (e) { console.log('[onError] ' + (e.message || String(e))); }
  },
});

controller.render();

while (controller.isRunning()) {
  /* How long may epoll_wait sleep?
   *   0     deferred CPU work is waiting (image decode): poll, don't sleep
   *   N ms  a throttled repaint is due
   *   1000  requests are in flight: wake up regularly to enforce timeouts
   *   -1    nothing to do: sleep until a key or a socket event arrives */
  let timeout = -1;
  if (scheduler.hasWork()) {
    timeout = 0;
  } else {
    timeout = controller.msUntilRender();
    if (httpClient.hasJobs() && (timeout < 0 || timeout > 1000)) timeout = 1000;
  }

  let events;
  try { events = net.epoll_wait(epfd, 16, timeout); }
  catch (e) {
    const msg = e.message || String(e);
    if (!/Interrupted system call|EINTR/i.test(msg)) {
      console.log('[epoll_wait] ' + msg);
    }
    continue;
  }

  /* Input first, so typing always beats background work */
  for (const ev of (events || [])) {
    try {
      if (ev.fd === 0) controller.handleInput();
      else httpClient.onEvent(ev);
    } catch (e) {
      console.log('[event loop] ' + (e.message || String(e)));
    }
  }

  /* At most ONE deferred task per iteration, then back to epoll */
  if (scheduler.hasWork()) {
    try { scheduler.runOne(); }
    catch (e) { console.log('[task] ' + (e.message || String(e))); }
  }

  try { controller.flushRender(); }
  catch (e) { console.log('[render] ' + (e.message || String(e))); }

  /* Timeouts + really close() sockets released during this iteration */
  try { httpClient.tick(); }
  catch (e) { console.log('[tick] ' + (e.message || String(e))); }
}

/* Persist cookies before shutting down */
cookieJar.save();

tui.mouseDisable();
tui.end();
