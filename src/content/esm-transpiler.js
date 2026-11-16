/* Transpiles a single ES module source to a plain script body that:
 *   - reads its dependencies from __modules__[resolvedUrl]
 *   - writes its exports into __exports__
 *   - routes dynamic import('spec') through __import(resolvedUrl)
 *   - replaces import.meta.url with the module's URL literal
 *
 * Covers the subset produced by Vite/Rollup/esbuild production bundles:
 *   import d from 's'            import { a, b as c } from 's'
 *   import * as ns from 's'      import d, { a } from 's'
 *   import d, * as ns from 's'   import 's'
 *   export default <expr|fn|class>
 *   export function f(){}        export class C {}
 *   export const|let|var a=..., b=...
 *   export { a, b as c } [from 's']
 *   export * from 's'
 *   import('s')                  import.meta.url
 *
 * Does NOT handle (fails loud or silently no-ops):
 *   - top-level await (would need native import() in C — path B)
 *   - live bindings for reassigned exports (snapshot at init; Vite/Rollup
 *     hoists/inlines most reassignments so this rarely bites)
 *   - import.meta.resolve / import.meta.env  (Vite inlines env in prod)
 *   - export * as ns from './x'  (rare; add if needed)
 */

export function transpileModule(source, url, resolveSpecifier) {
  const imports = [];   // resolved dep URLs, in order
  const appended = [];  // `__exports__.x = x;` lines to emit at end
  let out = '';
  let i = 0;
  const n = source.length;

  function addImport(spec) {
    const resolved = resolveSpecifier(spec, url);
    if (!imports.includes(resolved)) imports.push(resolved);
    return resolved;
  }

  while (i < n) {
    const ch = source[i];

    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const stop = skipString(source, i);
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === 'i' && source.startsWith('import', i) &&
        !isId(source[i - 1]) && !isId(source[i + 6])) {
      if (source.startsWith('import.meta.url', i)) {
        out += JSON.stringify(url);
        i += 'import.meta.url'.length;
        continue;
      }
      if (source.startsWith('import.meta', i)) {
        out += '({url:' + JSON.stringify(url) + '})';
        i += 'import.meta'.length;
        continue;
      }
      let k = i + 6;
      while (k < n && /\s/.test(source[k])) k++;
      if (source[k] === '(') {
        out += '__import';
        i += 6;
        continue;
      }
      const parsed = parseStaticImport(source, i, addImport);
      if (parsed) {
        out += parsed.code;
        i = parsed.end;
        continue;
      }
    }

    if (ch === 'e' && source.startsWith('export', i) &&
        !isId(source[i - 1]) && !isId(source[i + 6])) {
      const parsed = parseExport(source, i, addImport, appended);
      if (parsed) {
        out += parsed.code;
        i = parsed.end;
        continue;
      }
    }

    out += ch;
    i++;
  }

  if (appended.length) out += ';' + appended.join(';');
  return { code: out, imports };
}

/* ------------------------------------------------------------------ */

function isId(c) { return !!c && /[A-Za-z0-9_$]/.test(c); }

function skipString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === q) return j + 1;
    j++;
  }
  return j;
}
function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

function readString(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  let j = i + 1, buf = '';
  while (j < s.length) {
    if (s[j] === '\\') { buf += s[j] + s[j + 1]; j += 2; continue; }
    if (s[j] === q) return { value: buf, end: j + 1 };
    buf += s[j];
    j++;
  }
  return null;
}

function readIdent(s, i) {
  if (!/[A-Za-z_$]/.test(s[i])) return null;
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
  return { value: s.slice(i, j), end: j };
}

function parseStaticImport(s, i, addImport) {
  let j = skipWs(s, i + 6);
  const side = readString(s, j);
  if (side) {
    const dep = addImport(side.value);
    let k = skipWs(s, side.end);
    if (s[k] === ';') k++;
    return { code: '__require(' + JSON.stringify(dep) + ');', end: k };
  }

  const specs = [];
  if (s[j] === '*') {
    j = skipWs(s, j + 1);
    if (!s.startsWith('as', j) || isId(s[j + 2])) return null;
    j = skipWs(s, j + 2);
    const id = readIdent(s, j); if (!id) return null;
    specs.push({ local: id.value, imported: '*' });
    j = id.end;
  } else if (s[j] === '{') {
    const named = readNamedList(s, j); if (!named) return null;
    specs.push(...named.specs);
    j = named.end;
  } else {
    const id = readIdent(s, j); if (!id) return null;
    specs.push({ local: id.value, imported: 'default' });
    j = skipWs(s, id.end);
    if (s[j] === ',') {
      j = skipWs(s, j + 1);
      if (s[j] === '{') {
        const named = readNamedList(s, j); if (!named) return null;
        specs.push(...named.specs);
        j = named.end;
      } else if (s[j] === '*') {
        j = skipWs(s, j + 1);
        if (!s.startsWith('as', j) || isId(s[j + 2])) return null;
        j = skipWs(s, j + 2);
        const id2 = readIdent(s, j); if (!id2) return null;
        specs.push({ local: id2.value, imported: '*' });
        j = id2.end;
      } else return null;
    }
  }

  j = skipWs(s, j);
  if (!s.startsWith('from', j) || isId(s[j + 4])) return null;
  j = skipWs(s, j + 4);
  const src = readString(s, j); if (!src) return null;
  j = skipWs(s, src.end);
  if (s[j] === ';') j++;

  const dep = addImport(src.value);
  const ref = '__modules__[' + JSON.stringify(dep) + ']';
  let code = '';
  for (const sp of specs) {
    if (sp.imported === '*') code += 'const ' + sp.local + '=' + ref + ';';
    else code += 'const ' + sp.local + '=' + ref + '[' + JSON.stringify(sp.imported) + '];';
  }
  return { code, end: j };
}

