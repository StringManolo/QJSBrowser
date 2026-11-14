import net from 'network_sockets';
import tui from 'tui';
import tls from 'tls';

import { buildKeyMap }      from 'src/base/keys.js';
import { createTheme }      from 'src/ui/theme.js';
import { createHttpClient } from 'src/net/http-client.js';
import { createCookieJar }  from 'src/net/cookies.js';
import { createOmnibox }    from 'src/ui/omnibox.js';
import { createPageView }   from 'src/ui/page-view.js';
import { createHistory }    from 'src/browser/history.js';
import { createController } from 'src/browser/controller.js';

tui.init();
tui.mouseEnable();                    // ★ nuevo

const theme = createTheme(tui);
const keys  = buildKeyMap(tui);
const epfd  = net.epoll_create1(0);
net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, 0, net.EPOLLIN);

const omnibox   = createOmnibox();
const pageView  = createPageView(tui, theme);
const history   = createHistory();
const cookieJar = createCookieJar();

const httpClient = createHttpClient(net, epfd, tls, cookieJar);

const controller = createController({
  tui, net, keys, epfd, httpClient, theme,
  omnibox, pageView, history,
});

httpClient.setCallbacks({
  onStatus:   (url, msg)        => controller.handleStatus(url, msg),
  onResponse: (url, resp, opts) => controller.handleResponse(url, resp, opts),
  onError:    (url, msg)        => controller.handleError(url, msg),
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

tui.mouseDisable();                   // ★ nuevo
tui.end();
