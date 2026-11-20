import { describe, it, expect, vi } from 'vitest';
import { PolarLicenseClient, unrefSleep, type FetchLike } from '@editmamei/license/polar-client.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';

const cfg: PolarConfig = {
  env: 'sandbox',
  baseUrl: 'https://api.test/v1',
  organizationId: 'org_x',
};

const KEY = 'EDIT-77777777-7777-4777-8777-777777777777';

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fake(status: number, body: unknown): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const VALIDATED = {
  id: 'lk',
  status: 'granted',
  limit_activations: 2,
  usage: 0,
  validations: 1,
  expires_at: null,
  last_validated_at: null,
  display_key: '****-X',
};

describe('PolarLicenseClient key format gate', () => {
  const production: PolarConfig = { ...cfg, env: 'production' };

  it.each([
    ['validate', (c: PolarLicenseClient, k: string) => c.validate(k)],
    ['activate', (c: PolarLicenseClient, k: string) => c.activate(k, 'devhash')],
    ['deactivate', (c: PolarLicenseClient, k: string) => c.deactivate(k, 'act_1')],
  ])('%s refuses a malformed key without a request', async (_name, call) => {
    for (const bad of ['${user_config.license_key}', 'K', '', `${KEY} x`]) {
      const { fetchImpl, calls } = fake(200, VALIDATED);
      await expect(call(new PolarLicenseClient(cfg, fetchImpl), bad)).rejects.toMatchObject({
        code: 'invalid_license',
        httpStatus: 0,
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('production refuses a key without the EDIT prefix that the sandbox accepts', async () => {
    const other = 'ETTA-77777777-7777-4777-8777-777777777777';
    const prod = fake(200, VALIDATED);
    await expect(
      new PolarLicenseClient(production, prod.fetchImpl).validate(other)
    ).rejects.toMatchObject({ code: 'invalid_license' });
    expect(prod.calls).toHaveLength(0);

    const sandbox = fake(200, VALIDATED);
    await new PolarLicenseClient(cfg, sandbox.fetchImpl).validate(other);
    expect(sandbox.calls).toHaveLength(1);
  });

  it('production sends a well-formed key exactly as given', async () => {
    const { fetchImpl, calls } = fake(200, VALIDATED);
    const lower = KEY.toLowerCase();
    await new PolarLicenseClient(production, fetchImpl).validate(lower);
    expect(JSON.parse(calls[0].init.body).key).toBe(lower);
  });
});

describe('PolarLicenseClient', () => {
  it('validate posts {key, organization_id} tokenless to the customer-portal endpoint', async () => {
    const { fetchImpl, calls } = fake(200, VALIDATED);
    const v = await new PolarLicenseClient(cfg, fetchImpl).validate(KEY);
    expect(v.status).toBe('granted');
    expect(calls[0].url).toBe('https://api.test/v1/customer-portal/license-keys/validate');
    expect(JSON.parse(calls[0].init.body)).toEqual({ key: KEY, organization_id: 'org_x' });
    // tokenless: no Authorization header, but a UA is set (Cloudflare 1010 lesson)
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(calls[0].init.headers['user-agent']).toBeTruthy();
  });

  it('activate includes the device label', async () => {
    const { fetchImpl, calls } = fake(200, {
      id: 'act',
      license_key: { id: 'lk', display_key: '****-X', status: 'granted', expires_at: null },
    });
    await new PolarLicenseClient(cfg, fetchImpl).activate(KEY, 'devhash');
    expect(calls[0].url).toContain('/customer-portal/license-keys/activate');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      key: KEY,
      organization_id: 'org_x',
      label: 'devhash',
    });
  });

  it('deactivate posts the activation id', async () => {
    const { fetchImpl, calls } = fake(200, {});
    await new PolarLicenseClient(cfg, fetchImpl).deactivate(KEY, 'act_9');
    expect(calls[0].url).toContain('/deactivate');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      key: KEY,
      organization_id: 'org_x',
      activation_id: 'act_9',
    });
  });

  it('maps the 3rd-device 403 to seat_limit_reached', async () => {
    const { fetchImpl } = fake(403, {
      error: 'NotPermitted',
      detail: 'License key activation limit already reached',
    });
    await expect(new PolarLicenseClient(cfg, fetchImpl).activate(KEY, 'd')).rejects.toMatchObject({
      code: 'seat_limit_reached',
      httpStatus: 403,
    });
  });

  it('maps a generic non-OK to invalid_license', async () => {
    const { fetchImpl } = fake(404, { error: 'NotFound' });
    await expect(new PolarLicenseClient(cfg, fetchImpl).validate(KEY)).rejects.toMatchObject({
      code: 'invalid_license',
    });
  });

  it('maps a thrown fetch to network', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    // No-op backoff: a network error is retried, and this test is about the code
    // it settles on, not the wall-clock it spends getting there.
    await expect(
      new PolarLicenseClient(cfg, fetchImpl, { sleep: async () => {} }).validate(KEY)
    ).rejects.toMatchObject({
      code: 'network',
    });
  });
});

