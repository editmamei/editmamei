import { Logger } from '../utils/logger.js';

/**
 * The queue watchdog bounds TOTAL time (wait + exec), not just exec time.
 * runChildWithTimeout inside the runner's own script call bounds EXEC time
 * with the same value, then SIGTERM/SIGKILLs the child and produces a richer
 * "PS modal" diagnostic. Without slack here, both fire on the same deadline
 * and the queue's generic "Script execution timeout" rejects first, masking
 * the helper's actionable error. The slack gives the helper enough room
 * (SIGTERM + 2s grace + buffer for the exit event to fire) to reach its
 * richer reject path before the queue gives up.
 */
export const QUEUE_SLACK_MS = 3500;

interface QueueTask {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Set when the caller's timeout fired; the queue skips this task. */
  cancelled: boolean;
  /** Set when resolve/reject has already been called (settle-guard). */
  settled: boolean;
  /** The per-task timeout handle, cleared the moment the task settles. */
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
      const task: QueueTask = {
        run,
        resolve,
        reject,
        cancelled: false,
        settled: false,
        timeoutId: null,
      };

      // See the QUEUE_SLACK_MS doc comment above — this lets the runner's
      // richer "PS modal" diagnostic win the race over this generic timeout.
      task.timeoutId = setTimeout(() => {
        if (task.settled) return;
        task.cancelled = true;
        task.settled = true;
        task.timeoutId = null;
        reject(new Error('Script execution timeout'));
      }, timeout + QUEUE_SLACK_MS);

      this.queue.push(task);
      // processQueue runs as long as work is available; subsequent calls
      // short-circuit while one is already running. We do NOT clear the
      // timeout here — the per-task timer is cleared inside settleTask().
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
        if (task.cancelled) continue;
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
