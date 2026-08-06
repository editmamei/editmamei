/**
 * The contracts Editmamei needs from a host operating system.
 *
 * Two ports, deliberately separate, because they answer to different owners.
 * Running a script is a per-call concern on the hot path: every tool handler
 * funnels through it, and the calls are serialized so Photoshop never sees two
 * at once (see `script-queue.ts`). Starting and observing the Photoshop
 * *process* is a session-level concern that `PhotoshopConnection` manages
 * behind a freshness latch, and it fires on a small fraction of calls.
 *
 * These used to be one interface, which made the lifecycle methods read as part
 * of the execution path. That stopped being true once the connection grew its
 * own latch and child-process handling moved into `run-child.ts`. Callers
 * should depend on the narrower port they actually use.
 */

/**
 * A Photoshop install located on this machine.
 *
 * Static facts only. Whether Photoshop is *running* is deliberately not here:
 * liveness is a moment-to-moment property that goes stale the instant it is
 * recorded, and `PhotoshopConnection` already owns it behind a TTL latch. A
 * cached boolean on this record invited callers to trust a value nothing
 * refreshes.
 */
export interface PhotoshopInfo {
  /**
   * Version as the install reports it — a real version string like `27.2.0`
   * when the bundle metadata is readable, otherwise the release year parsed
   * from the install path.
   */
  version: string;

  /** Absolute path to the executable (Windows) or the `.app` bundle (macOS). */
  path: string;

  /**
   * macOS only: the bundle's display name, which is how AppleScript addresses
   * the application. Windows reaches Photoshop through a fixed COM ProgID and
   * leaves this unset.
   */
  appName?: string;
}

/** Executes one wrapped ExtendScript payload in Photoshop. */
export interface ScriptRunner {
  /**
   * @param script    Wrapped ExtendScript source, ready to run as-is.
   * @param timeoutMs Wall-clock budget for this call. Handlers that legitimately
   *                  run long — an annotated preview over a deep layer stack —
   *                  raise it; omitting it takes the platform default.
   */
  run(script: string, timeoutMs?: number): Promise<unknown>;
}

/** Observes and starts the Photoshop application process. */
export interface AppLifecycle {
  /** Whether a Photoshop process is up at this moment. */
  isRunning(): Promise<boolean>;

  /**
   * Start Photoshop and resolve once it has been given time to come up.
   *
   * This resolves on a timer, not on readiness — there is no cheap signal for
   * "Photoshop has finished launching," so the first script sent afterwards is
   * what actually proves the app is answering.
   */
  launch(executablePath: string): Promise<void>;
}

/**
 * What a platform module supplies: both ports on one object, plus an optional
 * hook for configuration only some platforms need.
 */
export interface PlatformAdapter extends ScriptRunner, AppLifecycle {
  /**
   * Hand the adapter the install the detector resolved.
   *
   * macOS needs the bundle name from it to address Photoshop over AppleScript.
   * Windows has nothing to take and does not implement this. Optional so the
   * connection can call it unconditionally rather than carrying a
   * macOS-shaped branch.
   */
  useInstall?(install: PhotoshopInfo): void;
}