/**
 * Bounded retry for TRANSIENT failures. The endpoint throttles per caller, so a
 * refused request is not a verdict on the key — without a retry one busy moment
 * left the cached record unrefreshed, and the next attempt started from exactly
 * the same place. A definitive refusal is the opposite case and must never be
 * repeated. Every test here injects a no-op sleep so the suite never waits.
 */
describe('PolarLicenseClient retry policy', () => {
  /** A fetch whose status sequence is scripted per call; records honored waits. */
  function scripted(
    statuses: number[],
    opts: { retryAfter?: string | null } = {}
  ): { fetchImpl: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(status >= 200 && status < 300 ? VALIDATED : { e: status }),
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'retry-after' ? (opts.retryAfter ?? null) : null,
        },
      };
    };
    return { fetchImpl, calls };
  }

  it('retries a 429 and honors its Retry-After over the exponential schedule', async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = scripted([429, 200], { retryAfter: '60' });
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const v = await client.validate(KEY);
    expect(v.status).toBe('granted');
    expect(calls).toHaveLength(2);
    // The server said 60s; that wins over the 1s base backoff.
    expect(waits).toEqual([60_000]);
  });

  it('retries a 5xx on the exponential schedule when no Retry-After is supplied', async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = scripted([503, 503, 200]);
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await client.validate(KEY);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('caps an absurd Retry-After at maxDelayMs rather than sleeping for it', async () => {
    const waits: number[] = [];
    const { fetchImpl } = scripted([429, 200], { retryAfter: '86400' });
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      retry: { maxDelayMs: 5_000 },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await client.validate(KEY);
    expect(waits).toEqual([5_000]);
  });

  it('never retries a definitive refusal', async () => {
    const { fetchImpl, calls } = scripted([404]);
    const client = new PolarLicenseClient(cfg, fetchImpl, { sleep: async () => {} });

    await expect(client.validate(KEY)).rejects.toMatchObject({ code: 'invalid_license' });
    expect(calls).toHaveLength(1);
  });

  it('never retries activate — a second attempt would consume a second seat', async () => {
    // Activations STACK rather than dedupe by device, so a request that reached
    // the server and then failed on the way back has already taken a seat. A
    // retry would silently take the user's other one and leave their second
    // machine refused at the cap with no visible cause.
    const { fetchImpl, calls } = scripted([503, 200]);
    const client = new PolarLicenseClient(cfg, fetchImpl, { sleep: async () => {} });

    await expect(client.activate(KEY, 'device')).rejects.toMatchObject({ code: 'transient' });
    expect(calls).toHaveLength(1);
  });

  it('never retries deactivate, for the same reason in reverse', async () => {
    const { fetchImpl, calls } = scripted([503, 200]);
    const client = new PolarLicenseClient(cfg, fetchImpl, { sleep: async () => {} });

    await expect(client.deactivate(KEY, 'act_1')).rejects.toMatchObject({ code: 'transient' });
    expect(calls).toHaveLength(1);
  });

  it('floors a zero Retry-After instead of hammering the endpoint back-to-back', async () => {
    // The header is attacker-influenced input. Honoring `Retry-After: 0` verbatim
    // would turn the backoff into three immediate requests at the one endpoint
    // this policy exists to stop hammering.
    const waits: number[] = [];
    const { fetchImpl } = scripted([429, 200], { retryAfter: '0' });
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await client.validate(KEY);
    expect(waits).toEqual([1000]);
  });

  it('never retries a seat-cap refusal', async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ detail: 'License key activation limit reached' }),
      };
    };
    const client = new PolarLicenseClient(cfg, fetchImpl, { sleep: async () => {} });

    await expect(client.activate(KEY, 'd')).rejects.toMatchObject({ code: 'seat_limit_reached' });
    expect(calls).toHaveLength(1);
  });

  it('retries a thrown network error, then surfaces it once attempts run out', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    };
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      retry: { attempts: 3 },
      sleep: async () => {},
    });

    await expect(client.validate(KEY)).rejects.toMatchObject({ code: 'network' });
    expect(calls).toBe(3);
  });

  it('surfaces an exhausted throttle as transient, carrying the server wait for the caller', async () => {
    const { fetchImpl, calls } = scripted([429], { retryAfter: '60' });
    const client = new PolarLicenseClient(cfg, fetchImpl, { sleep: async () => {} });

    await expect(client.validate(KEY)).rejects.toMatchObject({
      code: 'transient',
      httpStatus: 429,
      retryAfterMs: 60_000,
    });
    expect(calls).toHaveLength(3);
  });

  /**
   * Record whether each timer opened for a `ms`-long wait is one that holds the
   * event loop open. `unref()` runs synchronously right after `setTimeout`
   * returns, so the state is read one microtask later — still long before any
   * timer fires. Filtering on the delay keeps the runner's own timers out.
   */
  function watchTimerRefs(ms: number): { refs: (boolean | undefined)[]; restore: () => void } {
    const refs: (boolean | undefined)[] = [];
    const real = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, delay?: number, ...rest: unknown[]) => {
      const handle = real(fn, delay, ...(rest as []));
      if (delay === ms) {
        const h = handle as unknown as { hasRef?: () => boolean };
        queueMicrotask(() => refs.push(h.hasRef?.()));
      }
      return handle;
    }) as unknown as typeof setTimeout);
    return { refs, restore: () => vi.unstubAllGlobals() };
  }

  it('waits out its default backoff on a timer that holds the process open', async () => {
    // No `sleep` injected here, deliberately: this is the wait a one-shot CLI
    // actually sits through. `editmamei activate`, `editmamei license` and
    // `refresh` all reach `withRetry` with nothing else pending, so a backoff
    // that let the loop drain would end the command mid-wait — no output, no
    // retry — instead of returning the verdict a moment later.
    const BACKOFF_MS = 17;
    const { refs, restore } = watchTimerRefs(BACKOFF_MS);
    try {
      const { fetchImpl, calls } = scripted([503, 200]);
      const client = new PolarLicenseClient(cfg, fetchImpl, {
        retry: { baseDelayMs: BACKOFF_MS, maxDelayMs: BACKOFF_MS },
      });

      const v = await client.validate(KEY);
      expect(v.status).toBe('granted');
      expect(calls).toHaveLength(2);
    } finally {
      restore();
    }
    expect(refs).toEqual([true]);
  });

  it('offers unrefSleep as the opt-out, for a check running behind a long-lived host', async () => {
    const BACKOFF_MS = 19;
    const { refs, restore } = watchTimerRefs(BACKOFF_MS);
    try {
      await unrefSleep(BACKOFF_MS);
    } finally {
      restore();
    }
    expect(refs).toEqual([false]);
  });

  it('tolerates a response with no headers at all (test doubles, older fetch shims)', async () => {
    const { fetchImpl } = fake(503, { e: 'down' });
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      retry: { attempts: 1 },
      sleep: async () => {},
    });

    await expect(client.validate(KEY)).rejects.toMatchObject({
      code: 'transient',
      retryAfterMs: undefined,
    });
  });
});

