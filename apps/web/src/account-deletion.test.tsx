import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { ApiError } from './api';

const { hooks, root, api, auth } = vi.hoisted(() => ({
  hooks: { useState: vi.fn(), useEffect: vi.fn(), useMemo: vi.fn(), useRef: vi.fn() },
  root: { render: vi.fn() },
  api: { health: vi.fn(), account: vi.fn(), deleteAccount: vi.fn(), profile: vi.fn() },
  auth: { configure: vi.fn(), state: vi.fn(), subscribe: vi.fn(), signOut: vi.fn(), identities: vi.fn() },
}));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('react-dom/client', () => ({ createRoot: () => root }));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), ApiClient: class { constructor() { return api; } } }));
vi.mock('./auth', () => ({ AuthAdapter: class { constructor() { return auth; } } }));

type Element = ReactElement<Record<string, unknown>>;
type Component = (props: Record<string, unknown>) => ReactNode;
const account = { publication: null, devices: [] };
const health = { mode: 'hosted', authConfigured: true, version: 'test', cloudUrl: null };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let appElement: Element;

// Exercise actual component callbacks without a DOM/browser or additional dependencies.
function mount(element: Element) {
  const slots: Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }> = [];
  return {
    render(props = element.props) {
      let index = 0;
      const effects: Array<() => void> = [];
      const slot = () => slots[index++] ?? (slots[index - 1] = {});
      const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
      hooks.useState.mockImplementation((initial: unknown) => {
        const state = slot();
        if (!('value' in state)) state.value = typeof initial === 'function' ? initial() : initial;
        return [state.value, (next: unknown) => { state.value = typeof next === 'function' ? next(state.value) : next; }];
      });
      hooks.useRef.mockImplementation((initial: unknown) => { const state = slot(); return state.value ??= { current: initial }; });
      hooks.useMemo.mockImplementation((create: () => unknown, deps: readonly unknown[]) => {
        const state = slot();
        if (changed(state.deps, deps)) { state.value = create(); state.deps = deps; }
        return state.value;
      });
      hooks.useEffect.mockImplementation((effect: () => (() => void) | void, deps?: readonly unknown[]) => {
        const state = slot();
        if (changed(state.deps, deps)) effects.push(() => { state.cleanup?.(); state.cleanup = effect() || undefined; state.deps = deps; });
      });
      const tree = (element.type as Component)(props);
      effects.forEach((effect) => effect());
      return tree;
    },
  };
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : '';
}
function find(tree: ReactNode, name: string): Element {
  const element = elements(tree).find((node) => text(node.props.children as ReactNode) === name && typeof node.props.onClick === 'function');
  if (!element) throw new Error(`Missing action: ${name}`);
  return element;
}
function click(tree: ReactNode, name: string) { (find(tree, name).props.onClick as () => void)(); }
function component(tree: ReactNode, name: string): Element {
  const element = elements(tree).find((node) => typeof node.type === 'function' && node.type.name === name);
  if (!element) throw new Error(`Missing ${name}`);
  return element;
}
function privacy(tree: ReactNode): Element {
  const element = elements(tree).find((node) => typeof node.type === 'function' && node.type.name === 'HostedAccount');
  if (!element) throw new Error('Missing hosted account view');
  return element;
}

