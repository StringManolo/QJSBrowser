import { parseUrl, resolveUrl } from 'src/base/url.js';
import { parseHttpResponse, isRedirect } from 'src/net/http-parser.js';

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function concatBytes(a, b) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function stringToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
  return out;
}

function decodeUtf8(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { out += String.fromCharCode(b0); i++; }
    else if (b0 < 0xC2) { out += '\uFFFD'; i++; }
    else if (b0 < 0xE0) {
      if (i + 1 >= bytes.length) { out += '\uFFFD'; break; }
      const b1 = bytes[i + 1];
      if ((b1 & 0xC0) !== 0x80) { out += '\uFFFD'; i++; continue; }
      out += String.fromCharCode(((b0 & 0x1F) << 6) | (b1 & 0x3F));
      i += 2;
    } else if (b0 < 0xF0) {
      if (i + 2 >= bytes.length) { out += '\uFFFD'; break; }
      const b1 = bytes[i + 1], b2 = bytes[i + 2];
      if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80) { out += '\uFFFD'; i++; continue; }
      out += String.fromCharCode(((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F));
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
    } else { out += '\uFFFD'; i++; }
  }
  return out;
}

function decodeLatin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function decodeBody(bytes, contentType) {
  const ct = (contentType || '').toLowerCase();
  const match = ct.match(/charset\s*=\s*["']?([^"';\s]+)/);
  const charset = match ? match[1] : null;

  if (charset) {
    if (charset === 'iso-8859-1' || charset === 'latin1' ||
        charset === 'latin-1'   || charset === 'windows-1252') {
      return decodeLatin1(bytes);
    }
    if (charset === 'utf-8' || charset === 'utf8') return decodeUtf8(bytes);
  }

  const utf8 = decodeUtf8(bytes);
  let bad = 0;
  for (let i = 0; i < utf8.length; i++) if (utf8.charCodeAt(i) === 0xFFFD) bad++;
  if (bad > 0 && bad * 20 > utf8.length) return decodeLatin1(bytes);
  return utf8;
}

export function createHttpClient(net, epfd, tls, cookieJar, zlib) {
  const connections = {};
  let callbacks = { onStatus(){}, onResponse(){}, onError(){} };

  function setCallbacks(cb) { callbacks = { ...callbacks, ...cb }; }

  function buildRequest(p, cookieHeader) {
    let req =
      `GET ${p.path} HTTP/1.0\r\n` +
      `Host: ${p.host}\r\n` +
      `User-Agent: QJSBrowser/0.1\r\n` +
      `Accept-Encoding: identity\r\n` +
      `Connection: close\r\n`;
    if (cookieHeader) req += `Cookie: ${cookieHeader}\r\n`;
    req += '\r\n';
    return req;
  }

  function closeConnection(fd) {
    const c = connections[fd];
    if (c && c.tlsConn) { try { tls.free(c.tlsConn); } catch (_) {} }
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_DEL, fd); } catch (_) {}
    try { net.close(fd); } catch (_) {}
    delete connections[fd];
  }

  function setEpoll(fd, events) {
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_MOD, fd, events); } catch (_) {}
  }

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
      callbacks.onError(c.url, e.message || String(e), c.options);
      return false;
    }
    const drained = flushTlsOut(fd, c);
    if (res === 1) {
      try { tls.write(c.tlsConn, c.request); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS write: ' + (e.message || e), c.options);
        return false;
      }
      if (flushTlsOut(fd, c)) { c.state = 'receiving'; setEpoll(fd, net.EPOLLIN); }
      else                    { c.state = 'sending';   setEpoll(fd, net.EPOLLIN | net.EPOLLOUT); }
      return true;
    }
    if (res === 2) { setEpoll(fd, drained ? net.EPOLLIN : (net.EPOLLIN | net.EPOLLOUT)); return true; }
    if (res === 3) { setEpoll(fd, net.EPOLLIN | net.EPOLLOUT); return true; }
    closeConnection(fd);
    callbacks.onError(c.url, 'TLS handshake error code ' + res, c.options);
    return false;
  }

  function feedTlsIn(fd, c, bytes) {
    if (bytes && bytes.length > 0) {
      try { tls.feedIncoming(c.tlsConn, bytes); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS feed: ' + (e.message || e), c.options);
        return false;
      }
    }
    for (;;) {
      let out;
      try { out = tls.readBytes(c.tlsConn); }
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS read: ' + (e.message || e), c.options);
        return false;
      }
      if (out === -1) return true;
      if (out === -2) return true;
      if (out === -3) { setEpoll(fd, net.EPOLLIN | net.EPOLLOUT); return true; }
      if (typeof out === 'number') {
        closeConnection(fd);
        callbacks.onError(c.url, 'TLS read status ' + out, c.options);
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

  function fetch(url, options = {}) {
    const p = parseUrl(url);
    if (!p) { callbacks.onError(url, 'Invalid URL', options); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      callbacks.onError(url, 'Unsupported scheme: ' + p.scheme, options);
      return;
    }

    let ip;
    try { ip = net.gethostbyname(p.host); }
    catch (e) { callbacks.onError(url, 'DNS failed: ' + p.host, options); return; }

    const fd = net.socket(net.AF_INET, net.SOCK_STREAM, 0);
    net.setnonblocking(fd);
    net.connect(fd, ip, p.port);

    const cookieHeader = cookieJar ? cookieJar.getCookieHeader(url) : '';
    const request = buildRequest(p, cookieHeader);

    const conn = {
      state:        'connecting',
      url,
      parsed:       p,
      options,
      request,
      requestBytes: null,
      sent:         0,
      recvBytes:    new Uint8Array(0),
      redirects:    options.redirectCount || 0,
      tlsConn:      null,
      tlsOut:       new Uint8Array(0),
      truncated:    false,
    };

    if (p.scheme === 'https') {
      try {
        conn.tlsConn = tls.new();
        if (typeof tls.setServerName === 'function')
          tls.setServerName(conn.tlsConn, p.host);
      } catch (e) {
        try { net.close(fd); } catch (_) {}
        callbacks.onError(url, 'TLS init failed: ' + (e.message || e), options);
        return;
      }
    } else {
      conn.requestBytes = stringToBytes(conn.request);
    }

    connections[fd] = conn;
    callbacks.onStatus(url, 'Connecting ' + p.host + ':' + p.port, options);
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, fd, net.EPOLLOUT); }
    catch (e) {
      closeConnection(fd);
      callbacks.onError(url, 'epoll_ctl: ' + (e.message || e), options);
    }
  }

  function onEvent(ev) {
    const fd = ev.fd;
    const c = connections[fd];
    if (!c) return;

    if (c.state === 'connecting' && (ev.events & net.EPOLLOUT)) {
      if (!net.is_connected(fd)) {
        closeConnection(fd);
        callbacks.onError(c.url, 'Connection failed', c.options);
        return;
      }
      if (c.tlsConn) { c.state = 'tls_handshake'; stepTls(fd, c); }
      else {
        const sent = tls.sendBytes(fd, c.requestBytes);
        if (sent >= c.requestBytes.length) {
          c.state = 'receiving'; setEpoll(fd, net.EPOLLIN);
        } else {
          c.sent = sent; c.state = 'sending'; setEpoll(fd, net.EPOLLOUT);
        }
      }
      return;
    }

    if (c.state === 'tls_handshake') {
      if (ev.events & net.EPOLLIN) {
        let chunk;
        try { chunk = tls.recvBytes(fd, 8192); }
        catch (e) { closeConnection(fd); callbacks.onError(c.url, 'TLS recv: ' + (e.message || e), c.options); return; }
        if (chunk === null) {
          closeConnection(fd);
          callbacks.onError(c.url, 'Connection closed during TLS handshake', c.options);
          return;
        }
        if (chunk.length > 0) {
          try { tls.feedIncoming(c.tlsConn, chunk); }
          catch (e) { closeConnection(fd); callbacks.onError(c.url, 'TLS feed: ' + (e.message || e), c.options); return; }
        }
      }
      stepTls(fd, c);
      return;
    }

    if (c.state === 'sending') {
      if (c.tlsConn) {
        if (ev.events & net.EPOLLIN) {
          let chunk;
          try { chunk = tls.recvBytes(fd, 8192); } catch (_) { chunk = null; }
          if (chunk === null) {
            closeConnection(fd);
            callbacks.onError(c.url, 'Connection closed while flushing TLS', c.options);
            return;
          }
          if (chunk.length > 0) { try { tls.feedIncoming(c.tlsConn, chunk); } catch (_) {} }
        }
        if (ev.events & net.EPOLLOUT) {
          if (flushTlsOut(fd, c)) { c.state = 'receiving'; setEpoll(fd, net.EPOLLIN); }
        }
      } else {
        if (ev.events & net.EPOLLOUT) {
          const remaining = c.requestBytes.subarray(c.sent);
          c.sent += tls.sendBytes(fd, remaining);
          if (c.sent >= c.requestBytes.length) {
            c.state = 'receiving'; setEpoll(fd, net.EPOLLIN);
          }
        }
      }
      return;
    }

    if (c.state === 'receiving' && (ev.events & net.EPOLLIN)) {
      let chunk;
      try { chunk = tls.recvBytes(fd, 8192); }
      catch (e) { closeConnection(fd); callbacks.onError(c.url, 'recv: ' + (e.message || e), c.options); return; }

      if (chunk === null) {
        if (c.tlsConn) {
          try {
            for (;;) {
              const out = tls.readBytes(c.tlsConn);
              if (typeof out === 'number') break;
              if (out.length === 0) break;
              c.recvBytes = concatBytes(c.recvBytes, out);
            }
          } catch (_) {}
        }
        closeConnection(fd);
        processResponse(c);
        return;
      }

      if (chunk.length > 0) {
        if (c.tlsConn) {
          if (!feedTlsIn(fd, c, chunk)) {
            if (c.truncated) { closeConnection(fd); processResponse(c); }
            return;
          }
        } else {
          c.recvBytes = concatBytes(c.recvBytes, chunk);
          if (c.recvBytes.length > MAX_RESPONSE_BYTES) {
            c.recvBytes = c.recvBytes.subarray(0, MAX_RESPONSE_BYTES);
            c.truncated = true;
            closeConnection(fd);
            processResponse(c);
            return;
          }
        }
      }

      callbacks.onStatus(c.url, 'Receiving… ' + c.recvBytes.length + ' bytes', c.options);
    }
  }


    function processResponse(c) {
    let sep = -1;
    for (let i = 0; i < c.recvBytes.length - 3; i++) {
      if (c.recvBytes[i]   === 0x0D && c.recvBytes[i+1] === 0x0A &&
          c.recvBytes[i+2] === 0x0D && c.recvBytes[i+3] === 0x0A) {
        sep = i; break;
      }
    }
    if (sep < 0) { callbacks.onError(c.url, 'Malformed HTTP response', c.options); return; }

    const head = decodeUtf8(c.recvBytes.subarray(0, sep));
    const contentType = (head.match(/^content-type:\s*(.+)$/im) || [])[1] || '';
    const contentEncoding = (head.match(/^content-encoding:\s*(.+)$/im) || [])[1] || '';
    let bodyBytes = c.recvBytes.subarray(sep + 4);

    /* ★ Decompress if server ignored Accept-Encoding: identity */
    const enc = contentEncoding.trim().toLowerCase();
    if (enc && enc !== 'identity' && bodyBytes.length > 0) {
      let decompressed = null;
      if (enc === 'gzip' || enc === 'x-gzip') {
        if (!zlib) {
          callbacks.onError(c.url, 'Received gzip but zlib module is missing', c.options);
          return;
        }
        decompressed = zlib.inflate(bodyBytes, 'gzip');
        if (!decompressed) {
          callbacks.onError(c.url, 'gzip decompression failed', c.options);
          return;
        }
      } else if (enc === 'deflate') {
        if (!zlib) {
          callbacks.onError(c.url, 'Received deflate but zlib module is missing', c.options);
          return;
        }
        decompressed = zlib.inflate(bodyBytes, 'deflate');
        if (!decompressed) {
          callbacks.onError(c.url, 'deflate decompression failed', c.options);
          return;
        }
      } else {
        callbacks.onError(c.url, 'Unsupported Content-Encoding: ' + enc, c.options);
        return;
      }
      bodyBytes = decompressed;
    }

    const isImage = contentType.toLowerCase().startsWith('image/');
    const isBinary = !!(c.options && c.options.binary) || isImage;
    const body = isBinary ? '' : decodeBody(bodyBytes, contentType);

    const resp = parseHttpResponse(head + '\r\n\r\n' + body);
    if (!resp) { callbacks.onError(c.url, 'Malformed HTTP response', c.options); return; }

    resp.rawBytes = bodyBytes;
    resp.contentType = contentType;

    if (cookieJar && resp.setCookies && resp.setCookies.length > 0) {
      for (const sc of resp.setCookies) cookieJar.store(sc, c.url);
    }

    if (isRedirect(resp.status) && resp.headers.location) {
      if (c.redirects >= 10) {
        callbacks.onError(c.url, 'Too many redirects (limit 10)', c.options);
        return;
      }
      const target = resolveUrl(c.url, resp.headers.location);
      if (target === c.url) {
        callbacks.onError(c.url, 'Redirect loop: ' + target, c.options);
        return;
      }
      callbacks.onStatus(c.url, `Redirect ${resp.status} → ${target}`, c.options);
      const nextOpts = { ...c.options, redirectCount: c.redirects + 1 };
      fetch(target, nextOpts);
      return;
    }
    if (c.truncated) callbacks.onStatus(c.url, 'Response truncated at 20MB', c.options);
    callbacks.onResponse(c.url, resp, c.options);
  }

  return { fetch, onEvent, setCallbacks };
}
