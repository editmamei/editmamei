import { beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Redirects SessionLog's default directory to a throwaway per-test temp dir, for
 * any test file that constructs a real `EditmameiServer`.
 *
 * `EditmameiServer`'s constructor builds its own `SessionLog` with no `dir`
 * override (`new SessionLog(this.session.getSessionId())` in server.ts), so
 * every `tools/call` dispatched through such a server writes a REAL session
 * NDJSON line into `~/.editmamei/sessions/` — confirmed by spawn-log timestamps
 * correlating with test runs, polluting the user's session analytics on every
 * suite run. `SessionLog` now checks the `EDITMAMEI_SESSION_LOG_DIR` env var
 * before falling back to the real homedir path (session-log.ts) — the same
 * override-seam convention as `EDITMAMEI_MODELS_DIR` / `EDITMAMEI_CORE_BIN`
 * elsewhere in this repo.
 *
 * Call once at the top of the file (outside any `describe`), before any
 * `new EditmameiServer()`. Registers file-scoped `beforeEach`/`afterEach` hooks
 * — per-TEST (not per-file) redirection so a nested `describe`'s own
 * `vi.unstubAllEnvs()` (several server-construction tests stub unrelated env
 * vars per test, e.g. LOG_SCRIPT_ON_ERROR) can never leave a LATER test's
 * session log pointed at the real homedir: the next test's outer `beforeEach`
 * always re-stubs before that test's body runs, regardless of what an inner
 * hook cleared in between.
 *
 * The `afterEach` also unstubs the env var (not just deleting the temp dir it
 * pointed to) — without this, the LAST test in a file that calls
 * `useSessionLogSandbox()` leaves `EDITMAMEI_SESSION_LOG_DIR` stubbed to a
 * now-deleted temp path for the rest of the worker process (no more
 * `beforeEach` runs to re-stub it after the file's last test), so any LATER
 * test FILE sharing that worker that constructs a `SessionLog`/`EditmameiServer`
 * without its own `dir` override would silently write into that stale,
 * nonexistent path instead of the real homedir default.
 *
 * @example
 * import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';
 * useSessionLogSandbox();
 * describe('...', () => { ... new EditmameiServer() ... });
 */
export function useSessionLogSandbox(): void {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-sessionlog-sandbox-'));
    vi.stubEnv('EDITMAMEI_SESSION_LOG_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
}
