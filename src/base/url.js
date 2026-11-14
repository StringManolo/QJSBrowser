export function normalizeUrl(u) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

export function parseUrl(u) {
  u = normalizeUrl(u);
  const m = u.match(/^(https?):\/\/([^\/:?#]+)(?::(\d+))?([\/?#].*)?$/i);
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    host:   m[2],
    port:   +(m[3] || 80),
    path:   m[4] || '/',
  };
}

export function resolveUrl(base, rel) {
  if (!rel) return base;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;
  if (rel.startsWith('//')) return 'http:' + rel;
  const b = parseUrl(base);
  if (!b) return rel;
  const origin = `${b.scheme}://${b.host}${(b.port && b.port !== 80) ? ':' + b.port : ''}`;
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
