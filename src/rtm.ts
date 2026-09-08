import { createHash } from 'node:crypto';
import type { Credentials } from './config.js';

const DEFAULT_REST_ENDPOINT = 'https://api.rememberthemilk.com/services/rest/';
export const AUTH_ENDPOINT = 'https://www.rememberthemilk.com/services/auth/';

/**
 * The REST endpoint can only be overridden with explicit consent.
 * Every request carries api_key and auth_token; a silent override through a
 * single env var would ship those to a foreign host without any code change.
 * Meant for the tests against the mock RTM, not for production.
 */
export function resolveRestEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => process.stderr.write(`[rtm-mcp] ${msg}\n`)
): string {
  const override = env.RTM_REST_ENDPOINT?.trim();
  if (!override) return DEFAULT_REST_ENDPOINT;
  if (env.RTM_ALLOW_ENDPOINT_OVERRIDE !== '1') {
    throw new Error(
      `RTM_REST_ENDPOINT is set to ${override}, but RTM_ALLOW_ENDPOINT_OVERRIDE=1 is missing. ` +
        'Without that flag api_key and auth_token go nowhere but RTM.'
    );
  }
  warn(`warning: RTM endpoint overridden to ${override}`);
  return override;
}

/** One warning per process is enough, even when several clients are created. */
let warnedAboutOverride = false;
function warnOnce(msg: string): void {
  if (warnedAboutOverride) return;
  warnedAboutOverride = true;
  process.stderr.write(`[rtm-mcp] ${msg}\n`);
}

/** RTM's API version. v2 is opt-in behaviour on the same endpoint (start dates,
 *  stricter due-vs-start validation). Methods that only exist in v2 return
 *  error 120 without this parameter. */
const API_VERSION = '2';

export class RtmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly method: string
  ) {
    super(`RTM ${method} failed (${code}): ${message}`);
    this.name = 'RtmError';
  }
}

/**
 * api_sig: md5( shared_secret + all params sorted alphabetically by key,
 * key and value concatenated directly without separators ).
 * api_sig itself is of course excluded.
 */
export function signParams(params: Record<string, string>, sharedSecret: string): string {
  const concatenated = Object.keys(params)
    .filter((k) => k !== 'api_sig')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHash('md5')
    .update(Buffer.from(sharedSecret + concatenated, 'utf8'))
    .digest('hex');
}

/**
 * RTM's JSON serializer turns a single element into an object and multiple
 * elements into an array. Without this normalization every client breaks on
 * accounts with exactly one list or exactly one task. This is THE classic RTM bug.
 */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Token bucket. RTM allows 1 request/second with bursts up to 3; beyond that
 * requests get throttled and eventually dropped with HTTP 503.
 * An LLM calling five tools in a row runs straight into that without this.
 */
