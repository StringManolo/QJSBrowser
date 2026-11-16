import { parseUrl, resolveUrl } from 'src/base/url.js';
import { parseHttpResponse, isRedirect } from 'src/net/http-parser.js';

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const MAX_BACKGROUND      = 6;
const CONNECT_TIMEOUT_MS  = 20000;
const IDLE_TIMEOUT_MS     = 30000;
const DNS_TTL_MS          = 60000;
const IPV4_RE             = /^\d{1,3}(\.\d{1,3}){3}$/;

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

function decodeChunked(bytes) {
  /* RFC 7230 §4.1 happy path: hex size [;extensions] CRLF data CRLF …
   * until size == 0. Some CDNs (Fastly behind jsdelivr, notably) ignore
   * `Connection: close` and reply chunked even to HTTP/1.0 requests. */
  const parts = [];
  let i = 0;
  while (i < bytes.length) {
    let j = i;
    while (j < bytes.length - 1 && !(bytes[j] === 0x0D && bytes[j + 1] === 0x0A)) j++;
    if (j >= bytes.length - 1) break;
    const sizeLine = String.fromCharCode.apply(null, bytes.subarray(i, j));
    const size = parseInt(sizeLine.split(';')[0].trim(), 16);
    if (!(size > 0)) break;
    i = j + 2;
    parts.push(bytes.subarray(i, i + size));
    i += size;
    if (i < bytes.length - 1 && bytes[i] === 0x0D && bytes[i + 1] === 0x0A) i += 2;
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function createHttpClient(net, epfd, tls, cookieJar, zlib, dns) {
  const connections = {};
  const jobs        = new Set();
  let   bgQueue     = [];
  let   activeBg    = 0;
  const closing     = [];
  let callbacks = { onStatus(){}, onResponse(){}, onError(){} };

  function setCallbacks(cb) { callbacks = { ...callbacks, ...cb }; }

  const dnsFd = dns.fd();
  net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, dnsFd, net.EPOLLIN);

  const dnsCache   = new Map();
  const dnsPending = new Map();
  const dnsById    = new Map();

  function resolveHost(host, cb) {
    if (IPV4_RE.test(host)) { cb(null, host); return; }
    const key = host.toLowerCase();
    const hit = dnsCache.get(key);
    if (hit && hit.expires > Date.now()) { cb(null, hit.ip); return; }
    let p = dnsPending.get(key);
    if (!p) {
      let id;
      try { id = dns.resolve(key); }
      catch (e) { cb(e.message || String(e), null); return; }
      p = { id, cbs: [] };
      dnsPending.set(key, p);
      dnsById.set(id, key);
    }
    p.cbs.push(cb);
  }

  function onDnsReadable() {
    let results;
    try { results = dns.poll(); }
    catch (e) { console.log('[dns.poll] ' + (e.message || String(e))); return; }

    for (const r of results) {
      const key = dnsById.get(r.id);
      if (key === undefined) continue;
      dnsById.delete(r.id);
      const p = dnsPending.get(key);
      dnsPending.delete(key);
      if (!p) continue;
      if (r.ip) dnsCache.set(key, { ip: r.ip, expires: Date.now() + DNS_TTL_MS });
      for (const cb of p.cbs) {
        try { cb(r.ip ? null : (r.error || 'lookup failed'), r.ip); }
        catch (e) { console.log('[dns callback] ' + (e.message || String(e))); }
      }
    }
  }

  function buildRequest(p, cookieHeader, method, body) {
    let req =
      `${method} ${p.path} HTTP/1.0\r\n` +
      `Host: ${p.host}\r\n` +
      `User-Agent: QJSBrowser/0.1\r\n` +
      `Accept-Encoding: gzip, deflate\r\n` +
      `Connection: close\r\n`;
    if (cookieHeader) req += `Cookie: ${cookieHeader}\r\n`;
    if (body !== null && body !== undefined) {
      req += `Content-Type: application/x-www-form-urlencoded\r\n`;
      req += `Content-Length: ${body.length}\r\n`;
    }
    req += '\r\n';
    if (body !== null && body !== undefined) req += body;
    return req;
  }

  function release(job) {
    if (!jobs.delete(job)) return;
    if (job.counted) { job.counted = false; if (job.background) activeBg--; }
    pump();
  }

  function pump() {
    while (activeBg < MAX_BACKGROUND && bgQueue.length > 0) {
      const job = bgQueue.shift();
      if (jobs.has(job)) startJob(job);
    }
  }

  function closeConnection(fd) {
    const c = connections[fd];
    if (c && c.tlsConn) { try { tls.free(c.tlsConn); } catch (_) {} c.tlsConn = null; }
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_DEL, fd); } catch (_) {}
    delete connections[fd];
    closing.push(fd);
    if (c) { c.fd = -1; release(c); }
  }

  function failJob(job, msg) {
    if (!jobs.has(job)) return;
    if (job.fd >= 0) closeConnection(job.fd); else release(job);
    callbacks.onError(job.url, msg, job.options);
  }

  function setEpoll(fd, events) {
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_MOD, fd, events); } catch (_) {}
  }

  /* Abort everything belonging to a tab. Any pending _promise is rejected
   * so caller-side chains (e.g. script-runner) can stop quietly. */
  function abortTab(tabId) {
    for (const job of [...jobs]) {
      if (!job.options || job.options.tabId !== tabId) continue;
      if (job.options._promise) {
        try { job.options._promise.reject(new Error('aborted')); } catch (_) {}
      }
      if (job.fd >= 0) closeConnection(job.fd); else release(job);
    }
    bgQueue = bgQueue.filter(j => jobs.has(j));
  }

  function tick() {
    const now = Date.now();
    for (const job of [...jobs]) {
      if (job.state === 'queued') continue;
      const limit = (job.state === 'receiving' || job.state === 'sending')
                    ? IDLE_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
      if (now - job.lastActivity > limit) failJob(job, 'Timed out (' + job.state + ')');
    }
    while (closing.length > 0) { try { net.close(closing.pop()); } catch (_) {} }
  }

  function hasJobs() { return jobs.size > 0; }

  function appendRecv(c, bytes) {
    c.chunks.push(bytes);
    c.recvLen += bytes.length;
  }

  function joinRecv(c) {
    if (c.chunks.length === 0) return;
    if (c.chunks.length === 1 && c.recvBytes.length === 0) {
      c.recvBytes = c.chunks[0];
    } else {
      const out = new Uint8Array(c.recvBytes.length + c.recvLen);
      let off = 0;
      if (c.recvBytes.length) { out.set(c.recvBytes, 0); off = c.recvBytes.length; }
      for (const ch of c.chunks) { out.set(ch, off); off += ch.length; }
      c.recvBytes = out;
    }
    c.chunks = [];
    c.recvLen = c.recvBytes.length;
  }

  function capRecv(c) {
    if (c.recvLen <= MAX_RESPONSE_BYTES) return false;
    joinRecv(c);
    c.recvBytes = c.recvBytes.subarray(0, MAX_RESPONSE_BYTES);
    c.recvLen = c.recvBytes.length;
    c.truncated = true;
    return true;
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
      appendRecv(c, out);
      if (capRecv(c)) return false;
    }
  }

  function fetch(url, options = {}) {
    const p = parseUrl(url);
    if (!p) { callbacks.onError(url, 'Invalid URL', options); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      callbacks.onError(url, 'Unsupported scheme: ' + p.scheme, options);
      return;
    }

    const method = (options.method || 'GET').toUpperCase();
    const body   = (options.body !== undefined && options.body !== null)
                   ? String(options.body) : null;
    const cookieHeader = cookieJar ? cookieJar.getCookieHeader(url) : '';
    const request = buildRequest(p, cookieHeader, method, body);

    const job = {
      fd:           -1,
      state:        'queued',
      url,
      parsed:       p,
      options,
      method,
      body,
      request,
      requestBytes: null,
      sent:         0,
      chunks:       [],
      recvLen:      0,
      recvBytes:    new Uint8Array(0),
      redirects:    options.redirectCount || 0,
      tlsConn:      null,
      tlsOut:       new Uint8Array(0),
      truncated:    false,
      background:   !!(options.binary && options.imageFor),
      counted:      false,
      lastActivity: Date.now(),
    };
    jobs.add(job);

    if (job.background && activeBg >= MAX_BACKGROUND) { bgQueue.push(job); return; }
    startJob(job);
  }

  /* Promise wrapper — used by script-runner and (later) window.fetch. */
  function fetchPromise(url, options) {
    return new Promise((resolve, reject) => {
      const opts = { ...(options || {}), _promise: { resolve, reject } };
      fetch(url, opts);
    });
  }

  function startJob(job) {
    job.state = 'resolving';
    job.counted = true;
    if (job.background) activeBg++;
    job.lastActivity = Date.now();
    callbacks.onStatus(job.url, 'Resolving ' + job.parsed.host + '…', job.options);

    resolveHost(job.parsed.host, (err, ip) => {
      if (!jobs.has(job)) return;
      if (err) { failJob(job, 'DNS failed: ' + job.parsed.host); return; }
      connectJob(job, ip);
    });
  }

  function connectJob(job, ip) {
    const p = job.parsed;
    let fd = -1;
    try {
      fd = net.socket(net.AF_INET, net.SOCK_STREAM, 0);
      net.setnonblocking(fd);
      net.connect(fd, ip, p.port);
    } catch (e) {
      if (fd >= 0) { try { net.close(fd); } catch (_) {} }
      failJob(job, 'Connect failed: ' + (e.message || e));
      return;
    }

    if (p.scheme === 'https') {
      try {
        job.tlsConn = tls.new();
        if (typeof tls.setServerName === 'function')
          tls.setServerName(job.tlsConn, p.host);
      } catch (e) {
        if (job.tlsConn) { try { tls.free(job.tlsConn); } catch (_) {} job.tlsConn = null; }
        try { net.close(fd); } catch (_) {}
        failJob(job, 'TLS init failed: ' + (e.message || e));
        return;
      }
    } else {
      job.requestBytes = stringToBytes(job.request);
    }

    job.fd = fd;
    job.state = 'connecting';
    job.lastActivity = Date.now();
    connections[fd] = job;
    callbacks.onStatus(job.url, 'Connecting ' + p.host + ':' + p.port, job.options);
    try { net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, fd, net.EPOLLOUT); }
    catch (e) { failJob(job, 'epoll_ctl: ' + (e.message || e)); }
  }

  function onEvent(ev) {
    const fd = ev.fd;
    if (fd === dnsFd) { onDnsReadable(); return; }

    const c = connections[fd];
    if (!c) return;
    c.lastActivity = Date.now();

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
        catch (e) {
          closeConnection(fd);
          callbacks.onError(c.url, 'TLS recv: ' + (e.message || e), c.options);
          return;
        }
        if (chunk === null) {
          closeConnection(fd);
          callbacks.onError(c.url, 'Connection closed during TLS handshake', c.options);
          return;
        }
        if (chunk.length > 0) {
          try { tls.feedIncoming(c.tlsConn, chunk); }
          catch (e) {
            closeConnection(fd);
            callbacks.onError(c.url, 'TLS feed: ' + (e.message || e), c.options);
            return;
          }
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
      catch (e) {
        closeConnection(fd);
        callbacks.onError(c.url, 'recv: ' + (e.message || e), c.options);
        return;
      }

      if (chunk === null) {
        if (c.tlsConn) {
          try {
            for (;;) {
              const out = tls.readBytes(c.tlsConn);
              if (typeof out === 'number') break;
              if (out.length === 0) break;
              appendRecv(c, out);
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
          appendRecv(c, chunk);
          if (capRecv(c)) {
            closeConnection(fd);
            processResponse(c);
            return;
          }
        }
      }

      callbacks.onStatus(c.url, 'Receiving… ' + c.recvLen + ' bytes', c.options);
    }
  }

  function processResponse(c) {
    joinRecv(c);
    let sep = -1;
    for (let i = 0; i < c.recvBytes.length - 3; i++) {
      if (c.recvBytes[i]   === 0x0D && c.recvBytes[i+1] === 0x0A &&
          c.recvBytes[i+2] === 0x0D && c.recvBytes[i+3] === 0x0A) {
        sep = i; break;
      }
    }
    if (sep < 0) { callbacks.onError(c.url, 'Malformed HTTP response', c.options); return; }

    const head = decodeUtf8(c.recvBytes.subarray(0, sep));
    const contentType     = (head.match(/^content-type:\s*(.+)$/im)     || [])[1] || '';
    const contentEncoding = (head.match(/^content-encoding:\s*(.+)$/im) || [])[1] || '';
    let bodyBytes = c.recvBytes.subarray(sep + 4);

    /* Un-chunk before content-encoding decompression: content-encoding
     * is applied *on top of* transfer-encoding. */
    const transferEncoding = (head.match(/^transfer-encoding:\s*(.+)$/im) || [])[1] || '';
    if (/\bchunked\b/i.test(transferEncoding) && bodyBytes.length > 0) {
      bodyBytes = decodeChunked(bodyBytes);
    }

    const enc = contentEncoding.trim().toLowerCase();
    if (enc && enc !== 'identity' && bodyBytes.length > 0) {
      if (enc === 'gzip' || enc === 'x-gzip') {
        if (!zlib) { callbacks.onError(c.url, 'gzip received but zlib module missing', c.options); return; }
        const out = zlib.inflate(bodyBytes, 'gzip');
        if (!out) { callbacks.onError(c.url, 'gzip decompression failed', c.options); return; }
        bodyBytes = out;
      } else if (enc === 'deflate') {
        if (!zlib) { callbacks.onError(c.url, 'deflate received but zlib module missing', c.options); return; }
        const out = zlib.inflate(bodyBytes, 'deflate');
        if (!out) { callbacks.onError(c.url, 'deflate decompression failed', c.options); return; }
        bodyBytes = out;
      } else {
        callbacks.onError(c.url, 'Unsupported Content-Encoding: ' + enc, c.options);
        return;
      }
    }

    const isImage  = contentType.toLowerCase().startsWith('image/');
    const isBinary = !!(c.options && c.options.binary) || isImage;
    const body = isBinary ? '' : decodeBody(bodyBytes, contentType);

    const resp = parseHttpResponse(head + '\r\n\r\n' + body);
    if (!resp) { callbacks.onError(c.url, 'Malformed HTTP response', c.options); return; }

    resp.rawBytes = bodyBytes;
    resp.contentType = contentType;

    if (cookieJar && resp.setCookies && resp.setCookies.length > 0) {
      for (const sc of resp.setCookies) cookieJar.store(sc, c.url);
    }

    if (!isBinary && bodyBytes.length > 0) {
      const preview = decodeUtf8(bodyBytes.subarray(0, Math.min(bodyBytes.length, 4096)));
      const metaTag = preview.match(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\s*["']?[^>]*>/i);
      if (metaTag) {
        const contentMatch = metaTag[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i)
                          || metaTag[0].match(/\bcontent\s*=\s*([^\s>]+)/i);
        if (contentMatch) {
          const content = contentMatch[1];
          const urlMatch = content.match(/url\s*=\s*([^"'\s;,]+)/i);
          const target = urlMatch
            ? resolveUrl(c.url, urlMatch[1].trim())
            : c.url;

          if (c.redirects < 10) {
            callbacks.onStatus(c.url, `Meta refresh → ${target}`, c.options);
            const nextOpts = {
              ...c.options,
              redirectCount: c.redirects + 1,
              method: 'GET',
              body:   null,
            };
            fetch(target, nextOpts);
            return;
          } else {
            callbacks.onError(c.url, 'Too many redirects (limit 10)', c.options);
            return;
          }
        }
      }
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

      let nextMethod = c.method;
      let nextBody   = c.body;
      if (resp.status === 303) {
        nextMethod = 'GET'; nextBody = null;
      } else if ((resp.status === 301 || resp.status === 302) &&
                 c.method !== 'GET' && c.method !== 'HEAD') {
        nextMethod = 'GET'; nextBody = null;
      }

      const nextOpts = {
        ...c.options,
        redirectCount: c.redirects + 1,
        method: nextMethod,
        body:   nextBody,
      };
      fetch(target, nextOpts);
      return;
    }

    if (c.truncated) callbacks.onStatus(c.url, 'Response truncated at 20MB', c.options);
    callbacks.onResponse(c.url, resp, c.options);
  }

  return { fetch, fetchPromise, onEvent, setCallbacks, abortTab, tick, hasJobs };
}