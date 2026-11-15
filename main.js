import net   from 'network_sockets';
import tui   from 'tui';
import tls   from 'tls';
import image from 'image';

import { buildKeyMap }      from 'src/base/keys.js';
import { createTheme }      from 'src/ui/theme.js';
import { createImageView }  from 'src/ui/image-view.js';
import { createHttpClient } from 'src/net/http-client.js';
import { createCookieJar }  from 'src/net/cookies.js';
import { createTabManager } from 'src/browser/tab-manager.js';
import { createController } from 'src/browser/controller.js';

tui.init();
tui.mouseEnable();

const theme      = createTheme(tui);
const keys       = buildKeyMap(tui);
const epfd       = net.epoll_create1(0);
net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, 0, net.EPOLLIN);

const imageView  = createImageView(tui, theme);
const tabManager = createTabManager(tui, theme, imageView);
tabManager.add();

const cookieJar  = createCookieJar();
const httpClient = createHttpClient(net, epfd, tls, cookieJar);

const controller = createController({
  tui, net, keys, epfd, httpClient, theme, tabManager, imageView,
});

httpClient.setCallbacks({
  onStatus:   (url, msg, opts)  => {
    try { controller.handleStatus(opts && opts.tabId, msg); }
    catch (e) { console.log('[onStatus] ' + (e.message || String(e))); }
  },
  onResponse: (url, resp, opts) => {
    try {
      const ct = (resp.contentType || resp.headers['content-type'] || '').toLowerCase();
      const isImageResponse = ct.startsWith('image/') ||
                              (opts && opts.binary && opts.imageFor);
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
  },
  onError: (url, msg, opts) => {
    try { controller.handleError(opts && opts.tabId, url, msg); }
    catch (e) { console.log('[onError] ' + (e.message || String(e))); }
  },
});

controller.render();

while (controller.isRunning()) {
  let events;
  try { events = net.epoll_wait(epfd, 16, -1); }
  catch (e) {
    console.log('[epoll_wait] ' + (e.message || String(e)));
    continue;
  }

  for (const ev of events) {
    try {
      if (ev.fd === 0) controller.handleInput();
      else httpClient.onEvent(ev);
    } catch (e) {
      console.log('[event loop] ' + (e.message || String(e)));
      /* don't kill the browser — one bad page shouldn't lose your tabs */
    }
  }
}

tui.mouseDisable();
tui.end();
