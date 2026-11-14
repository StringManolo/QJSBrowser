export function normalizeUrl(u) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

export function parseUrl(u) {
  u = normalizeUrl(u);
  const m = u.match(/^(https?):\/\/([^\/:?#]+)(?::(\d+))?([\/?#].*)?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const defaultPort = scheme === 'https' ? 443 : 80;
  return {
    scheme,
    host:   m[2],
    port:   +(m[3] || defaultPort),
    path:   m[4] || '/',
  };
}

export function resolveUrl(base, rel) {
  if (!rel) return base;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;
  if (rel.startsWith('//')) return 'http:' + rel;
  const b = parseUrl(base);
  if (!b) return rel;
  const defaultPort = b.scheme === 'https' ? 443 : 80;
  const portSuffix = (b.port && b.port !== defaultPort) ? ':' + b.port : '';
  const origin = `${b.scheme}://${b.host}${portSuffix}`;
  if (rel.startsWith('/')) return origin + rel;
  if (rel.startsWith('?')) return origin + b.path.split('?')[0] + rel;
  if (rel.startsWith('#')) return base.split('#')[0] + rel;
  const pathOnly = b.path.split('?')[0].split('#')[0];
  const dir = pathOnly.substring(0, pathOnly.lastIndexOf('/') + 1) || '/';
  const parts = (dir + rel).split('/');
  const stack = [];
  for (const p of parts) {
    if (p === '..') stack.pop();
    else if (p !== '.' && p !== '') stack.push(p);
  }
  return origin + '/' + stack.join('/');
}
