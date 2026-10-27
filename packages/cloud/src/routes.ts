import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ALIAS_PATTERN, TOOL_IDS, type Period, type ToolId } from '@tokentracky/core';
import { bearer, createAccountVerifier, type AccountIdentity, type AccountVerifier, type ManagedAuthConfig } from './auth.ts';
import { CloudError, invalid } from './errors.ts';
import { PostgresCloudRepository, type Liker } from './repository.ts';
import { object } from './validation.ts';
import { badgeOptions, badgeSvg, cardSvg, compactCount, formatUsd } from './badge.ts';
import type { GithubLogin } from './github.ts';

export interface CloudRoutesOptions {
  repository: PostgresCloudRepository;
  /** Trusted injection boundary for a managed-provider adapter or synthetic tests. */
  verifyAccount?: AccountVerifier;
  auth?: ManagedAuthConfig;
  /** Looks up the member's verified GitHub login when they join or approve a computer. Without it, no login is stored. */
  githubLogin?: GithubLogin;
}
function period(value: unknown): Period {
  if (value === undefined) return 'week';
  if (value !== 'week' && value !== 'month' && value !== 'all') invalid('Invalid ranking period');
  return value;
}
declare module 'fastify' {
  interface FastifyContextConfig {cacheSeconds?: number}
}
const notFound = () => new CloudError(404, 'NOT_FOUND', 'Published profile not found');
/** Public, anonymous routes may be cached by browsers and the CDN for this long; everything else is no-store. */
const cached = (seconds: number) => ({config: {cacheSeconds: seconds}});
/** At most one load a minute, shared by every caller; a failed load is retried by the next caller. */
function minuteSnapshot<T>(load: () => Promise<T>): () => Promise<T> {
  let snapshot: {at: number; value: Promise<T>} | null = null;
  return () => {
    if (!snapshot || performance.now() - snapshot.at >= 60_000) {
      const value = load();
      snapshot = {at: performance.now(), value};
      value.catch(() => { if (snapshot?.value === value) snapshot = null; });
    }
    return snapshot.value;
  };
}
function positive(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) invalid('Invalid pagination');
  return Number(value);
}

