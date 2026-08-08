import { describe, it, expect } from 'vitest';
import {
  DeliveryClient,
  DeliveryError,
  type DeliveryFetch,
  type DeliveryResponse,
} from '@editmamei/delivery/client.ts';

const cfg = { baseUrl: 'http://localhost:8787' };

function jsonRes(status: number, body: unknown): DeliveryResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

function bytesRes(status: number, bytes: Uint8Array): DeliveryResponse {
  // Copy into a fresh ArrayBuffer so the type is exactly ArrayBuffer (not the
  // ArrayBufferLike that Uint8Array.buffer widens to under SharedArrayBuffer).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    arrayBuffer: async () => ab,
  };
}

/**
 * A DeliveryResponse whose body is a real streamed ReadableStream.
 * `arrayBuffer()` throws — fetchArtifact must never fall back to it when a
 * `body` is present, so a stray call is a test failure, not a silent buffer.
 */
function streamRes(
  status: number,
  chunks: Uint8Array[],
  opts: { contentLength?: string; onCancel?: () => void } = {}
): DeliveryResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      opts.onCancel?.();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    arrayBuffer: async () => {
      throw new Error('arrayBuffer() must not be called when a streamed body is present');
    },
    headers: {
      get: (h) => (h.toLowerCase() === 'content-length' ? (opts.contentLength ?? null) : null),
    },
    body: stream,
  };
}

