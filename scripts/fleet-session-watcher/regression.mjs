import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Exercise the actual watcher function; do not substitute a model of its loop.
const [sourcePath, typescriptPath] = process.argv.slice(2);
if (!sourcePath || !typescriptPath) throw new Error('Usage: node regression.mjs <handlers.ts> <typescript package>');
const ts = createRequire(import.meta.url)(typescriptPath);
const source = readFileSync(sourcePath, 'utf8');
const start = source.indexOf('export function startSessionWatcher');
const end = source.indexOf('// --- Main event dispatcher', start);
assert(start >= 0 && end > start);
const js = ts.transpileModule(source.slice(start, end).replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(listSessions, finish) {
  const runningSessions = new Map();
  const finalized = [];
  let tick;
  const context = vm.createContext({
    runningSessions, tmux: { listSessions },
    setInterval: callback => { tick = callback; return 1; },
    logger: { info() {}, error() {} },
    readCodexState: () => ({ exitCode: 0, completed: true }),
    handleSessionEnd: async (_config, id, outcome) => {
      finalized.push([id, outcome]);
      runningSessions.delete(id);
      await finish?.(id, runningSessions);
    },
  });
  vm.runInContext(js + '\nstartSessionWatcher({});', context);
  return { runningSessions, finalized, tick: () => tick() };
}
const session = target => ({ tmuxTarget: target, sessionDir: target });

// A new scan starts during a predecessor's asynchronous memory harvest.
const h = harness(async () => [], async (id, sessions) => {
  if (id === 'old') sessions.set('new', session('new'));
});
h.runningSessions.set('old', session('old'));
await h.tick();
assert.deepEqual(h.finalized, [['old', 'completed']]);
assert(h.runningSessions.has('new'));

// A launch while listSessions itself is pending is also outside this scan.
let resolveList;
const q = harness(() => new Promise(resolve => { resolveList = resolve; }));
q.runningSessions.set('old', session('old'));
const pending = q.tick();
q.runningSessions.set('new', session('new'));
// Overlapping timer ticks must not run another query or finalize twice.
await q.tick();
resolveList([]);
await pending;
assert.deepEqual(q.finalized, [['old', 'completed']]);
assert(q.runningSessions.has('new'));

// An identity replaced during the query must not be finalized from stale data.
let replace;
const r = harness(() => new Promise(resolve => { replace = resolve; }));
r.runningSessions.set('id', session('old'));
const replacing = r.tick();
r.runningSessions.set('id', session('replacement'));
replace([]);
await replacing;
assert.deepEqual(r.finalized, []);

// Provider errors must release the timer lock; an existing pane stays alive.
let calls = 0;
const e = harness(async () => { if (++calls === 1) throw new Error('tmux unavailable'); return [{ name: 'live' }]; });
e.runningSessions.set('live', session('live'));
await e.tick();
await e.tick();
assert.equal(calls, 2);
assert.deepEqual(e.finalized, []);
console.log('PASS: new launches, pending query, overlapping ticks, replacement identity, query failure, live pane');