/** Encapsulated routes; the application owns health, listening, CORS and production logging. */
export async function registerCloudRoutes(app: FastifyInstance, options: CloudRoutesOptions): Promise<void> {
  const repository = options.repository;
  const verify = options.verifyAccount ?? createAccountVerifier(options.auth ?? {});
  const account = async (request: FastifyRequest) => {
    if (!options.verifyAccount && !(options.auth?.issuer && options.auth.audience && options.auth.jwksUrl)) {
      throw new CloudError(503, 'AUTH_NOT_CONFIGURED', 'Managed account authentication is not configured');
    }
    return verify(bearer(request.headers.authorization));
  };
  // A failed lookup never blocks joining or connecting; `undefined` keeps the stored login.
  const githubLogin = async (identity: AccountIdentity): Promise<string | null | undefined> => {
    try { return await options.githubLogin?.(identity.subject); } catch { return undefined; }
  };
  await app.register(async cloud => {
    cloud.setErrorHandler((error, request, reply) => {
      if (error instanceof CloudError) {
        if (error.code === 'COUNTER_OVERFLOW' && ['GET', 'HEAD'].includes(request.method) && /^(?:\/api\/(?:leaderboard|profiles|community)(?:[/?]|$)|\/(?:badge|card)\/)/.test(request.url)) repository.publicCounterFailure();
        return reply.code(error.statusCode).send({error: {code: error.code, message: error.message}});
      }
      const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) return reply.code(status).send({error: {code: 'INVALID_REQUEST', message: 'Invalid request body'}});
      if (status === 429) return reply.code(429).send({error: {code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.'}});
      return reply.code(503).send({error: {code: 'SERVICE_UNAVAILABLE', message: 'Hosted service is temporarily unavailable'}});
    });
    cloud.addHook('onSend', async (request, reply) => {
      const seconds = request.routeOptions.config.cacheSeconds;
      reply.header('Cache-Control', seconds && reply.statusCode < 400 ? `public, max-age=${seconds}` : 'no-store');
    });
    cloud.get('/api/leaderboard', async request => {
      const q = object(request.query, ['period', 'tool', 'q', 'page', 'pageSize', 'sort']);
      const tool = q.tool ?? 'all';
      if (![...TOOL_IDS, 'all'].includes(tool as 'all')) invalid('Invalid tool filter');
      if (q.sort !== undefined && q.sort !== 'tokens' && q.sort !== 'cost') invalid('Invalid sort');
      if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 100)) invalid('Invalid alias search');
      return repository.leaderboard({period: period(q.period), tool: tool as ToolId | 'all', q: (q.q as string | undefined) ?? '', page: positive(q.page, 1, 1000000), pageSize: positive(q.pageSize, 20, 100), sort: q.sort as 'tokens' | 'cost' | undefined});
    });
    cloud.get<{Params: {alias: string}}>('/api/leaderboard/around/:alias', async request => {
      const q = object(request.query, ['period']);
      if (!ALIAS_PATTERN.test(request.params.alias)) throw notFound();
      return repository.around(request.params.alias, period(q.period));
    });
    // One shared snapshot per minute for the landing page, however many visitors load it.
    const community = minuteSnapshot(() => repository.community());
    cloud.get('/api/community', cached(60), async request => {
      object(request.query, []);
      return community();
    });
    const rarity = minuteSnapshot(() => repository.achievementRarity());
    cloud.get('/api/achievements/rarity', cached(3600), async request => {
      object(request.query, []);
      return rarity();
    });
    cloud.get<{Params: {alias: string}}>('/api/profiles/:alias/stats', cached(60), async request => {
      object(request.query, []);
      if (!ALIAS_PATTERN.test(request.params.alias)) throw notFound();
      return repository.profileStats(request.params.alias);
    });
    // Likes: a signed-in account, or a computer's credential for the Mac app. Never cached.
    const like = async (request: FastifyRequest<{Params: {alias: string}}>, liked?: boolean) => {
      const token = bearer(request.headers.authorization);
      const liker: Liker = token.startsWith('ttd_') ? {deviceToken: token} : {identity: await account(request)};
      if (!ALIAS_PATTERN.test(request.params.alias)) throw notFound();
      return repository.like(liker, request.params.alias, liked);
    };
    const likeLimit = {rateLimit: {max: 30, timeWindow: '1 minute'}};
    cloud.get<{Params: {alias: string}}>('/api/profiles/:alias/like', async request => {
      object(request.query, []);
      return {liked: await like(request)};
    });
    cloud.put<{Params: {alias: string}}>('/api/profiles/:alias/like', {config: likeLimit}, async (request, reply) => {
      await like(request, true);
      return reply.code(204).send();
    });
    cloud.delete<{Params: {alias: string}}>('/api/profiles/:alias/like', {config: likeLimit}, async (request, reply) => {
      await like(request, false);
      return reply.code(204).send();
    });
    // README badges: a "private" placeholder (still an image, so embeds never break) unless the alias is published.
    cloud.get<{Params: {file: string}}>('/badge/:file', cached(60), async (request, reply) => {
      const q = object(request.query, ['metric', 'period', 'style', 'label', 'color']);
      const metric = q.metric ?? 'tokens';
      if (metric !== 'tokens' && metric !== 'cost' && metric !== 'rank') invalid('Invalid badge metric');
      const window = period(q.period ?? 'all');
      const options = badgeOptions(q);
      const alias = request.params.file.endsWith('.svg') ? request.params.file.slice(0, -4) : '';
      if (!ALIAS_PATTERN.test(alias)) throw notFound();
      let value = 'private';
      try {
        const profile = await repository.profile(alias, window);
        const label = window === 'all' ? '' : ` this ${window}`;
        value = metric === 'rank' ? `#${profile.rank}${label}`
          : metric === 'cost' ? (typeof profile.costMicrousd === 'number' ? `${formatUsd(profile.costMicrousd)}${label}` : 'private')
          : `${compactCount(profile.tokens)} tokens${label}`;
      } catch (error) { if (!(error instanceof CloudError && error.statusCode === 404)) throw error; }
      return reply.type('image/svg+xml; charset=utf-8').send(badgeSvg(value, options));
    });
    // README cards: the same placeholder rule as badges.
    cloud.get<{Params: {file: string}}>('/card/:file', cached(60), async (request, reply) => {
      const q = object(request.query, ['theme', 'period']);
      const theme = q.theme ?? 'dark';
      if (theme !== 'dark' && theme !== 'light') invalid('Card theme must be dark or light');
      const window = period(q.period ?? 'all');
      const alias = request.params.file.endsWith('.svg') ? request.params.file.slice(0, -4) : '';
      if (!ALIAS_PATTERN.test(alias)) throw notFound();
      let data = null;
      try { data = await repository.profile(alias, window); } catch (error) { if (!(error instanceof CloudError && error.statusCode === 404)) throw error; }
      return reply.type('image/svg+xml; charset=utf-8').send(cardSvg(data && {alias: data.alias, rank: data.rank, tokens: data.tokens, costMicrousd: data.costMicrousd, tools: data.toolTokens}, theme, window));
    });
    cloud.get<{Params: {alias: string}}>('/api/profiles/:alias', async request => {
      const q = object(request.query, ['period']);
      if (!ALIAS_PATTERN.test(request.params.alias)) throw notFound();
      return repository.profile(request.params.alias, period(q.period));
    });
    cloud.get('/api/account', async request => repository.account(await account(request)));
    cloud.delete('/api/account', async (request, reply) => {
      await repository.deleteAccount(await account(request));
      return reply.code(204).send();
    });
    cloud.get('/api/device-policy', async request => ({publication: await repository.devicePublication(bearer(request.headers.authorization))}));
    cloud.put('/api/publication', {bodyLimit: 4096}, async request => {
      const identity = await account(request);
      return {publication: await repository.putPublication(identity, request.body, await githubLogin(identity))};
    });
    cloud.post('/api/devices', {bodyLimit: 4096}, async request => {
      const identity = await account(request);
      const body = object(request.body, ['name']);
      if (typeof body.name !== 'string') invalid('Device name is required');
      return repository.createDevice(identity, body.name);
    });
    cloud.put<{Params: {id: string}}>('/api/devices/:id', {bodyLimit: 4096}, async (request, reply) => {
      const identity = await account(request);
      await repository.renameDevice(identity, request.params.id, object(request.body, ['name']).name);
      return reply.code(204).send();
    });
    cloud.delete<{Params: {id: string}}>('/api/devices/:id', async (request, reply) => {
      await repository.revokeDevice(await account(request), request.params.id);
      return reply.code(204).send();
    });
    cloud.post('/api/ingest', {bodyLimit: 2 * 1024 * 1024}, async request => repository.ingest(bearer(request.headers.authorization), request.body));
    // Browser approval for collectors: start (anonymous) → approve (signed in) → poll (poll secret).
    const startLimit = {rateLimit: {max: 10, timeWindow: '1 minute'}};
    cloud.post('/api/visits', {bodyLimit: 256, config: {rateLimit: {max: 30, timeWindow: '1 minute'}}}, async (request, reply) => {
      await repository.countVisit(object(request.body, ['tag']).tag);
      return reply.code(204).send();
    });
    cloud.post('/api/device-auth', {bodyLimit: 4096, config: startLimit}, async request => repository.startDeviceAuthorization(request.body));
    cloud.post('/api/device-auth/poll', async request => repository.pollDeviceAuthorization(bearer(request.headers.authorization)));
    cloud.get<{Params: {code: string}}>('/api/device-auth/:code', async request => repository.deviceAuthorization(await account(request), request.params.code));
    cloud.post<{Params: {code: string}}>('/api/device-auth/:code/approve', async (request, reply) => {
      const identity = await account(request);
      await repository.approveDeviceAuthorization(identity, request.params.code, await githubLogin(identity));
      return reply.code(204).send();
    });
  });
}
