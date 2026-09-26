/**
 * A fake headless-GIMP process for tests that drive a REAL `GimpSession` (and the tool layer on
 * top of it) without spawning anything: `fakeGimpSpawn` returns a `SpawnFn` whose stub child
 * writes `rpc/ready` and answers `rpc/req-*.json` files through a responder, the same file
 * protocol the bridge speaks. Never pair it with the real tree-kill: pass a `killTree` spy.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SpawnFn } from '@editmamei/backends/gimp/session.ts';

export interface FakeGimpSpawnOptions {
  /** Result for each op. Throw an error with a `code` property to answer with that bridge code. */
  responder: (op: string, args: Record<string, unknown>) => unknown;
  /** Ops that are never answered (to force a timeout). */
  hangOps?: ReadonlySet<string>;
}

export interface FakeGimpSpawn {
  spawn: SpawnFn;
  /** Every spawned stub, oldest first. */
  children: ChildProcess[];
  /** Stops every responder loop. */
  stop: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stubChild(): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    kill: () => boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 999_999_999; // far outside any real pid range
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => true;
  return proc as unknown as ChildProcess;
}

export function fakeGimpSpawn(opts: FakeGimpSpawnOptions): FakeGimpSpawn {
  const children: ChildProcess[] = [];
  let stopped = false;

  async function serve(rpcDir: string, child: ChildProcess): Promise<void> {
    while (!stopped) {
      if (existsSync(join(rpcDir, 'shutdown'))) {
        (child as unknown as { exitCode: number }).exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0);
        return;
      }
      let names: string[];
      try {
        names = readdirSync(rpcDir).filter((n) => /^req-\d+\.json$/.test(n));
      } catch {
        return; // session dir removed
      }
      for (const name of names) {
        const reqPath = join(rpcDir, name);
        let req: { id: number; op: string; args: Record<string, unknown> };
        try {
          req = JSON.parse(readFileSync(reqPath, 'utf8'));
        } catch {
          continue;
        }
        if (opts.hangOps?.has(req.op)) continue;
        let resp: Record<string, unknown>;
        try {
          resp = { id: req.id, ok: true, result: opts.responder(req.op, req.args ?? {}) };
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'gimp_op_failed';
          resp = { id: req.id, ok: false, code, error: (err as Error).message };
        }
        const respPath = join(rpcDir, `resp-${req.id}.json`);
        writeFileSync(`${respPath}.tmp`, JSON.stringify(resp));
        renameSync(`${respPath}.tmp`, respPath);
        try {
          unlinkSync(reqPath);
        } catch {
          /* already gone */
        }
      }
      await sleep(2);
    }
  }

  const spawn: SpawnFn = (_command, _args, options) => {
    const child = stubChild();
    children.push(child);
    const rpcDir = join((options.env as Record<string, string>).EM_GIMP_SESSION, 'rpc');
    writeFileSync(join(rpcDir, 'ready.tmp'), '1');
    renameSync(join(rpcDir, 'ready.tmp'), join(rpcDir, 'ready'));
    void serve(rpcDir, child);
    return child;
  };

  return {
    spawn,
    children,
    stop: () => {
      stopped = true;
    },
  };
}
