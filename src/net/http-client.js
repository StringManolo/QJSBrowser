import { parseUrl, resolveUrl } from 'src/base/url.js';
import { parseHttpResponse, isRedirect } from 'src/net/http-parser.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export function createHttpClient(net, epfd, tls) {
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
    const c = connections[fd];
    if (c && c.tlsConn) { try { tls.free(c.tlsConn); } catch (_) {} }
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_DEL, fd); } catch (_) {}
    try { net.close(fd); } catch (_) {}
    delete connections[fd];
  }

  function setEpoll(fd, events) {
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_MOD, fd, events); }
    catch (_) { /* fd may be gone */ }
  }

  // ---------- TLS helpers ----------

  // Drain encrypted bytes produced by OpenSSL into the socket.
  function flushTlsOut(fd, c) {
    const fromBio = tls.getOutgoing(c.tlsConn);
    if (fromBio && fromBio.length > 0) c.tlsOut += fromBio;
    if (c.tlsOut.length > 0) {
      const sent = net.send(fd, c.tlsOut);
      if (sent > 0) c.tlsOut = c.tlsOut.slice(sent);
    }
  }

  // Advances handshake and, once complete, sends the HTTP request.
  // Returns true if connection should keep going, false if it errored/closed.
  function driveTlsHandshake(fd, c) {
    let res;
    try { res = tls.handshake(c.tlsConn); }
    catch (e) {
      closeConnection(fd);
      callbacks.onError(c.url, 'TLS handshake failed: ' + (e.message || e));
      return false;
    }

    // Always flush whatever OpenSSL has produced (ClientHello, Finished, etc.)
    flushTlsOut(fd, c);

    if (res === 1) {
      // Handshake complete → write HTTP request through TLS
      try { tls.write(c.tlsConn, c.request); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS write failed: ' + (e.message || e));
        return false;
      }
      flushTlsOut(fd, c);

      if (c.tlsOut.length === 0) {
        c.state = 'receiving';
        setEpoll(fd, net.EPOLLIN);
      } else {
        c.state = 'sending';
        setEpoll(fd, net.EPOLLIN | net.EPOLLOUT);
      }
      return true;
    }

    if (res === 2) { // WANT_READ
      setEpoll(fd, c.tlsOut.length > 0
        ? (net.EPOLLIN | net.EPOLLOUT)
        : net.EPOLLIN);
      return true;
    }
    if (res === 3) { // WANT_WRITE
      setEpoll(fd, net.EPOLLIN | net.EPOLLOUT);
      return true;
    }

    closeConnection(fd);
    callbacks.onError(c.url, 'TLS handshake error code ' + res);
    return false;
  }

  // Feed encrypted socket bytes into TLS; drain decrypted bytes into c.recv.
  // Returns true on success, false on fatal error.
  function feedTlsIn(fd, c, chunk) {
    if (chunk && chunk.length > 0) {
      try { tls.feedIncoming(c.tlsConn, chunk); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS feed failed: ' + (e.message || e));
        return false;
      }
    }

    for (;;) {
      let out;
      try { out = tls.read(c.tlsConn); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS read failed: ' + (e.message || e));
        return false;
      }

      if (out === -1) return true; // clean close_notify — wait for socket FIN
      if (out === -2) return true; // no more data available right now
      if (out === -3) { setEpoll(fd, net.EPOLLIN | net.EPOLLOUT); return true; }

      if (typeof out === 'string') {
        if (out.length === 0) return true;
        c.recv += out;
        if (c.recv.length > MAX_RESPONSE_BYTES) {
          c.recv = c.recv.slice(0, MAX_RESPONSE_BYTES);
          c.truncated = true;
          return false;
        }
      } else {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS read error');
        return false;
      }
    }
  }

  // ---------- public API ----------

  function fetch(url, options = {}) {
    const p = options.parsed || parseUrl(url);
    if (!p) { callbacks.onError(url, 'Invalid URL'); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      callbacks.onError(url, 'Unsupported scheme: ' + p.scheme); return;
    }

    let ip;
    try { ip = net.gethostbyname(p.host); }
    catch (e) { callbacks.onError(url, 'DNS failed: ' + p.host); return; }

    const fd = net.socket(net.AF_INET, net.SOCK_STREAM, 0);
    net.setnonblocking(fd);
    net.connect(fd, ip, p.port);

    const conn = {
      state:     'connecting',
      url,
      parsed:    p,
      options,
      request:   buildRequest(p),
      sent:      0,
      recv:      '',
      redirects: options.redirectCount || 0,
      tlsConn:   null,
      tlsOut:    '',
      truncated: false,
    };

    if (p.scheme === 'https') {
      try {
        conn.tlsConn = tls.new();
        if (typeof tls.setServerName === 'function')
          tls.setServerName(conn.tlsConn, p.host); // SNI — required by most servers
      } catch (e) {
        try { net.close(fd); } catch (_) {}
        callbacks.onError(url, 'TLS init failed: ' + (e.message || e));
        return;
      }
    }

    connections[fd] = conn;
    callbacks.onStatus(url, 'Connecting ' + p.host + ':' + p.port);
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, fd, net.EPOLLOUT); }
    catch (e) {
      closeConnection(fd);
      callbacks.onError(url, 'epoll_ctl failed: ' + (e.message || e));
    }
  }

  function onEvent(ev) {
    const fd = ev.fd;
    const c = connections[fd];
    if (!c) return;

    // ---- state: connecting ----
    if (c.state === 'connecting' && (ev.events & net.EPOLLOUT)) {
      if (!net.is_connected(fd)) {
        closeConnection(fd);
        callbacks.onError(c.url, 'Connection failed');
        return;
      }
      if (c.tlsConn) {
        c.state = 'tls_handshake';
        driveTlsHandshake(fd, c);
      } else {
        const sent = net.send(fd, c.request);
        if (sent >= c.request.length) {
          c.state = 'receiving';
          setEpoll(fd, net.EPOLLIN);
        } else {
          c.sent = sent;
          c.state = 'sending';
          setEpoll(fd, net.EPOLLOUT);
        }
      }
      return;
    }

    // ---- state: tls_handshake ----
    if (c.state === 'tls_handshake') {
      if (ev.events & net.EPOLLIN) {
        const chunk = net.recv(fd, 8192);
        if (chunk === '') {
          closeConnection(fd);
          callbacks.onError(c.url, 'Connection closed during TLS handshake');
          return;
        }
        try { tls.feedIncoming(c.tlsConn, chunk); }
        catch (e) {
          closeConnection(fd);
          callbacks.onError(c.url, 'TLS feed (handshake): ' + (e.message || e));
          return;
        }
      }
      driveTlsHandshake(fd, c);
      return;
    }

    // ---- state: sending (plain or TLS flush) ----
    if (c.state === 'sending') {
      if (c.tlsConn) {
        if (ev.events & net.EPOLLIN) {
          // Socket readable during send — possible with renegotiation; just feed
          const chunk = net.recv(fd, 8192);
          if (chunk) { try { tls.feedIncoming(c.tlsConn, chunk); } catch (_) {} }
        }
        flushTlsOut(fd, c);
        if (c.tlsOut.length === 0) {
          c.state = 'receiving';
          setEpoll(fd, net.EPOLLIN);
        }
      } else {
        if (ev.events & net.EPOLLOUT) {
          const remaining = c.request.slice(c.sent);
          c.sent += net.send(fd, remaining);
          if (c.sent >= c.request.length) {
            c.state = 'receiving';
            setEpoll(fd, net.EPOLLIN);
          }
        }
      }
      return;
    }

    // ---- state: receiving ----
    if (c.state === 'receiving' && (ev.events & net.EPOLLIN)) {
      const chunk = net.recv(fd, 8192);

      if (chunk === '') {
        // Socket closed — drain any buffered plaintext for TLS before finalizing
        if (c.tlsConn) {
          try {
            for (;;) {
              const out = tls.read(c.tlsConn);
              if (typeof out !== 'string' || out.length === 0) break;
              c.recv += out;
            }
          } catch (_) { /* ignore */ }
        }
        closeConnection(fd);
        processResponse(c);
        return;
      }

      if (c.tlsConn) {
        if (!feedTlsIn(fd, c, chunk)) {
          if (c.truncated) { closeConnection(fd); processResponse(c); }
          return;
        }
      } else {
        c.recv += chunk;
        if (c.recv.length > MAX_RESPONSE_BYTES) {
          c.recv = c.recv.slice(0, MAX_RESPONSE_BYTES);
          c.truncated = true;
          closeConnection(fd);
          processResponse(c);
          return;
        }
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
