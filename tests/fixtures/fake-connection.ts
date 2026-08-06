import type { PhotoshopConnection, PhotoshopInfo } from '@editmamei/platform/connection.ts';

export interface RecordedScript {
  script: string;
  timeout?: number;
}

export interface FakeConnectionOptions {
  info?: PhotoshopInfo | null;
  result?: unknown;
  resultFor?: (script: string) => unknown;
  throwOnExecute?: Error | null;
}

const DEFAULT_INFO: PhotoshopInfo = {
  version: '2024',
  path: 'C:/Program Files/Adobe/Adobe Photoshop 2024/Photoshop.exe',
  appName: 'Adobe Photoshop 2024',
};

/**
 * Drop-in stand-in for `PhotoshopConnection` used in tests.
 *
 * Records every script handed to `executeScript` so tests can assert
 * what would have been sent to Photoshop, without launching the app.
 *
 * Cast to `PhotoshopConnection` with `as unknown as PhotoshopConnection`
 * when passing into Editmamei factories — structural typing covers the
 * surface that the tools actually use.
 */
export class FakePhotoshopConnection {
  public executions: RecordedScript[] = [];
  public ensureRunningCalls = 0;
  public pingCalls = 0;
  public versionCalls = 0;

  private info: PhotoshopInfo | null;
  private result: unknown;
  private resultFor?: (script: string) => unknown;
  private throwOnExecute: Error | null;

  constructor(options: FakeConnectionOptions = {}) {
    this.info = options.info === undefined ? DEFAULT_INFO : options.info;
    this.result = options.result ?? '{ status: "ok" }';
    this.resultFor = options.resultFor;
    this.throwOnExecute = options.throwOnExecute ?? null;
  }

  async ping(): Promise<boolean> {
    this.pingCalls++;
    return this.info !== null;
  }

  async getVersion(): Promise<string> {
    this.versionCalls++;
    return this.info?.version ?? 'Unknown';
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    this.executions.push({ script, timeout });
    if (this.throwOnExecute) {
      throw this.throwOnExecute;
    }
    if (this.resultFor) {
      return this.resultFor(script);
    }
    return this.result;
  }

  getPhotoshopInfo(): PhotoshopInfo | null {
    return this.info;
  }

  /**
   * Mirrors PhotoshopConnection.ensureDetected (2026-08-01). The real one
   * single-flights detector.detect() and is AWAITED by PhotoshopAPIFactory —
   * that factory call is the first gate every runScript passes, so a double
   * without this method fails every tool test. The fake has nothing to detect:
   * its info is whatever the test injected, so this just resolves it.
   */
  async ensureDetected(): Promise<PhotoshopInfo | null> {
    return this.info;
  }

  async ensurePhotoshopRunning(): Promise<void> {
    this.ensureRunningCalls++;
  }

  /** Test helper — the script of the most recent execution. */
  lastScript(): string {
    if (this.executions.length === 0) {
      throw new Error('FakePhotoshopConnection: no script has been executed yet.');
    }
    return this.executions[this.executions.length - 1].script;
  }

  /** Test helper — every script body the fake has received. */
  allScripts(): string[] {
    return this.executions.map((e) => e.script);
  }

  /** Test helper — the timeout (if any) of the most recent execution. */
  lastTimeout(): number | undefined {
    if (this.executions.length === 0) {
      throw new Error('FakePhotoshopConnection: no script has been executed yet.');
    }
    return this.executions[this.executions.length - 1].timeout;
  }

  reset(): void {
    this.executions = [];
    this.ensureRunningCalls = 0;
    this.pingCalls = 0;
    this.versionCalls = 0;
  }

  /** Cast helper so tests don't repeat the `as unknown as` dance. */
  asConnection(): PhotoshopConnection {
    return this as unknown as PhotoshopConnection;
  }
}

export function makeConnection(options?: FakeConnectionOptions): FakePhotoshopConnection {
  return new FakePhotoshopConnection(options);
}
