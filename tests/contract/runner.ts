import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll} from 'vitest';

/** Parsed JSON is deliberately loose (`any`): the tests assert exact shapes with `toEqual`. */
export type Json = ReturnType<typeof JSON.parse>;
export interface Reply {status: number; headers: Record<string, string>; cookies: string[]; text: string; json(): Json}
/** `headers` overrides the defaults (cookie, origin, host); a `null` value removes that header. `json` sets the body and its content type. */
export interface Init {method?: string; headers?: Record<string, string | null>; json?: unknown; body?: string}
export interface Server {
  baseUrl: string;
  /** The one-use launch link, as printed by the server. Unused when the server was started with `login: false`. */
  launchUrl: string;
  /** `name=value` of the session cookie, or null before login. */
  cookie: string | null;
  /** True when the runner started the process and so controls HOME, the web root and the hosted-service URL. */
  owned: boolean;
  /** The server's HOME (owned servers only); tool log folders are created below it. */
  home: string | null;
  /** The directory the server serves `index.html` and `assets/contract.js` from (owned servers only). */
  webRoot: string | null;
  /** A scratch directory on the server's machine that the tests may write to. */
  dir: string;
  request(path: string, init?: Init): Promise<Reply>;
}
export interface StartOptions {
  /** Exchange the launch link for the session cookie (default). Pass false to test the exchange itself. */
  login?: boolean;
  /** Point an owned server at a hosted service (TOKENTRACKY_CLOUD_URL). */
  cloudUrl?: string;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const launchLink = /https?:\/\/\S+?\/\?launch=[\w-]+/;
/** Environment the server under test must not inherit: tool folder overrides and any TOKENTRACKY_ setting. */
const scrubbed = /^(?:TOKENTRACKY_.*|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|CLINE_DIR|CLINE_DATA_DIR|XDG_DATA_HOME|OPENCODE_DB|KILO_DB)$/;
const live = new Set<() => Promise<void>>();
/** True when the tests target a server that is already running; the runner then cannot choose its HOME, web root or hosted service. */
export const external = Boolean(process.env.CONTRACT_BASE_URL || process.env.CONTRACT_LAUNCH_URL);
afterAll(async () => {await Promise.all([...live].map(stop => stop()));});

function send(origin: string, path: string, method: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({hostname: url.hostname, port: url.port, path, method, headers: {...headers, ...(body === undefined ? {} : {'content-length': String(Buffer.byteLength(body))})}, agent: false}, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const {'set-cookie': cookies = [], ...rest} = incoming.headers;
        resolve({status: incoming.statusCode!, cookies, text, json: () => JSON.parse(text),
          headers: Object.fromEntries(Object.entries(rest).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]))});
      });
    });
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${method} ${path} timed out`)));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const groupAlive = (pid: number) => {try {process.kill(-pid, 0); return true;} catch {return false;}};
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {try {process.kill(-child.pid!, signal);} catch {/* Already gone. */}};

/** Spawns the server under test in its own process group so wrappers are stopped with it. */
function launch(command: string | null, env: NodeJS.ProcessEnv): Promise<{child: ChildProcess; launchUrl: string}> {
  const options = {cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe']};
  const executable = join(process.env.CARGO_TARGET_DIR ?? join(root, 'target'), 'debug', `contract-server${process.platform === 'win32' ? '.exe' : ''}`);
  const child = command ? spawn(command, {...options, shell: true}) : spawn(executable, [], options);
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {signalGroup(child, 'SIGKILL'); reject(new Error(`${error.message}\n--- server output ---\n${output.slice(-2000)}`));}
    };
    const timer = setTimeout(() => settle(new Error('The server did not print a launch link within 25 seconds.')), 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
      const link = launchLink.exec(output)?.[0];
      if (link && !settled) {settle(); resolve({child, launchUrl: link});}
    });
    child.stderr.on('data', (chunk: Buffer) => {output += chunk;});
    child.once('error', settle);
    child.once('exit', code => settle(new Error(`The server exited with code ${code} before printing a launch link.`)));
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid!;
  signalGroup(child, 'SIGTERM');
  for (let waited = 0; groupAlive(pid) && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  signalGroup(child, 'SIGKILL');
}

/**
 * The server under test, in the first of these ways that applies:
 * - CONTRACT_BASE_URL and/or CONTRACT_LAUNCH_URL: an already running server (the launch link is one-use, so one file per link);
 * - CONTRACT_SERVER_CMD: a command spawned per test file whose stdout prints the launch link;
 * - the Rust contract-server binary built by `npm test`, spawned per test file.
 */
export async function startServer(options: StartOptions = {}): Promise<Server> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tokentracky-contract-')));
  const cleanups: Array<() => Promise<unknown>> = [() => rm(dir, {recursive: true, force: true})];
  const stop = async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});};
  live.add(stop);
  try {
    let launchUrl: string;
    let home: string | null = null;
    let webRoot: string | null = null;
    if (external) {
      if (options.cloudUrl) throw new Error('A hosted service can only be configured on a server the runner starts (unset CONTRACT_BASE_URL and CONTRACT_LAUNCH_URL).');
      if (!process.env.CONTRACT_LAUNCH_URL) throw new Error('CONTRACT_BASE_URL needs CONTRACT_LAUNCH_URL, a one-use launch link, to obtain the session cookie.');
      launchUrl = process.env.CONTRACT_LAUNCH_URL;
    } else {
      home = join(dir, 'home');
      webRoot = join(dir, 'web');
      await mkdir(join(webRoot, 'assets'), {recursive: true});
      await mkdir(home);
      await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><body>contract workspace</body></html>');
      await writeFile(join(webRoot, 'assets', 'contract.js'), '/* contract asset */');
      const inherited = Object.entries(process.env).filter(([name]) => !scrubbed.test(name));
      const env: NodeJS.ProcessEnv = {...Object.fromEntries(inherited), HOME: home, TOKENTRACKY_MODE: 'local', PORT: '0', TOKENTRACKY_DATABASE_PATH: join(dir, 'data', 'usage.sqlite'), TOKENTRACKY_PRICING_REFRESH: 'off', TOKENTRACKY_WEB_ROOT: webRoot,
        // An explicit hourly cycle keeps a background cycle from landing inside a test.
        TOKENTRACKY_REFRESH_INTERVAL_MS: '3600000', ...(options.cloudUrl ? {TOKENTRACKY_CLOUD_URL: options.cloudUrl} : {})};
      const started = await launch(process.env.CONTRACT_SERVER_CMD ?? null, env);
      cleanups.push(() => stopProcess(started.child));
      launchUrl = started.launchUrl;
    }
    const baseUrl = process.env.CONTRACT_BASE_URL?.replace(/\/+$/, '') || new URL(launchUrl).origin;
    const host = new URL(baseUrl).host;
    const server: Server = {baseUrl, launchUrl, cookie: null, owned: !external, home, webRoot, dir,
      request(path, init = {}) {
        const headers: Record<string, string | null> = {host, origin: baseUrl, ...(server.cookie ? {cookie: server.cookie} : {}), ...(init.json === undefined ? {} : {'content-type': 'application/json'}), ...init.headers};
        return send(baseUrl, path, init.method ?? 'GET', Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null)), init.json === undefined ? init.body : JSON.stringify(init.json));
      },
    };
    if (options.login ?? true) {
      const link = new URL(launchUrl);
      const reply = await server.request(link.pathname + link.search, {headers: {origin: null}});
      if (reply.status !== 200 || !reply.cookies[0]) throw new Error(`The launch link was rejected with status ${reply.status}. It is one-use: run one test file per link, or use CONTRACT_SERVER_CMD.`);
      server.cookie = reply.cookies[0].split(';')[0]!;
    }
    return server;
  } catch (error) {await stop(); throw error;}
}
