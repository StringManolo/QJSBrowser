import { parseUrl } from 'src/base/url.js';

export function createCookieJar(fs) {
  const cookies = [];

  const configDir  = fs ? fs.homeDir() + '/.config/qjsbrowser' : null;
  const cookiePath = configDir ? configDir + '/cookies.json' : null;

  let lastSave = 0;
  const SAVE_THROTTLE_MS = 1000;

  function load() {
    if (!cookiePath || !fs.exists(cookiePath)) return;
    try {
      const raw = fs.readFile(cookiePath);
      const parsed = JSON.parse(raw);
      const arr = parsed && parsed.cookies;
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      for (const c of arr) {
        if (!c || !c.name || !c.domain) continue;
        if (c.expires !== null && c.expires !== undefined && c.expires <= now) continue;
        cookies.push({
          name:     String(c.name),
          value:    String(c.value || ''),
          domain:   String(c.domain),
          path:     String(c.path || '/'),
          expires:  c.expires === null || c.expires === undefined ? null : +c.expires,
          secure:   !!c.secure,
          hostOnly: !!c.hostOnly,
        });
      }
    } catch (_) { /* corrupt file → start fresh */ }
  }

  function saveNow() {
    if (!cookiePath || !fs) return;
    try {
      fs.mkdirp(configDir);
      fs.writeFile(cookiePath, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        cookies: cookies.map(c => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          expires: c.expires, secure: c.secure, hostOnly: c.hostOnly,
        })),
      }, null, 2));
    } catch (_) { /* disk full / read-only fs — silently ignore */ }
  }

  function saveThrottled() {
    const now = Date.now();
    if (now - lastSave < SAVE_THROTTLE_MS) return;
    lastSave = now;
    saveNow();
  }

  function save() { lastSave = 0; saveNow(); }

  function parseSetCookie(header, requestUrl) {
    const parsed = parseUrl(requestUrl);
    if (!parsed) return null;

    const parts = header.split(';');
    const nameValue = parts.shift().trim();
    const eq = nameValue.indexOf('=');
    if (eq <= 0) return null;

    const name  = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();

    let domain  = parsed.host.toLowerCase();
    let hostOnly = true;
    let path = null;
    let expires = null;
    let secure = false;

    for (const raw of parts) {
      const attr = raw.trim();
      const aeq = attr.indexOf('=');
      const aname  = (aeq < 0 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
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

    const parsed = parseUrl(requestUrl);
    if (!domainMatches(parsed.host, cookie)) return;

    for (let i = cookies.length - 1; i >= 0; i--) {
      const c = cookies[i];
      if (c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path) {
        cookies.splice(i, 1);
      }
    }

    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      saveThrottled();
      return;
    }

    cookies.push(cookie);
    saveThrottled();
  }

  function getCookieHeader(url) {
    const parsed = parseUrl(url);
    if (!parsed) return '';

    const now = Date.now();
    let mutated = false;
    for (let i = cookies.length - 1; i >= 0; i--) {
      if (cookies[i].expires !== null && cookies[i].expires <= now) {
        cookies.splice(i, 1);
        mutated = true;
      }
    }
    if (mutated) saveThrottled();

    const matching = [];
    for (const c of cookies) {
      if (c.secure && parsed.scheme !== 'https') continue;
      if (!domainMatches(parsed.host, c)) continue;
      if (!pathMatches(parsed.path, c.path)) continue;
      matching.push(c);
    }
    matching.sort((a, b) => b.path.length - a.path.length);

    return matching.map(c => c.name + '=' + c.value).join('; ');
  }

  function clear() {
    cookies.length = 0;
    save();
  }

  return {
    store, getCookieHeader, clear, load, save, saveNow,
    get size() { return cookies.length; },
    _debug: () => cookies.slice(),
  };
}
