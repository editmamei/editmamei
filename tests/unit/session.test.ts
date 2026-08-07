import { describe, it, expect } from 'vitest';
import { Session } from '@editmamei/core/session.ts';
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
  it('initialize calls ping when autoConnect is on', async () => {
    const session = new Session();
    const conn = makeConnection();
    withFakeConnection(session, conn);

    await session.initialize();

    expect(conn.pingCalls).toBe(1);
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
