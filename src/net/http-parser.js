export function parseHttpResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const head = raw.slice(0, sep).split('\r\n');
  const sm = head[0].match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
  const headers = {};
  for (let i = 1; i < head.length; i++) {
    const c = head[i].indexOf(':');
    if (c < 0) continue;
    headers[head[i].slice(0, c).trim().toLowerCase()] = head[i].slice(c + 1).trim();
  }
  return {
    status:     sm ? +sm[1] : 0,
    statusText: sm ? sm[2] : '',
    headers,
    body:       raw.slice(sep + 4),
  };
}

export function isRedirect(status) {
  return status === 301 || status === 302 ||
         status === 303 || status === 307 || status === 308;
}
