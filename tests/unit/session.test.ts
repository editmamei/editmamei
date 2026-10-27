import { describe, it, expect } from 'vitest';
import { Session } from '@editmamei/core/session.ts';
import { PhotoshopConnection } from '@editmamei/platform/connection.ts';
import type { HostPlatform } from '@editmamei/platform/host-platform.ts';
import type { PhotoshopInfo, PlatformAdapter } from '@editmamei/platform/ports.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

/**
 * Session constructs a real PhotoshopConnection internally, but we can swap
 * its private `connection` field for our fake before calling any lifecycle
 * methods. That exercises the real Session code paths (initialize, connect,
 * disconnect, activity tracking) without touching the platform layer.
 */
function withFakeConnection(session: Session, fakeConn: ReturnType<typeof makeConnection>): void {
  (session as unknown as { connection: unknown }).connection = fakeConn;
}

describe('Session', () => {
  it('initialize calls ping when autoConnect is on and Photoshop is running', async () => {
    const session = new Session();
    const conn = makeConnection();
    withFakeConnection(session, conn);

    await session.initialize();

    expect(conn.pingCalls).toBe(1);
  });

  // A ping runs through executeScript, which launches a closed Photoshop, so
  // "no ping" here is "no launch at boot".
  it('initialize does not ping when Photoshop is not running', async () => {
    const session = new Session();
    const conn = makeConnection({ currentlyRunning: false });
    withFakeConnection(session, conn);

    await session.initialize();

    expect(conn.pingCalls).toBe(0);
  });

  it('initialize does not ping when no install is detected', async () => {
    const session = new Session();
    const conn = makeConnection({ info: null });
    withFakeConnection(session, conn);

    await session.initialize();

    expect(conn.pingCalls).toBe(0);
  });

  it('initialize resolves without pinging when detection throws', async () => {
    const session = new Session();
    const conn = makeConnection();
    conn.ensureDetected = async () => {
      throw new Error('detector failed');
    };
    withFakeConnection(session, conn);

    await expect(session.initialize()).resolves.toBeUndefined();
    expect(conn.pingCalls).toBe(0);
  });

  describe('initialize against a real PhotoshopConnection', () => {
    const INFO: PhotoshopInfo = {
      version: '2024',
      path: 'C:/Program Files/Adobe/Adobe Photoshop 2024/Photoshop.exe',
    };

    function realConnection(running: boolean) {
      const calls = { detect: 0, launch: 0, run: 0 };
      const adapter: PlatformAdapter = {
        isRunning: async () => running,
        launch: async () => {
          calls.launch++;
        },
        run: async () => {
          calls.run++;
          return 'pong';
        },
      };
      const detector = {
        detect: async () => {
          calls.detect++;
          return INFO;
        },
      };
      const host: HostPlatform = { os: 'win32', adapter, detector };
      return { conn: new PhotoshopConnection({ host }), calls };
    }

    it('never launches a closed Photoshop', async () => {
      const session = new Session();
      const { conn, calls } = realConnection(false);
      withFakeConnection(session, conn as unknown as ReturnType<typeof makeConnection>);

      await session.initialize();

      expect(calls).toEqual({ detect: 1, launch: 0, run: 0 });
    });

    it('detects first, so a running Photoshop is still warmed', async () => {
      const session = new Session();
      const { conn, calls } = realConnection(true);
      withFakeConnection(session, conn as unknown as ReturnType<typeof makeConnection>);

      await session.initialize();

      expect(calls).toEqual({ detect: 1, launch: 0, run: 1 });
    });
  });

  it('initialize does not ping when autoConnect is off', async () => {
    const session = new Session({ autoConnect: false });
    const conn = makeConnection();
    withFakeConnection(session, conn);

    await session.initialize();

    expect(conn.pingCalls).toBe(0);
  });

  it('connect returns true when ping succeeds', async () => {
    const session = new Session({ autoConnect: false });
    const conn = makeConnection();
    withFakeConnection(session, conn);

    const ok = await session.connect();
    expect(ok).toBe(true);
  });

  it('connect returns false when ping fails', async () => {
    const session = new Session({ autoConnect: false });
    const conn = makeConnection({ info: null });
    withFakeConnection(session, conn);

    const ok = await session.connect();
    expect(ok).toBe(false);
  });

  it('updateActivity advances the last activity timestamp', async () => {
    const session = new Session({ autoConnect: false });
    const before = session.getLastActivity().getTime();
    await new Promise((r) => setTimeout(r, 5));
    session.updateActivity();
    expect(session.getLastActivity().getTime()).toBeGreaterThan(before);
  });

  it('disconnect resolves without throwing', async () => {
    const session = new Session({ autoConnect: false });
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  it('getConnection returns the wired connection object', () => {
    const session = new Session({ autoConnect: false });
    const conn = makeConnection();
    withFakeConnection(session, conn);
    expect(session.getConnection()).toBe(conn);
  });

  it('allocates a unique session ID for each construction', () => {
    const a = new Session({ autoConnect: false });
    const b = new Session({ autoConnect: false });
    expect(a.getSessionId()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(a.getSessionId()).not.toBe(b.getSessionId());
  });

  it('honors an explicit sessionId override (used by tests)', () => {
    const s = new Session({ autoConnect: false, sessionId: 'explicit-test-id' });
    expect(s.getSessionId()).toBe('explicit-test-id');
  });
});
