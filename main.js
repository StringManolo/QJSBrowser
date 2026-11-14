import net from 'network_sockets';
import tui from 'tui';
import tls from 'tls';

import { buildKeyMap }      from 'src/base/keys.js';
import { createTheme }      from 'src/ui/theme.js';
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

const tabManager = createTabManager(tui, theme);
tabManager.add();  // initial tab

const cookieJar  = createCookieJar();
const httpClient = createHttpClient(net, epfd, tls, cookieJar);

const controller = createController({
  tui, net, keys, epfd, httpClient, theme, tabManager,
});

httpClient.setCallbacks({
  onStatus:   (url, msg, opts)  => controller.handleStatus(opts && opts.tabId, msg),
  onResponse: (url, resp, opts) => controller.handleResponse(opts && opts.tabId, url, resp, opts || {}),
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