describe('PolarLicenseClient time limits', () => {
  const noSleep = async () => {};

  /** A server that accepts the request and never answers; returns how long each call waited. */
  function silent(): { fetchImpl: FetchLike; calls: number[] } {
    const calls: number[] = [];
    const fetchImpl: FetchLike = (_url, init) => {
      const started = Date.now();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          calls.push(Date.now() - started);
          reject(new Error('aborted'));
        });
      });
    };
    return { fetchImpl, calls };
  }

  it('gives up on validate after its limit and retries it as a network error', async () => {
    const { fetchImpl, calls } = silent();
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      sleep: noSleep,
      timeouts: { validateMs: 30, writeMs: 5_000 },
    });
    await expect(client.validate(KEY)).rejects.toMatchObject({ code: 'network', httpStatus: 0 });
    expect(calls).toHaveLength(3);
    expect(Math.max(...calls)).toBeLessThan(1_000);
  });

  it('waits the longer write limit on activate, once', async () => {
    const { fetchImpl, calls } = silent();
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      sleep: noSleep,
      timeouts: { validateMs: 10, writeMs: 80 },
    });
    await expect(client.activate(KEY, 'label')).rejects.toMatchObject({ code: 'network' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(60);
  });

  it('turns a response body that never finishes into a network error', async () => {
    const fetchImpl: FetchLike = async (_url, init) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const client = new PolarLicenseClient(cfg, fetchImpl, {
      sleep: noSleep,
      retry: { attempts: 1 },
      timeouts: { validateMs: 30 },
    });
    await expect(client.validate(KEY)).rejects.toMatchObject({ code: 'network' });
  });
});
