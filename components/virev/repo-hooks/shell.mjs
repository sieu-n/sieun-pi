export function stripHeredocs(str) {
  const lines = str.split('\n');
  const out = [];
  let endTag = null;
  for (const line of lines) {
    if (endTag !== null) {
      if (line.trim() === endTag || line.trim() === `\t${endTag}`) endTag = null;
      continue;
    }
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) endTag = m[2];
    out.push(line);
  }
  return out.join('\n');
}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const WRAPPERS = new Set(['command', 'exec', 'time', 'nice', 'nohup', 'setsid',
  'stdbuf', 'ionice', 'builtin', 'caffeinate']);

export function lex(str) {
  const commands = [];
  const nested = [];
  let argv = [];
  let cur = '';
  let has = false;
  let i = 0;
  const n = str.length;
  const endWord = () => { if (has) { argv.push(cur); cur = ''; has = false; } };
  const endCmd = () => { endWord(); if (argv.length) { commands.push(argv); argv = []; } };

  const grabBalanced = (open, close, start) => {
    let depth = 0, j = start, q = null;
    for (; j < n; j++) {
      const ch = str[j];
      if (q) { if (ch === '\\' && q === '"') j++; else if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return { inner: str.slice(start + 1, j), end: j + 1 }; }
    }
    return { inner: str.slice(start + 1), end: n };
  };
  const grabBacktick = (start) => {
    let j = start + 1;
    for (; j < n; j++) { if (str[j] === '\\') j++; else if (str[j] === '`') break; }
    return { inner: str.slice(start + 1, j), end: Math.min(j + 1, n) };
  };

  while (i < n) {
    const c = str[i];
    if (c === '\\') { cur += str[i + 1] ?? ''; has = true; i += 2; continue; }
    if (c === "'") { let j = i + 1; while (j < n && str[j] !== "'") j++; cur += str.slice(i + 1, j); has = true; i = j < n ? j + 1 : j; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && str[j] !== '"') {
        if (str[j] === '\\') { cur += str[j + 1] ?? ''; j += 2; continue; }
        if (str[j] === '$' && str[j + 1] === '(') { const g = grabBalanced('(', ')', j + 1); nested.push(g.inner); j = g.end; continue; }
        if (str[j] === '`') { const g = grabBacktick(j); nested.push(g.inner); j = g.end; continue; }
        cur += str[j]; j++;
      }
      has = true; i = j < n ? j + 1 : j; continue;
    }
    if (c === '`') { const g = grabBacktick(i); nested.push(g.inner); i = g.end; continue; }
    if (c === '$' && str[i + 1] === '(') { const g = grabBalanced('(', ')', i + 1); nested.push(g.inner); i = g.end; continue; }
    if (c === '(') { const g = grabBalanced('(', ')', i); nested.push(g.inner); i = g.end; continue; }
    if (c === '\n' || c === ';') { endCmd(); i++; continue; }
    if (c === '&') { endCmd(); i += str[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '|') { endCmd(); i += str[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '>' || c === '<') { endWord(); i++; while (i < n && /[\s>&\d-]/.test(str[i])) i++; continue; }
    if (/\s/.test(c)) { endWord(); i++; continue; }
    cur += c; has = true; i++;
  }
  endCmd();
  return { commands, nested };
}

export function effective(argv) {
  let k = 0;
  while (k < argv.length) {
    const w = argv[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { k++; continue; }
    if (w === 'sudo' || w === 'doas') { k++; while (k < argv.length && argv[k].startsWith('-')) { k += argv[k] === '-u' || argv[k] === '--user' ? 2 : 1; } continue; }
    if (w === 'env') { k++; while (k < argv.length && (argv[k].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k]))) k++; continue; }
    if (WRAPPERS.has(w)) { k++; continue; }
    break;
  }
  return argv.slice(k);
}
