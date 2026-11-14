import { parseUrl, resolveUrl } from 'src/base/url.js';
import { parseHttpResponse, isRedirect } from 'src/net/http-parser.js';

export function createHttpClient(net, epfd) {
  const connections = {};
  let callbacks = { onStatus(){}, onResponse(){}, onError(){} };

  function setCallbacks(cb) { callbacks = { ...callbacks, ...cb }; }

  function buildRequest(p) {
    return (
      `GET ${p.path} HTTP/1.0\r\n` +
      `Host: ${p.host}\r\n` +
      `User-Agent: QJSBrowser/0.1\r\n` +
      `Connection: close\r\n\r\n`
    );
  }

  function closeConnection(fd) {
    net.epoll_ctl(epfd, net.EPOLL_CTL_DEL, fd);
    net.close(fd);
    delete connections[fd];
  }

  function fetch(url, options = {}) {
    const p = options.parsed || parseUrl(url);
    if (!p) { callbacks.onError(url, 'Invalid URL'); return; }

    let ip;
    try { ip = net.gethostbyname(p.host); }
    catch (e) { callbacks.onError(url, 'DNS failed: ' + p.host); return; }

    const fd = net.socket(net.AF_INET, net.SOCK_STREAM, 0);
    net.setnonblocking(fd);
    net.connect(fd, ip, p.port);

    connections[fd] = {
      state:     'connecting',
      url,
      parsed:    p,
      options,
      request:   buildRequest(p),
      sent:      0,
      recv:      '',
      redirects: options.redirectCount || 0,
    };

    callbacks.onStatus(url, 'Connecting ' + p.host + ':' + p.port);
    net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, fd, net.EPOLLOUT);
  }

  function onEvent(ev) {
    const fd = ev.fd;
    const c = connections[fd];
    if (!c) return;

    if (c.state === 'connecting' && (ev.events & net.EPOLLOUT)) {
      if (!net.is_connected(fd)) {
        closeConnection(fd);
        callbacks.onError(c.url, 'Connection failed');
        return;
      }
      c.sent = net.send(fd, c.request);
      if (c.sent >= c.request.length) {
        c.state = 'receiving';
        net.epoll_ctl(epfd, net.EPOLL_CTL_MOD, fd, net.EPOLLIN);
      } else {
        c.state = 'sending';
        net.epoll_ctl(epfd, net.EPOLL_CTL_MOD, fd, net.EPOLLOUT);
      }
      return;
    }

    if (c.state === 'sending' && (ev.events & net.EPOLLOUT)) {
      c.sent += net.send(fd, c.request.slice(c.sent));
      if (c.sent >= c.request.length) {
        c.state = 'receiving';
        net.epoll_ctl(epfd, net.EPOLL_CTL_MOD, fd, net.EPOLLIN);
      }
      return;
    }

    if (c.state === 'receiving' && (ev.events & net.EPOLLIN)) {
      const chunk = net.recv(fd, 8192);
      if (chunk === '') {
        closeConnection(fd);
        processResponse(c);
        return;
      }
      c.recv += chunk;
      if (c.recv.length > 5 * 1024 * 1024) {
        const truncated = c.recv.slice(0, 5 * 1024 * 1024);
        closeConnection(fd);
        processResponse({ ...c, recv: truncated, truncated: true });
        return;
      }
      callbacks.onStatus(c.url, 'Receiving… ' + c.recv.length + ' bytes');
    }
  }

  function processResponse(c) {
    const resp = parseHttpResponse(c.recv);
    if (!resp) {
      callbacks.onError(c.url, 'Malformed HTTP response');
      return;
    }

    if (isRedirect(resp.status) && resp.headers.location) {
      if (c.redirects >= 10) {
        callbacks.onError(c.url, 'Too many redirects (limit 10)');
        return;
      }
      const target = resolveUrl(c.url, resp.headers.location);
      callbacks.onStatus(c.url, `Redirect ${resp.status} → ${target}`);
      fetch(target, { ...c.options, redirectCount: c.redirects + 1 });
      return;
    }

    if (c.truncated) callbacks.onStatus(c.url, 'Response truncated at 5MB');
    callbacks.onResponse(c.url, resp, c.options);
  }

  return { fetch, onEvent, setCallbacks };
}
