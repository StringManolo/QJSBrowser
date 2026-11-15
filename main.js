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

const theme = createTheme(tui);
const keys  = buildKeyMap(tui);
const epfd  = net.epoll_create1(0);
net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, 0, net.EPOLLIN);

// ★ imageView BEFORE tabManager — tabs need it
const imageView = createImageView(tui, theme);
const tabManager = createTabManager(tui, theme, imageView);
tabManager.add();

const cookieJar  = createCookieJar();
const httpClient = createHttpClient(net, epfd, tls, cookieJar);

const controller = createController({
  tui, net, keys, epfd, httpClient, theme, tabManager, imageView,
});

httpClient.setCallbacks({
  onStatus:   (url, msg, opts)  => controller.handleStatus(opts && opts.tabId, msg),
  onResponse: (url, resp, opts) => {
    // Decode image bytes — either explicit binary fetch OR image/* content-type
    const ct = (resp.contentType || resp.headers['content-type'] || '').toLowerCase();
    const isImageResponse = ct.startsWith('image/') ||
                            (opts && opts.binary && opts.imageFor);
    if (isImageResponse && resp.rawBytes) {
      try {
        const decoded = image.decode(resp.rawBytes);
        if (decoded) {
          resp.rawBytes = decoded.rgba;
          resp.imageWidth  = decoded.width;
          resp.imageHeight = decoded.height;
        }
      } catch (e) { /* decode error — leave rawBytes untouched */ }
    }
    controller.handleResponse(opts && opts.tabId, url, resp, opts || {});
  },
  onError:    (url, msg, opts)  => controller.handleError(opts && opts.tabId, url, msg),
});

controller.render();

while (controller.isRunning()) {
  let events;
  try { events = net.epoll_wait(epfd, 16, -1); }
  catch (e) { continue; }
  for (const ev of events) {
    if (ev.fd === 0) controller.handleInput();
    else httpClient.onEvent(ev);
  }
}

tui.mouseDisable();
tui.end();