function readNamedList(s, i) {
  if (s[i] !== '{') return null;
  let j = i + 1;
  const specs = [];
  while (j < s.length) {
    j = skipWs(s, j);
    if (s[j] === '}') return { specs, end: j + 1 };
    if (s[j] === ',') { j++; continue; }
    const id = readIdent(s, j); if (!id) return null;
    let local = id.value, imported = id.value;
    j = skipWs(s, id.end);
    if (s.startsWith('as', j) && !isId(s[j + 2])) {
      j = skipWs(s, j + 2);
      const id2 = readIdent(s, j); if (!id2) return null;
      local = id2.value;
      j = id2.end;
    }
    specs.push({ local, imported });
  }
  return null;
}

function parseExport(s, i, addImport, appended) {
  let j = skipWs(s, i + 6);

  if (s.startsWith('default', j) && !isId(s[j + 7])) {
    j = skipWs(s, j + 7);
    if (/^(async\s+function|function|class)/.test(s.slice(j))) {
      const m = s.slice(j).match(/^(async\s+)?(function|class)\s*([A-Za-z_$][\w$]*)?/);
      if (m && m[3]) {
        appended.push('__exports__.default=' + m[3]);
        return { code: '', end: j };
      }
    }
    return { code: '__exports__.default=', end: j };
  }

  if (/^(async\s+function|function|class)\b/.test(s.slice(j))) {
    const m = s.slice(j).match(/^(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)/);
    if (m) appended.push('__exports__.' + m[1] + '=' + m[1]);
    return { code: '', end: i + 6 };
  }

  if (/^(const|let|var)\b/.test(s.slice(j))) {
    const kwLen = s[j] === 'v' ? 3 : (s[j] === 'l' ? 3 : 5);
    const names = readDeclaratorNames(s, j + kwLen);
    for (const n of names) appended.push('__exports__.' + n + '=' + n);
    return { code: '', end: i + 6 };
  }

  if (s[j] === '{') {
    const named = readNamedList(s, j);
    if (!named) return null;
    let k = skipWs(s, named.end);
    if (s.startsWith('from', k) && !isId(s[k + 4])) {
      k = skipWs(s, k + 4);
      const src = readString(s, k); if (!src) return null;
      k = skipWs(s, src.end);
      if (s[k] === ';') k++;
      const dep = addImport(src.value);
      const ref = '__modules__[' + JSON.stringify(dep) + ']';
      let code = '';
      for (const sp of named.specs) {
        code += '__exports__[' + JSON.stringify(sp.local) + ']=' +
                ref + '[' + JSON.stringify(sp.imported) + '];';
      }
      return { code, end: k };
    }
    if (s[k] === ';') k++;
    let code = '';
    for (const sp of named.specs) {
      code += '__exports__[' + JSON.stringify(sp.local) + ']=' + sp.imported + ';';
    }
    return { code, end: k };
  }

  if (s[j] === '*') {
    let k = skipWs(s, j + 1);
    if (!s.startsWith('from', k) || isId(s[k + 4])) return null;
    k = skipWs(s, k + 4);
    const src = readString(s, k); if (!src) return null;
    k = skipWs(s, src.end);
    if (s[k] === ';') k++;
    const dep = addImport(src.value);
    return {
      code: 'Object.assign(__exports__,__modules__[' + JSON.stringify(dep) + ']);',
      end: k,
    };
  }

  return null;
}

function readDeclaratorNames(s, i) {
  const names = [];
  let j = i, depth = 0;
  while (j < s.length) {
    j = skipWs(s, j);
    const c = s[j];
    if (c === ';' || (depth === 0 && c === '}')) break;
    if (c === '"' || c === "'" || c === '`') { j = skipString(s, j); continue; }
    if (c === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++; continue; }
    if (c === '/' && s[j + 1] === '*') { const e = s.indexOf('*/', j + 2); j = e < 0 ? s.length : e + 2; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; j++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; j++; continue; }
    if (depth === 0 && /[A-Za-z_$]/.test(c) && (j === i || /[\s,=]/.test(s[j - 1]))) {
      const id = readIdent(s, j);
      if (id) {
        names.push(id.value);
        j = id.end;
        let d2 = 0;
        while (j < s.length) {
          const c2 = s[j];
          if (c2 === '"' || c2 === "'" || c2 === '`') { j = skipString(s, j); continue; }
          if (c2 === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++; continue; }
          if (c2 === '/' && s[j + 1] === '*') { const e = s.indexOf('*/', j + 2); j = e < 0 ? s.length : e + 2; continue; }
          if (c2 === '(' || c2 === '[' || c2 === '{') { d2++; j++; continue; }
          if (c2 === ')' || c2 === ']' || c2 === '}') { if (d2 === 0) break; d2--; j++; continue; }
          if (d2 === 0 && (c2 === ',' || c2 === ';')) break;
          j++;
        }
        if (s[j] === ',') { j++; continue; }
        break;
      }
    }
    j++;
  }
  return names;
}
