import { Logger } from '../utils/logger.js';

/**
 * The queue watchdog bounds EXEC time only — its timer is armed when a task
 * actually starts running, not when it is enqueued, so time spent waiting
 * behind an earlier, longer-running task is never charged against a
 * shorter-budget task's own timeout. runChildWithTimeout inside the
 * runner's own script call bounds exec time with the same value, then
 * SIGTERM/SIGKILLs the child and produces a richer "PS modal" diagnostic.
 * Without slack here, both fire on the same deadline and this queue's
 * generic "Script execution timeout" rejects first, masking the helper's
 * actionable error. The slack gives the helper enough room (SIGTERM + 2s
 * grace + buffer for the exit event to fire) to reach its richer reject
 * path before the queue gives up.
 */
export const QUEUE_SLACK_MS = 3500;

interface QueueTask {
  run: () => Promise<unknown>;
  /** Effective per-script timeout this task's watchdog is armed from. */
  timeout: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Set when resolve/reject has already been called (settle-guard). */
  settled: boolean;
  /** The per-task timeout handle, armed only once the task starts running. */
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * In-process serialization queue shared by the platform runners
 * (windows-runner.ts / macos-runner.ts). Every DoJavaScript / osascript
 * call is funneled through here so Photoshop never gets two interleaved
 * scripts — load-bearing.
 *
 * Each runner composes one instance and calls enqueue() from its
 * run(), passing the platform-specific script-running function as `run`.
 */
export class ScriptQueue {
  private queue: QueueTask[] = [];
  private isProcessing = false;

  constructor(private logger: Logger) {}

  enqueue(run: () => Promise<unknown>, timeout: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ run, timeout, resolve, reject, settled: false, timeoutId: null });
      // processQueue runs as long as work is available; subsequent calls
      // short-circuit while one is already running.
      void this.processQueue();
    });
  }

  private settleTask(task: QueueTask, fn: () => void): void {
    if (task.settled) return;
    task.settled = true;
    if (task.timeoutId !== null) {
      clearTimeout(task.timeoutId);
      task.timeoutId = null;
    }
    fn();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        // Armed here, not in enqueue() — see the QUEUE_SLACK_MS doc comment
        // above for why the watchdog must only measure exec time.
        task.timeoutId = setTimeout(() => {
          this.settleTask(task, () => task.reject(new Error('Script execution timeout')));
        }, task.timeout + QUEUE_SLACK_MS);
        task.timeoutId.unref?.();
        try {
          const result = await task.run();
          this.settleTask(task, () => task.resolve(result));
        } catch (error) {
          if (task.settled) {
            this.logger.error('Script execution failed after settle:', error);
          } else {
            this.settleTask(task, () => task.reject(error));
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
