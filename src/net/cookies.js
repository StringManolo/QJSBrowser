import { parseUrl } from 'src/base/url.js';

export function createCookieJar() {
  const cookies = [];

  function parseSetCookie(header, requestUrl) {
    const parsed = parseUrl(requestUrl);
    if (!parsed) return null;

    const parts = header.split(';');
    const nameValue = parts.shift().trim();
    const eq = nameValue.indexOf('=');
    if (eq <= 0) return null;

    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();

    let domain = parsed.host.toLowerCase();
    let hostOnly = true;
    let path = null;
    let expires = null;
    let secure = false;

    for (const raw of parts) {
      const attr = raw.trim();
      const aeq = attr.indexOf('=');
      const aname = (aeq < 0 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
      const avalue = aeq < 0 ? '' : attr.slice(aeq + 1).trim();

      if (aname === 'domain') {
        domain = avalue.startsWith('.') ? avalue.slice(1).toLowerCase() : avalue.toLowerCase();
        hostOnly = false;
      } else if (aname === 'path') {
        path = avalue || '/';
      } else if (aname === 'expires') {
        const t = Date.parse(avalue);
        if (!isNaN(t)) expires = t;
      } else if (aname === 'max-age') {
        const sec = parseInt(avalue, 10);
        if (!isNaN(sec)) expires = Date.now() + sec * 1000;
      } else if (aname === 'secure') {
        secure = true;
      }
      // httponly / samesite ignored (no page-script execution yet)
    }

    if (!path) {
      const p = parsed.path;
      const idx = p.lastIndexOf('/');
      path = idx > 0 ? p.slice(0, idx) : '/';
    }

    return { name, value, domain, path, expires, secure, hostOnly };
  }

  function domainMatches(host, cookie) {
    host = host.toLowerCase();
    if (cookie.hostOnly) return host === cookie.domain;
    if (host === cookie.domain) return true;
    return host.endsWith('.' + cookie.domain);
  }

  function pathMatches(reqPath, cookiePath) {
    if (reqPath === cookiePath) return true;
    if (!reqPath.startsWith(cookiePath)) return false;
    if (cookiePath.endsWith('/')) return true;
    return reqPath[cookiePath.length] === '/';
  }

  function store(header, requestUrl) {
    const cookie = parseSetCookie(header, requestUrl);
    if (!cookie) return;

    // Reject if the cookie's domain doesn't cover the request host
    const parsed = parseUrl(requestUrl);
    if (!domainMatches(parsed.host, cookie)) return;

    // Remove existing cookie with same (domain, path, name)
    for (let i = cookies.length - 1; i >= 0; i--) {
      const c = cookies[i];
      if (c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path) {
        cookies.splice(i, 1);
      }
    }

    // Expired or max-age <= 0 → don't store
    if (cookie.expires !== null && cookie.expires <= Date.now()) return;

    cookies.push(cookie);
  }

  function getCookieHeader(url) {
    const parsed = parseUrl(url);
    if (!parsed) return '';

    const now = Date.now();
    // GC expired cookies
    for (let i = cookies.length - 1; i >= 0; i--) {
      if (cookies[i].expires !== null && cookies[i].expires <= now) {
        cookies.splice(i, 1);
      }
    }

    const matching = [];
    for (const c of cookies) {
      if (c.secure && parsed.scheme !== 'https') continue;
      if (!domainMatches(parsed.host, c)) continue;
      if (!pathMatches(parsed.path, c.path)) continue;
      matching.push(c);
    }

    // Longer path first (RFC 6265 §5.4)
    matching.sort((a, b) => b.path.length - a.path.length);

    return matching.map(c => c.name + '=' + c.value).join('; ');
  }

  return {
    store,
    getCookieHeader,
    get size() { return cookies.length; },
    _debug: () => cookies.slice(),
  };
}
