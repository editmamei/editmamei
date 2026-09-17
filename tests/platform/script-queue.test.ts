import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScriptQueue, QUEUE_SLACK_MS } from '@editmamei/platform/script-queue.ts';
import { Logger } from '@editmamei/utils/logger.ts';

/**
 * The watchdog must bound EXEC time only — armed when a task actually starts
 * running, not when it is enqueued. Before this, the timer started at
 * enqueue() and could fire while a short-budget task was still just sitting
 * behind a longer one, killing it before it ever ran. Fake timers make the
 * "armed at exec start" claim provable: real elapsed queue-wait time never
 * advances the fake clock unless the test explicitly advances it.
 */
describe('ScriptQueue — watchdog timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start a queued task's watchdog until it begins executing", async () => {
    const queue = new ScriptQueue(new Logger('test'));

    // Task A holds the queue open until the test releases it.
    let releaseA: (() => void) | undefined;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const taskA = queue.enqueue(async () => {
      await aGate;
      return 'A done';
    }, 100_000); // long budget — irrelevant to this test, must not fire

    // Task B has a SHORT budget and is queued behind A.
    const taskB = queue.enqueue(async () => 'B done', 1_000);

    let bSettled = false;
    void taskB.then(() => {
      bSettled = true;
    });

    // Advance well past B's own 1000 + QUEUE_SLACK_MS budget while A still
    // holds the queue. If B's watchdog had been armed at enqueue() time, it
    // would have rejected by now.
    await vi.advanceTimersByTimeAsync(1_000 + QUEUE_SLACK_MS + 5_000);
    expect(bSettled).toBe(false);

    // Release A; B should now run to completion quickly, well inside its
    // own budget, since its watchdog only starts counting from here.
    releaseA!();
    await vi.advanceTimersByTimeAsync(0);
    await expect(taskB).resolves.toBe('B done');
    await expect(taskA).resolves.toBe('A done');
  });

  it('fires the watchdog only after timeout+slack have elapsed since the task started running', async () => {
    const queue = new ScriptQueue(new Logger('test'));
    // A task whose run() never resolves on its own — only the watchdog can
    // settle it.
    const result = queue.enqueue(() => new Promise(() => {}), 1_000);

    let settled = false;
    let rejection: unknown;
    // Chained, not two separate listeners on `result`: `.finally()` on the
    // BARE `result` would produce its own derived promise that re-rejects
    // with the same reason and is never awaited or caught — an unhandled
    // rejection. Catching first yields a resolved chain for `.finally()` to
    // sit on.
    void result
      .catch((e) => {
        rejection = e;
      })
      .finally(() => {
        settled = true;
      });

    // One ms short of the watchdog's deadline: must not have fired yet.
    await vi.advanceTimersByTimeAsync(1_000 + QUEUE_SLACK_MS - 1);
    expect(settled).toBe(false);

    // Crossing the deadline: must fire now.
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('Script execution timeout');
  });

  it('resolves a fast task normally, watchdog never firing', async () => {
    const queue = new ScriptQueue(new Logger('test'));
    const result = queue.enqueue(async () => 'quick', 5_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('quick');
  });
});