describe('DeliveryClient', () => {
  it('throws not_configured when no base URL is set', () => {
    expect(() => new DeliveryClient({ config: { baseUrl: '' } })).toThrow(/not configured/);
  });

  it('sends the license key in the x-editmamei-license-key header (not the URL)', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: DeliveryFetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return jsonRes(200, {
        generated_at: 't',
        modules: {},
        license: { status: 'granted', expires_at: null },
      });
    };
    const client = new DeliveryClient({ config: cfg, fetchImpl });
    await client.fetchManifest('LICENSE-KEY-123');

    expect(seen[0].url).toBe('http://localhost:8787/v1/modules/manifest');
    expect(seen[0].headers['x-editmamei-license-key']).toBe('LICENSE-KEY-123');
    expect(seen[0].url).not.toContain('LICENSE-KEY-123');
  });

  it('parses the manifest body', async () => {
    const manifest = {
      generated_at: '2026-06-16T00:00:00Z',
      modules: {
        pro: {
          latest: '0.17.0',
          abi: 1,
          versions: { '0.17.0': { object: 'modules/pro/0.17.0.enc', sha256: 'ab', size: 10 } },
        },
      },
      license: { status: 'granted', expires_at: null },
    };
    const client = new DeliveryClient({
      config: cfg,
      fetchImpl: async () => jsonRes(200, manifest),
    });
    expect(await client.fetchManifest('K')).toEqual(manifest);
  });

  it('fetches the content key', async () => {
    const client = new DeliveryClient({
      config: cfg,
      fetchImpl: async () => jsonRes(200, { alg: 'AES-256-GCM', key: 'BASE64KEY' }),
    });
    expect(await client.fetchKey('K', 'pro')).toEqual({ alg: 'AES-256-GCM', key: 'BASE64KEY' });
  });

  it('returns artifact bytes verbatim', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251]);
    const client = new DeliveryClient({ config: cfg, fetchImpl: async () => bytesRes(200, bytes) });
    const out = await client.fetchArtifact('K', 'pro', '0.17.0');
    expect(Array.from(out)).toEqual([1, 2, 3, 250, 251]);
  });

  describe('artifact byte cap (enforced during the fetch, not after)', () => {
    it('downloads a streamed under-cap body chunk-by-chunk and reassembles it', async () => {
      const bytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl: async () =>
          streamRes(200, [bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)], {
            contentLength: String(bytes.byteLength),
          }),
        maxArtifactBytes: 1024,
      });
      const out = await client.fetchArtifact('K', 'pro', '0.17.0');
      expect(Array.from(out)).toEqual(Array.from(bytes));
    });

    it('rejects a response whose Content-Length exceeds the cap before reading the body', async () => {
      const cap = 16;
      // The actual body is tiny (well under cap) — only the declared Content-Length is
      // oversized. If the pre-read check were missing, this would happily stream the 4
      // real bytes and RESOLVE; asserting `.rejects` here pins the check firing first.
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl: async () =>
          streamRes(200, [new Uint8Array(4)], { contentLength: String(cap + 100) }),
        maxArtifactBytes: cap,
      });
      await expect(client.fetchArtifact('K', 'pro', '0.17.0')).rejects.toMatchObject({
        code: 'oversize',
      });
    });

    it('aborts a body that streams past the cap when Content-Length is absent (or understates it)', async () => {
      const cap = 16;
      let cancelled = false;
      const chunks = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]; // 30 bytes > 16 cap
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl: async () => streamRes(200, chunks, { onCancel: () => (cancelled = true) }),
        maxArtifactBytes: cap,
      });
      await expect(client.fetchArtifact('K', 'pro', '0.17.0')).rejects.toMatchObject({
        code: 'oversize',
      });
      expect(cancelled).toBe(true);
    });

    it('does not retry an oversize refusal (terminal, like not_entitled/not_found)', async () => {
      const cap = 8;
      let n = 0;
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl: async () => {
          n++;
          return streamRes(200, [new Uint8Array(cap + 1)], { contentLength: String(cap + 1) });
        },
        maxArtifactBytes: cap,
        sleep: async () => {},
      });
      await expect(client.fetchArtifact('K', 'pro', '0.17.0')).rejects.toMatchObject({
        code: 'oversize',
      });
      expect(n).toBe(1);
    });
  });

  it('maps 403 → not_entitled, 404 → not_found, 5xx → server', async () => {
    // no-op sleep: the 5xx case is transient and now retries — keep the test instant.
    const mk = (status: number) =>
      new DeliveryClient({
        config: cfg,
        fetchImpl: async () => jsonRes(status, 'err'),
        sleep: async () => {},
      });
    await expect(mk(403).fetchManifest('K')).rejects.toMatchObject({ code: 'not_entitled' });
    await expect(mk(404).fetchArtifact('K', 'pro', '0.17.0')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(mk(503).fetchKey('K', 'pro')).rejects.toMatchObject({ code: 'server' });
  });

  it('wraps a thrown fetch as a network DeliveryError', async () => {
    const client = new DeliveryClient({
      config: cfg,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      // no-op sleep: a thrown fetch is transient and now retries — keep the test instant.
      sleep: async () => {},
    });
    await expect(client.fetchManifest('K')).rejects.toMatchObject({ code: 'network' });
    await expect(client.fetchManifest('K')).rejects.toBeInstanceOf(DeliveryError);
  });

  describe('retry on transient errors', () => {
    const noSleep: (ms: number) => Promise<void> = async () => {};

    it('retries a thrown network error, then succeeds', async () => {
      let n = 0;
      const fetchImpl: DeliveryFetch = async () => {
        n++;
        if (n === 1) throw new Error('ECONNRESET');
        return jsonRes(200, { alg: 'AES-256-GCM', key: 'K' });
      };
      const client = new DeliveryClient({ config: cfg, fetchImpl, sleep: noSleep });
      expect(await client.fetchKey('K', 'pro')).toEqual({ alg: 'AES-256-GCM', key: 'K' });
      expect(n).toBe(2);
    });

    it('retries a 5xx (incl. the worker 429→503 throttle map), then succeeds', async () => {
      const manifest = {
        generated_at: 't',
        modules: {},
        license: { status: 'granted', expires_at: null },
      };
      let n = 0;
      const fetchImpl: DeliveryFetch = async () => {
        n++;
        return n < 3 ? jsonRes(503, 'busy') : jsonRes(200, manifest);
      };
      const client = new DeliveryClient({ config: cfg, fetchImpl, sleep: noSleep });
      expect(await client.fetchManifest('K')).toEqual(manifest);
      expect(n).toBe(3);
    });

    it('does NOT retry a terminal 403 not_entitled', async () => {
      let n = 0;
      const fetchImpl: DeliveryFetch = async () => {
        n++;
        return jsonRes(403, 'nope');
      };
      const client = new DeliveryClient({ config: cfg, fetchImpl, sleep: noSleep });
      await expect(client.fetchManifest('K')).rejects.toMatchObject({ code: 'not_entitled' });
      expect(n).toBe(1);
    });

    it('gives up after `attempts` transient failures and throws the last error', async () => {
      let n = 0;
      const fetchImpl: DeliveryFetch = async () => {
        n++;
        return jsonRes(503, 'busy');
      };
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl,
        sleep: noSleep,
        retry: { attempts: 3, baseDelayMs: 1 },
      });
      await expect(client.fetchKey('K', 'pro')).rejects.toMatchObject({ code: 'server' });
      expect(n).toBe(3);
    });

    /** A response carrying a Retry-After header (delta-seconds). */
    const withRetryAfter = (res: DeliveryResponse, secs: string): DeliveryResponse => ({
      ...res,
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? secs : null) },
    });

    it('honors a server Retry-After on retry instead of exponential backoff', async () => {
      const slept: number[] = [];
      let n = 0;
      const fetchImpl: DeliveryFetch = async () => {
        n++;
        return n === 1
          ? withRetryAfter(jsonRes(503, 'busy'), '2')
          : jsonRes(200, { alg: 'AES-256-GCM', key: 'K' });
      };
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl,
        sleep: async (ms) => {
          slept.push(ms);
        },
        minRequestIntervalMs: 0,
      });
      expect(await client.fetchKey('K', 'pro')).toEqual({ alg: 'AES-256-GCM', key: 'K' });
      expect(slept).toContain(2000); // 2s Retry-After, not the 1000ms exponential base
    });

    it('caps an excessive Retry-After at maxDelayMs', async () => {
      const slept: number[] = [];
      let n = 0;
      const fetchImpl: DeliveryFetch = async () => {
        n++;
        return n === 1
          ? withRetryAfter(jsonRes(503, 'busy'), '99999')
          : jsonRes(200, { alg: 'a', key: 'b' });
      };
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl,
        sleep: async (ms) => {
          slept.push(ms);
        },
        minRequestIntervalMs: 0,
        retry: { maxDelayMs: 5000 },
      });
      await client.fetchKey('K', 'pro');
      expect(Math.max(...slept)).toBe(5000);
    });

    it('paces requests to stay under the rate limit', async () => {
      const slept: number[] = [];
      const client = new DeliveryClient({
        config: cfg,
        fetchImpl: async () => jsonRes(200, { alg: 'a', key: 'b' }),
        sleep: async (ms) => {
          slept.push(ms);
        },
        minRequestIntervalMs: 500,
      });
      await client.fetchKey('K', 'pro'); // first call: no pacing wait
      await client.fetchKey('K', 'pro'); // second: paced ~500ms
      await client.fetchKey('K', 'pro'); // third: paced ~500ms
      expect(slept.filter((ms) => ms > 400).length).toBeGreaterThanOrEqual(2);
    });
  });
});
