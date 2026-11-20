// Where the local web UI listens. Shared by bpt (pulsar-backport) and prd (pr-review-desk); the two copies of this
// file are identical, so each skill stays self-contained.
//
// Config: $PCT_SERVERS_CONFIG, else ${XDG_CONFIG_HOME:-~/.config}/pulsar-contributor-toolbox/servers.yaml
//
//   bpt:
//     port: 8765
//     bind:            # one listener per address; default 127.0.0.1
//       - 127.0.0.1
//       - 100.101.102.103
//   prd:
//     bind: [127.0.0.1, 100.101.102.103]
//
// Every API call still needs the token, and the Host header must name a bound address (or localhost when a
// loopback address is bound).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = process.env.PCT_SERVERS_CONFIG
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pulsar-contributor-toolbox', 'servers.yaml');

/** A small YAML subset: nested maps, block lists ("- x"), flow lists ("[a, b]"), scalars, comments. */
export function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').replace(/\s+$/, '');
    if (line.trim()) lines.push({ indent: line.match(/^ */)[0].length, text: line.trim() });
  }
  const scalar = (s) => {
    s = s.trim();
    if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1);
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(scalar);
    if (/^-?\d+$/.test(s)) return Number(s);
    if (s === 'true' || s === 'false') return s === 'true';
    if (s === '' || s === '~' || s === 'null') return null;
    return s;
  };
  let i = 0;
  const block = (indent) => {
    if (i >= lines.length || lines[i].indent < indent) return null;
    const ind = lines[i].indent;
    if (lines[i].text.startsWith('- ') || lines[i].text === '-') {
      const out = [];
      while (i < lines.length && lines[i].indent === ind && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
        const rest = lines[i].text.slice(1).trim(); i++;
        out.push(rest ? scalar(rest) : block(ind + 1));
      }
      return out;
    }
    const out = {};
    while (i < lines.length && lines[i].indent === ind) {
      const m = lines[i].text.match(/^([^:]+):(?:\s+(.*))?$/);
      if (!m) throw new Error(`${CONFIG_PATH}: cannot parse "${lines[i].text}"`);
      i++;
      out[m[1].trim()] = m[2] != null && m[2] !== '' ? scalar(m[2]) : block(ind + 1);
    }
    return out;
  };
  return block(0) || {};
}

/** The port and addresses for one server ("bpt" or "prd"); a --port on the command line wins. */
export function listenConfig(name, { port = null, defaultPort } = {}) {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) cfg = parseYaml(fs.readFileSync(CONFIG_PATH, 'utf8'))?.[name] || {};
  const bind = [cfg.bind ?? '127.0.0.1'].flat().map(String).filter(Boolean);
  return { port: Number(port || cfg.port || defaultPort), bind: [...new Set(bind)] };
}

const LOOPBACK = (a) => a === 'localhost' || a === '::1' || a.startsWith('127.');
export const urlHost = (a) => (a.includes(':') ? `[${a}]` : a);
export const urlFor = (addr, port, tok) => `http://${urlHost(addr)}:${port}/#${tok}`;

/** Host header values the server accepts: the bound addresses, and localhost when a loopback address is bound. */
export function allowedHosts(addresses) {
  const set = new Set();
  for (const a of addresses) { set.add(urlHost(a)); set.add(a); if (LOOPBACK(a)) { set.add('localhost'); set.add('127.0.0.1'); } }
  return set;
}
/** The Host header without its port (IPv6 in brackets kept as is). */
export const hostOf = (h) => String(h || '').replace(/:\d+$/, '');

/**
 * Listen on every configured address with the same handler. An address that cannot be bound (an interface that is
 * down) is reported and skipped; the server fails only when none could be bound. Calls ready(boundAddresses).
 */
export function listenAll(makeServer, { port, bind }, ready) {
  const servers = []; const bound = []; let pending = bind.length; const errors = [];
  const done = () => {
    if (--pending > 0) return;
    for (const e of errors) console.error(`cannot listen on ${urlHost(e.addr)}:${port}: ${e.message}`);
    if (!bound.length) { console.error('no address could be bound'); process.exit(1); }
    ready(bind.filter((a) => bound.includes(a)));
  };
  for (const addr of bind) {
    const s = makeServer();
    s.once('error', (e) => { errors.push({ addr, message: e.code || e.message }); done(); });
    s.listen(port, addr, () => { bound.push(addr); servers.push(s); done(); });
  }
  return { close: () => servers.forEach((s) => s.close()) };
}
