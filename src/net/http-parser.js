export function parseHttpResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return null;

  const head = raw.slice(0, sep).split('\r\n');
  const sm = head[0].match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
  const headers = {};
  const setCookies = [];

  for (let i = 1; i < head.length; i++) {
    const line = head[i];
    const c = line.indexOf(':');
    if (c < 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    const value = line.slice(c + 1).trim();

    if (name === 'set-cookie') {
      setCookies.push(value);
    } else {
      headers[name] = value;
    }
  }

  return {
    status: sm ? +sm[1] : 0,
    statusText: sm ? sm[2] : '',
    headers,
    setCookies,
    body: raw.slice(sep + 4),
  };
}

export function isRedirect(status) {
  return status === 301 || status === 302 ||
         status === 303 || status === 307 || status === 308;
}
