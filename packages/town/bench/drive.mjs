/* global process, console, fetch, WebSocket, setTimeout, URL, Buffer */
// Measures the town screens in headless Chrome: idle, spinning the town and panning the map.
//
//   node packages/town/bench/drive.mjs [--throttle 4] [--shots <dir>]
//
// It builds packages/town/bench (the real screens against a fake API) into .cache/town-bench, serves it and drives
// Chrome over the DevTools protocol. "busy" is the renderer's main thread; "gpu" is compositor, raster and GPU threads.
// CHROME overrides the browser path.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const throttle = Number(option('--throttle') ?? 1);
const shots = option('--shots');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4789, DEBUG = 9333, BASE = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(done => setTimeout(done, ms));

const built = spawnSync('npx', ['vite', 'build', '--config', 'packages/town/bench/vite.config.ts', '--logLevel', 'error'], {stdio: 'inherit'});
if (built.status !== 0) process.exit(built.status ?? 1);
const server = spawn('npx', ['vite', 'preview', '--config', 'packages/town/bench/vite.config.ts', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {stdio: 'ignore'});
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${new URL('../../../.cache/town-bench-profile', import.meta.url).pathname}`,
  '--no-first-run', '--window-size=1440,900', 'about:blank'], {stdio: 'ignore'});
const stop = code => { chrome.kill(); server.kill(); process.exit(code); };
for (let i = 0; ; i++) {
  try { await fetch(`http://127.0.0.1:${DEBUG}/json/version`); await fetch(BASE); break; } catch { if (i > 60) stop(1); await sleep(250); }
}

const target = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?about:blank`, {method: 'PUT'})).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(done => ws.addEventListener('open', done));
let id = 0;
const pending = new Map(), listeners = new Set();
ws.addEventListener('message', event => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else for (const f of listeners) f(m);
});
const send = (method, params = {}) => new Promise(done => { const i = ++id; pending.set(i, done); ws.send(JSON.stringify({id: i, method, params})); })
  .then(m => { if (m.error) throw new Error(`${method}: ${m.error.message}`); return m.result; });
const evaluate = async expression => (await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})).result.value;
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});
if (throttle > 1) await send('Emulation.setCPUThrottlingRate', {rate: throttle});

async function trace(run) {
  const events = [];
  const collect = m => { if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); };
  listeners.add(collect);
  await send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'cc', 'gpu', 'viz']}});
  const started = Date.now();
  await run();
  const wall = Date.now() - started;
  const complete = new Promise(done => listeners.add(m => { if (m.method === 'Tracing.tracingComplete') done(); }));
  await send('Tracing.end');
  await complete;
  listeners.delete(collect);
  const names = new Map(events.filter(e => e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
  const thread = e => names.get(`${e.pid}:${e.tid}`) ?? '';
  const sum = keep => events.filter(e => e.ph === 'X' && keep(e)).reduce((total, e) => total + (e.dur ?? 0), 0) / 1000;
  // Top-level tasks only, so nested events aren't counted twice.
  const task = e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask';
  return {
    wall,
    busy: sum(e => thread(e) === 'CrRendererMain' && e.name === 'RunTask'),
    longest: Math.max(0, ...events.filter(e => thread(e) === 'CrRendererMain' && e.name === 'RunTask').map(e => (e.dur ?? 0) / 1000)),
    gpu: sum(e => /Compositor|CrGpuMain|VizCompositor|Raster/i.test(thread(e)) && task(e)),
    paints: events.filter(e => thread(e) === 'CrRendererMain' && e.name === 'Paint').length,
  };
}
const frames = () => evaluate(`window.__frames = []; window.__stopFrames = false; (function f(now) { window.__frames.push(now); if (!window.__stopFrames) requestAnimationFrame(f); })(performance.now()); 1`);
const frameReport = async () => {
  const t = await evaluate('window.__stopFrames = true; window.__frames');
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  return `${gaps.filter(g => g > 25).length} of ${gaps.length} frames over 25 ms, worst ${Math.round(Math.max(0, ...gaps))} ms`;
};
const row = (label, t, moves, extra = '') => console.log(`${label.padEnd(34)} busy ${String(Math.round(t.busy)).padStart(5)} ms of ${t.wall}`
  + ` · gpu ${String(Math.round(t.gpu)).padStart(5)} ms${moves ? ` · ${(t.busy / moves).toFixed(1)} ms/move` : ''} · ${t.paints} paints${extra ? ` · ${extra}` : ''}`);
const open = async query => { await send('Page.navigate', {url: `${BASE}?${query}`}); await sleep(2500 + 500 * throttle); };
const shot = async name => {
  if (!shots) return;
  mkdirSync(shots, {recursive: true});
  writeFileSync(`${shots}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
};
const drag = async (x, y, moves, step) => {
  await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1});
  for (let i = 1; i <= moves; i++) { await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: x + i * step, y, button: 'left', buttons: 1}); await sleep(8); }
  await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: x + moves * step, y, button: 'left', buttons: 0, clickCount: 1});
};
const MOVES = 90;

console.log(`36-plot town with a harvest waiting · 1440×900 at 2× · CPU ${throttle}× slower\n`);
const loaded = await trace(async () => { await send('Page.navigate', {url: `${BASE}?side=6`}); await sleep(2500 + 500 * throttle); });
row('town, first load', loaded, 0, `longest task ${Math.round(loaded.longest)} ms`);
await open('side=6');
await shot('town');
row('town, idle 3 s', await trace(() => sleep(3000)), 0);
await frames();
row('town, drag to spin', await trace(() => drag(500, 520, MOVES, 4)), MOVES, await frameReport());
await open('side=6&select=20');
await shot('town-popover');
await frames();
row('town, spin with a popover open', await trace(() => drag(500, 520, MOVES, 4)), MOVES, await frameReport());
await open('page=map&side=6&zoom=out');
await shot('map-zoomed-out');
row('map zoomed out, idle 3 s', await trace(() => sleep(3000)), 0);
await frames();
row('map zoomed out, drag to pan', await trace(() => drag(400, 450, MOVES, 6)), MOVES, await frameReport());
await open('page=map&side=6');
await shot('map');
await frames();
row('map, drag to pan', await trace(() => drag(400, 450, MOVES, 6)), MOVES, await frameReport());
ws.close();
stop(0);
