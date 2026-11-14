import { parseUrl, resolveUrl } from 'src/base/url.js';
import { parseHttpResponse, isRedirect } from 'src/net/http-parser.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function concatBytes(a, b) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* Full UTF-8 decoder: byte array → JS string (UTF-16).
 * Handles partial sequences properly across concatenation. */
function decodeUtf8(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
    } else if (b0 < 0xC2) {
      // 0x80-0xBF: orphan continuation, 0xC0/0xC1: overlong
      out += '\uFFFD';
      i++;
    } else if (b0 < 0xE0) {
      if (i + 1 >= bytes.length) { out += '\uFFFD'; break; }
      const b1 = bytes[i + 1];
      if ((b1 & 0xC0) !== 0x80) { out += '\uFFFD'; i++; continue; }
      const cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F);
      out += String.fromCharCode(cp);
      i += 2;
    } else if (b0 < 0xF0) {
      if (i + 2 >= bytes.length) { out += '\uFFFD'; break; }
      const b1 = bytes[i + 1], b2 = bytes[i + 2];
      if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80) { out += '\uFFFD'; i++; continue; }
      const cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
      out += String.fromCharCode(cp);
      i += 3;
    } else if (b0 < 0xF5) {
      if (i + 3 >= bytes.length) { out += '\uFFFD'; break; }
      const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3];
      if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80 || (b3 & 0xC0) !== 0x80) {
        out += '\uFFFD'; i++; continue;
      }
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      i += 4;
    } else {
      out += '\uFFFD';
      i++;
    }
  }
  return out;
}

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
    catch (_) {}
  }

  // ---------- TLS plumbing ----------

  function flushTlsOut(fd, c) {
    for (;;) {
      const chunk = tls.getOutgoing(c.tlsConn);
      if (!chunk || chunk.length === 0) break;
      c.tlsOut = concatBytes(c.tlsOut, chunk);
    }
    while (c.tlsOut.length > 0) {
      const sent = tls.sendBytes(fd, c.tlsOut);
      if (!sent || sent < 0) break;
      c.tlsOut = c.tlsOut.subarray(sent);
    }
    return c.tlsOut.length === 0;
  }

  function stepTls(fd, c) {
    let res;
    try { res = tls.handshake(c.tlsConn); }
    catch (e) {
      closeConnection(fd);
      callbacks.onError(c.url, 'TLS handshake: ' + (e.message || e));
      return false;
    }

    const drained = flushTlsOut(fd, c);

    if (res === 1) {
      try { tls.write(c.tlsConn, c.request); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS write: ' + (e.message || e));
        return false;
      }
      if (flushTlsOut(fd, c)) {
        c.state = 'receiving';
        setEpoll(fd, net.EPOLLIN);
      } else {
        c.state = 'sending';
        setEpoll(fd, net.EPOLLIN | net.EPOLLOUT);
      }
      return true;
    }

    if (res === 2) {
      setEpoll(fd, drained ? net.EPOLLIN : (net.EPOLLIN | net.EPOLLOUT));
      return true;
    }
    if (res === 3) {
      setEpoll(fd, net.EPOLLIN | net.EPOLLOUT);
      return true;
    }

    closeConnection(fd);
    callbacks.onError(c.url, 'TLS handshake error code ' + res);
    return false;
  }

  // Feed ciphertext, drain plaintext bytes into c.recvBytes.
  function feedTlsIn(fd, c, bytes) {
    if (bytes && bytes.length > 0) {
      try { tls.feedIncoming(c.tlsConn, bytes); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS feed: ' + (e.message || e));
        return false;
      }
    }
    for (;;) {
      let out;
      try { out = tls.readBytes(c.tlsConn); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS read: ' + (e.message || e));
        return false;
      }
      if (out === -1) return true;
      if (out === -2) return true;
      if (out === -3) { setEpoll(fd, net.EPOLLIN | net.EPOLLOUT); return true; }
      if (typeof out === 'number') {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS read status ' + out);
        return false;
      }
      if (out.length === 0) return true;
      c.recvBytes = concatBytes(c.recvBytes, out);
      if (c.recvBytes.length > MAX_RESPONSE_BYTES) {
        c.recvBytes = c.recvBytes.subarray(0, MAX_RESPONSE_BYTES);
        c.truncated = true;
        return false;
      }
    }
  }

  // ---------- public API ----------

  function fetch(url, options = {}) {
    // Always honor the url argument — options.parsed is a hint only
    const p = parseUrl(url);
    if (!p) { callbacks.onError(url, 'Invalid URL'); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      callbacks.onError(url, 'Unsupported scheme: ' + p.scheme);
      return;
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
      recv:      '',               // plain HTTP (string)
      recvBytes: new Uint8Array(0),// TLS (bytes)
      redirects: options.redirectCount || 0,
      tlsConn:   null,
      tlsOut:    new Uint8Array(0),
      truncated: false,
    };

    if (p.scheme === 'https') {
      try {
        conn.tlsConn = tls.new();
        if (typeof tls.setServerName === 'function')
          tls.setServerName(conn.tlsConn, p.host);
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
      callbacks.onError(url, 'epoll_ctl: ' + (e.message || e));
    }
  }

  function onEvent(ev) {
    const fd = ev.fd;
    const c = connections[fd];
    if (!c) return;

    // ---- connecting ----
    if (c.state === 'connecting' && (ev.events & net.EPOLLOUT)) {
      if (!net.is_connected(fd)) {
        closeConnection(fd);
        callbacks.onError(c.url, 'Connection failed');
        return;
      }
      if (c.tlsConn) {
        c.state = 'tls_handshake';
        stepTls(fd, c);
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

    // ---- tls_handshake ----
    if (c.state === 'tls_handshake') {
      if (ev.events & net.EPOLLIN) {
        let chunk;
        try { chunk = tls.recvBytes(fd, 8192); }
        catch (e) {
          closeConnection(fd);
          callbacks.onError(c.url, 'TLS recv: ' + (e.message || e));
          return;
        }
        if (chunk === null) {
          closeConnection(fd);
          callbacks.onError(c.url, 'Connection closed during TLS handshake');
          return;
        }
        if (chunk.length > 0) {
          try { tls.feedIncoming(c.tlsConn, chunk); }
          catch (e) {
            closeConnection(fd);
            callbacks.onError(c.url, 'TLS feed (handshake): ' + (e.message || e));
            return;
          }
        }
      }
      stepTls(fd, c);
      return;
    }

    // ---- sending ----
    if (c.state === 'sending') {
      if (c.tlsConn) {
        if (ev.events & net.EPOLLIN) {
          let chunk;
          try { chunk = tls.recvBytes(fd, 8192); } catch (_) { chunk = null; }
          if (chunk === null) {
            closeConnection(fd);
            callbacks.onError(c.url, 'Connection closed while flushing TLS');
            return;
          }
          if (chunk.length > 0) { try { tls.feedIncoming(c.tlsConn, chunk); } catch (_) {} }
        }
        if (ev.events & net.EPOLLOUT) {
          if (flushTlsOut(fd, c)) {
            c.state = 'receiving';
            setEpoll(fd, net.EPOLLIN);
          }
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

    // ---- receiving ----
    if (c.state === 'receiving' && (ev.events & net.EPOLLIN)) {

      if (c.tlsConn) {
        let chunk;
        try { chunk = tls.recvBytes(fd, 8192); }
        catch (e) {
          closeConnection(fd);
          callbacks.onError(c.url, 'TLS recv: ' + (e.message || e));
          return;
        }
        if (chunk === null) {
          // EOF: drain any remaining plaintext bytes from OpenSSL
          try {
            for (;;) {
              const out = tls.readBytes(c.tlsConn);
              if (typeof out === 'number') break;
              if (out.length === 0) break;
              c.recvBytes = concatBytes(c.recvBytes, out);
            }
          } catch (_) {}
          closeConnection(fd);
          processResponse(c);
          return;
        }
        if (chunk.length > 0) {
          if (!feedTlsIn(fd, c, chunk)) {
            if (c.truncated) { closeConnection(fd); processResponse(c); }
            return;
          }
        }
      } else {
        const chunk = net.recv(fd, 8192);
        if (chunk === '') {
          closeConnection(fd);
          processResponse(c);
          return;
        }
        c.recv += chunk;
        if (c.recv.length > MAX_RESPONSE_BYTES) {
          c.recv = c.recv.slice(0, MAX_RESPONSE_BYTES);
          c.truncated = true;
          closeConnection(fd);
          processResponse(c);
          return;
        }
      }

      const size = c.tlsConn ? c.recvBytes.length : c.recv.length;
      callbacks.onStatus(c.url, 'Receiving… ' + size + ' bytes');
    }
  }

  function processResponse(c) {
    const raw = c.tlsConn ? decodeUtf8(c.recvBytes) : c.recv;
    const resp = parseHttpResponse(raw);
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
      if (target === c.url) {
        callbacks.onError(c.url, 'Redirect loop: ' + target);
        return;
      }
      callbacks.onStatus(c.url, `Redirect ${resp.status} → ${target}`);
      // ★ CRITICAL: drop `parsed` so fetch() re-parses the NEW url
      const nextOpts = { redirectCount: c.redirects + 1 };
      if (c.options && c.options.fromHistory) nextOpts.fromHistory = true;
      fetch(target, nextOpts);
      return;
    }
    if (c.truncated) callbacks.onStatus(c.url, 'Response truncated at 5MB');
    callbacks.onResponse(c.url, resp, c.options);
  }

  return { fetch, onEvent, setCallbacks };
}
