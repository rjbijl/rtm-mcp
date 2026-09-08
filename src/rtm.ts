import { createHash } from 'node:crypto';
import type { Credentials } from './config.js';

const REST_ENDPOINT =
  process.env.RTM_REST_ENDPOINT ?? 'https://api.rememberthemilk.com/services/rest/';
export const AUTH_ENDPOINT = 'https://www.rememberthemilk.com/services/auth/';

/** RTM's API-versie. v2 is opt-in gedrag binnen hetzelfde endpoint (start dates,
 *  striktere due-vs-start validatie). Methods die alleen in v2 bestaan geven
 *  zonder deze parameter error 120. */
const API_VERSION = '2';

export class RtmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly method: string
  ) {
    super(`RTM ${method} faalde (${code}): ${message}`);
    this.name = 'RtmError';
  }
}

/**
 * api_sig: md5( shared_secret + alle params alfabetisch op key gesorteerd,
 * key en value direct aan elkaar geplakt zonder scheidingstekens ).
 * api_sig zelf telt uiteraard niet mee.
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
 * RTM's JSON-serializer maakt van één element een object en van meerdere een array.
 * Zonder deze normalisatie breekt elke client op accounts met precies één lijst
 * of precies één taak. Dit is dé klassieke RTM-bug.
 */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Token bucket. RTM staat 1 request/seconde toe met burst tot 3; daarboven
 * worden requests vertraagd en uiteindelijk gedropt met HTTP 503.
 * Een LLM dat vijf tools achter elkaar aanroept loopt daar zonder dit tegenaan.
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

  /** Serialiseert wachters zodat ze in volgorde aan de beurt komen. */
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

export class RtmClient {
  private readonly limiter = new RateLimiter();
  private timeline: string | null = null;
  private listsCache: { at: number; lists: RtmList[] } | null = null;
  private readonly listsCacheTtlMs = 5 * 60 * 1000;
  /** Laatste undoable transacties, nieuwste eerst. Voedt de undo-tool. */
  readonly recentTransactions: Array<{ id: string; description: string }> = [];

  constructor(private readonly creds: Credentials) {}

  /**
   * Ruwe API-call. Voegt api_key, format, v, auth_token en api_sig toe en
   * vertaalt rsp.stat="fail" naar een RtmError.
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
      if (!this.creds.authToken) throw new Error('Geen auth token beschikbaar.');
      payload.auth_token = this.creds.authToken;
    }
    payload.api_sig = signParams(payload, this.creds.sharedSecret);

    const body = new URLSearchParams(payload).toString();

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(REST_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'rtm-mcp/0.1'
          },
          body
        });

        // Rate limit overschreden: RTM geeft 503 zonder JSON-body.
        if (res.status === 503) {
          lastError = new Error('RTM rate limit (HTTP 503)');
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} van RTM bij ${method}`);
        }

        const json = (await res.json()) as { rsp?: Record<string, unknown> };
        const rsp = json.rsp;
        if (!rsp) throw new Error(`Onverwacht antwoord van RTM bij ${method}`);

        if (rsp.stat === 'fail') {
          const err = (rsp.err ?? {}) as { code?: string; msg?: string };
          throw new RtmError(err.code ?? '?', err.msg ?? 'onbekende fout', method);
        }
        return rsp as T;
      } catch (e) {
        if (e instanceof RtmError) throw e; // functionele fout: niet retryen
        lastError = e;
        if (attempt === 3) break;
        await sleep(500 * Math.pow(2, attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Timelines verlopen niet en moeten hergebruikt worden. Eén per proces is
   * genoeg en scheelt een call van je secondebudget bij elke schrijfactie.
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

  /** Zoekt een lijst op naam (case-insensitive). Smart lists komen ook terug. */
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