class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity = 3,
    private readonly refillPerSecond = 1
  ) {
    this.tokens = capacity;
  }

  /** Serializes waiters so they get their turn in order. */
  acquire(): Promise<void> {
    const wait = this.queue.then(() => this.take());
    this.queue = wait.catch(() => undefined);
    return wait;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await sleep(Math.ceil((deficit / this.refillPerSecond) * 1000));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RtmList {
  id: string;
  name: string;
  deleted: string;
  locked: string;
  archived: string;
  position: string;
  smart: string;
  filter?: string;
}

export interface RtmTaskInstance {
  id: string;
  due: string;
  has_due_time: string;
  added: string;
  completed: string;
  deleted: string;
  priority: string;
  postponed: string;
  estimate: string;
  start?: string;
}

export interface RtmTaskSeries {
  id: string;
  created: string;
  modified: string;
  name: string;
  source: string;
  url: string;
  location_id: string;
  tags?: { tag?: string | string[] } | string[];
  notes?: { note?: unknown };
  participants?: unknown;
  rrule?: { every: string; $t: string };
  task: RtmTaskInstance | RtmTaskInstance[];
}

export interface RtmTransaction {
  id: string;
  undoable?: string;
}

export interface RtmClientOptions {
  /** How long a single HTTP request may take before it is aborted. */
  requestTimeoutMs?: number;
}

export class RtmClient {
  private readonly limiter = new RateLimiter();
  private timeline: string | null = null;
  private listsCache: { at: number; lists: RtmList[] } | null = null;
  private readonly listsCacheTtlMs = 5 * 60 * 1000;
  /** Most recent undoable transactions, newest first. Feeds the undo tool. */
  readonly recentTransactions: Array<{ id: string; description: string }> = [];

  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly creds: Credentials,
    opts: RtmClientOptions = {}
  ) {
    this.endpoint = resolveRestEndpoint(process.env, warnOnce);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  }

  /**
   * Raw API call. Adds api_key, format, v, auth_token and api_sig, and
   * translates rsp.stat="fail" into an RtmError.
   */
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, string | undefined> = {},
    opts: { authenticated?: boolean } = {}
  ): Promise<T> {
    const authenticated = opts.authenticated ?? true;

    const payload: Record<string, string> = {
      method,
      api_key: this.creds.apiKey,
      format: 'json',
      v: API_VERSION
    };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') payload[k] = v;
    }
    if (authenticated) {
      if (!this.creds.authToken) throw new Error('No auth token available.');
      payload.auth_token = this.creds.authToken;
    }
    payload.api_sig = signParams(payload, this.creds.sharedSecret);

    const body = new URLSearchParams(payload).toString();

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'rtm-mcp/0.1'
          },
          body,
          // Without a timeout a stalled connection blocks the tool call forever.
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });

        // Rate limit exceeded: RTM returns 503 without a JSON body.
        if (res.status === 503) {
          lastError = new Error('RTM rate limit (HTTP 503)');
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from RTM for ${method}`);
        }

        const json = (await res.json()) as { rsp?: Record<string, unknown> };
        const rsp = json.rsp;
        if (!rsp) throw new Error(`Unexpected response from RTM for ${method}`);

        if (rsp.stat === 'fail') {
          const err = (rsp.err ?? {}) as { code?: string; msg?: string };
          throw new RtmError(err.code ?? '?', err.msg ?? 'unknown error', method);
        }
        return rsp as T;
      } catch (e) {
        if (e instanceof RtmError) throw e; // functional error: don't retry
        lastError =
          e instanceof Error && e.name === 'TimeoutError'
            ? new Error(`RTM did not respond within ${this.requestTimeoutMs}ms for ${method}`)
            : e;
        if (attempt === 3) break;
        await sleep(500 * Math.pow(2, attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Timelines never expire and should be reused. One per process is enough
   * and saves a call from your per-second budget on every write.
   */
  async getTimeline(): Promise<string> {
    if (this.timeline) return this.timeline;
    const rsp = await this.call<{ timeline: string }>('rtm.timelines.create');
    this.timeline = rsp.timeline;
    return this.timeline;
  }

  async getLists(force = false): Promise<RtmList[]> {
    const now = Date.now();
    if (!force && this.listsCache && now - this.listsCache.at < this.listsCacheTtlMs) {
      return this.listsCache.lists;
    }
    const rsp = await this.call<{ lists: { list?: RtmList | RtmList[] } }>('rtm.lists.getList');
    const lists = asArray(rsp.lists?.list);
    this.listsCache = { at: now, lists };
    return lists;
  }

  /** Finds a list by name (case-insensitive). Smart lists are included. */
  async findList(name: string): Promise<RtmList | undefined> {
    const needle = name.trim().toLowerCase();
    const lists = await this.getLists();
    return lists.find((l) => l.name.toLowerCase() === needle);
  }

  recordTransaction(tx: RtmTransaction | undefined, description: string): void {
    if (!tx?.id || tx.undoable !== '1') return;
    this.recentTransactions.unshift({ id: tx.id, description });
    this.recentTransactions.length = Math.min(this.recentTransactions.length, 10);
  }
}
