/**
 * automation.allow_adobe_generative_credits: off leaves every tool that spends Adobe generative
 * credits out of the tool list, and ps_list_capabilities says how to turn them back on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

useSessionLogSandbox();

const state = vi.hoisted(() => ({ allow: true }));
const tmpDirs: string[] = [];

vi.mock('@editmamei/core/settings.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@editmamei/core/settings.ts')>();
  return {
    ...actual,
    // A fresh settings file in a temp dir, so the real ~/.editmamei is never read or written.
    loadSettings: () => {
      const dir = mkdtempSync(join(tmpdir(), 'editmamei-adobe-credits-'));
      tmpDirs.push(dir);
      const result = actual.loadSettings({ dir });
      result.settings.automation.allow_adobe_generative_credits = state.allow;
      return { ...result, created: false };
    },
  };
});

const { EditmameiServer, ADOBE_CREDIT_TOOLS_OFF_NOTE } = await import('@editmamei/core/server.ts');

type Internals = {
  toolRegistry: { list(): Array<{ name: string }> };
  listCapabilities(): {
    content: Array<{ text: string }>;
    structuredContent: Record<string, unknown>;
  };
};

function boot(allow: boolean): Internals {
  state.allow = allow;
  return new EditmameiServer() as unknown as Internals;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('automation.allow_adobe_generative_credits', () => {
  it('on (the default): ps_relight is offered', () => {
    const server = boot(true);
    expect(server.toolRegistry.list().map((t) => t.name)).toContain('ps_relight');
    expect(server.listCapabilities().structuredContent.adobe_credit_tools_off).toBeUndefined();
  });

  it('off: ps_relight is left out, and the capability map says how to turn it on', () => {
    const server = boot(false);
    const names = server.toolRegistry.list().map((t) => t.name);
    expect(names).not.toContain('ps_relight');
    expect(names).toContain('ps_add_adjustment_layer');
    const caps = server.listCapabilities();
    expect(caps.structuredContent.adobe_credit_tools_off).toBe(ADOBE_CREDIT_TOOLS_OFF_NOTE);
    expect(caps.content[0].text).toContain('automation.allow_adobe_generative_credits true');
  });
});