beforeAll(async () => {
  vi.stubGlobal('document', { getElementById: () => ({}) });
  vi.stubGlobal('window', { location: { pathname: '/' } });
  await import('./main');
  appElement = root.render.mock.calls[0][0];
});
beforeEach(() => {
  vi.clearAllMocks();
  api.health.mockResolvedValue(health);
  api.account.mockResolvedValue(account);
  api.deleteAccount.mockResolvedValue(undefined);
  auth.state.mockResolvedValue('signed_in');
  auth.signOut.mockResolvedValue(undefined);
  auth.subscribe.mockReturnValue(() => {});
  auth.identities.mockResolvedValue([]);
  vi.stubGlobal('window', { confirm: vi.fn(() => true), location: { href: 'https://hosted.example/', pathname: '/', origin: 'https://hosted.example' }, history: { replaceState: vi.fn(), pushState: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn(), scrollTo: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const app = mount(appElement);
  app.render(); await settle();
  app.render(); await settle();
  let tree = app.render();
  (component(tree, 'SiteNav').props.onYou as () => void)();
  tree = app.render();
  const props = privacy(tree).props;
  const view = mount(privacy(tree));
  view.render();
  return { app, view, props, tree: view.render() };
}

describe('hosted account-data deletion', () => {
  it('discloses the limits and requires destructive confirmation before the request', async () => {
    const { tree, view, props } = await setup();
    vi.mocked(window.confirm).mockReturnValue(false);
    click(tree, 'Delete Tokentracky data'); await settle();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Your authentication provider identity may remain until separately deleted; backups follow operator retention and copies others saved may remain. This cannot be undone.'));
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(text(view.render({ ...props, authState: 'signed_out', account: null }))).not.toContain('Delete Tokentracky data');
  });

  it('clears the account before sign-out finishes and ignores a stale account read', async () => {
    const { app, view, props } = await setup();
    let finishSignOut!: () => void;
    auth.signOut.mockReturnValue(new Promise<void>((resolve) => { finishSignOut = resolve; }));
    let finishAccountRead!: (value: unknown) => void;
    api.account.mockReturnValue(new Promise((resolve) => { finishAccountRead = resolve; }));
    const pendingRead = (props.refreshAccount as () => Promise<void>)();
    click(view.render(), 'Delete Tokentracky data'); await settle();
    expect(api.deleteAccount).toHaveBeenCalledOnce();
    expect(auth.signOut).toHaveBeenCalledOnce();
    const next = app.render();
    expect(privacy(next).props.account).toBeNull();
    expect(text(view.render(privacy(next).props))).not.toContain('Delete Tokentracky data');
    expect(text(next)).toContain('Your Tokentracky application data was deleted.');
    finishAccountRead(account); await pendingRead;
    expect(privacy(app.render()).props.account).toBeNull();
    finishSignOut(); await settle();
    expect(privacy(app.render()).props.authState).toBe('signed_out');
  });

  it('preserves account data and reports a failed deletion without signing out', async () => {
    const { app, view, tree } = await setup();
    api.deleteAccount.mockRejectedValue(new Error('Service unavailable'));
    click(tree, 'Delete Tokentracky data'); await settle();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(text(view.render())).toContain('Service unavailable');
    expect(privacy(app.render()).props.account).toEqual(account);
  });

  it('reports completed deletion separately from failed sign-out and blocks automatic account recreation', async () => {
    const { app, view, tree } = await setup();
    auth.signOut.mockRejectedValue(new Error('Offline'));
    click(tree, 'Delete Tokentracky data'); await settle();
    const next = app.render();
    const cleared = view.render(privacy(next).props);
    expect(text(cleared)).toContain('Tokentracky data was deleted, but sign-out failed: Offline Use Sign out to retry.');
    const reads = api.account.mock.calls.length;
    auth.subscribe.mock.calls[0][0]('signed_in');
    app.render(); await settle();
    expect(api.account).toHaveBeenCalledTimes(reads);
    expect(privacy(app.render()).props.account).toBeNull();
    auth.signOut.mockResolvedValue(undefined);
    auth.state.mockResolvedValue('signed_out');
    click(cleared, 'Sign out'); await settle();
    expect(privacy(app.render()).props.authState).toBe('signed_out');
  });
});

describe('password recovery takes precedence over account and approval views', () => {
  it('does not load or create a hosted account while a recovery session is active', async () => {
    auth.state.mockResolvedValue('recovery');
    const app = mount(appElement);
    app.render(); await settle();
    const tree = app.render(); await settle();
    expect(api.account).not.toHaveBeenCalled();
    expect(elements(tree).some(node => typeof node.type === 'function' && node.type.name === 'PasswordRecovery')).toBe(true);
    expect(elements(tree).some(node => typeof node.type === 'function' && ['HostedAccount', 'Connect'].includes(node.type.name))).toBe(false);
  });
});

describe('hosted account loading', () => {
  it('reads the account once on load, however often Supabase repeats the session', async () => {
    window.location.pathname = '/you';
    const app = mount(appElement);
    app.render(); await settle();
    mount(privacy(app.render())).render(); await settle();
    // INITIAL_SESSION, then SIGNED_IN from session recovery (also sent whenever the tab is shown again).
    const listener = auth.subscribe.mock.calls[0][0];
    listener('signed_in', 'user-1'); listener('signed_in', 'user-1');
    app.render(); await settle();
    expect(api.account).toHaveBeenCalledOnce();
    listener('signed_in', 'user-2');
    app.render(); await settle();
    expect(api.account).toHaveBeenCalledTimes(2);
  });

  it('offers Finish joining only after the account loads without a name', async () => {
    const canJoin = async () => {
      const app = mount(appElement);
      app.render(); await settle();
      app.render(); await settle();
      return component(app.render(), 'SiteNav').props.canJoin;
    };
    api.account.mockReturnValue(new Promise(() => {}));
    expect(await canJoin()).toBe(false);
    api.account.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again shortly.'));
    expect(await canJoin()).toBe(false);
    api.account.mockResolvedValue(account);
    expect(await canJoin()).toBe(true);
    auth.state.mockResolvedValue('signed_out');
    expect(await canJoin()).toBe(true);
  });

  it('shows a failed retry once, in the account notice', async () => {
    const limited = new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again shortly.');
    api.account.mockRejectedValue(limited);
    window.location.pathname = '/you';
    const app = mount(appElement);
    app.render(); await settle();
    app.render(); await settle();
    const view = mount(privacy(app.render()));
    expect(text(view.render()).split(limited.message)).toHaveLength(2);
    click(view.render(), 'Retry'); await settle();
    expect(api.account).toHaveBeenCalledTimes(2);
    expect(text(view.render(privacy(app.render()).props)).split(limited.message)).toHaveLength(2);
  });
});
