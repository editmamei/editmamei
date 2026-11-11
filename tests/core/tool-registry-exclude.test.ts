import { describe, it, expect } from 'vitest';
import { ToolRegistry, type ToolDefinition } from '@editmamei/core/tool-registry.ts';

const def = (name: string, spendsAdobeCredits?: boolean): ToolDefinition => ({
  tool: { name, description: name, inputSchema: { type: 'object' } },
  handler: async () => ({ content: [] }),
  ...(spendsAdobeCredits ? { spendsAdobeCredits } : {}),
});

describe('ToolRegistry exclude', () => {
  it('leaves out matching tools whenever they register, including in a later batch', () => {
    const registry = new ToolRegistry({ exclude: (d) => d.spendsAdobeCredits === true });
    registry.registerAll([def('ps_a'), def('ps_paid', true)]);
    registry.register('ps_paid_later', def('ps_paid_later', true));
    expect(registry.list().map((t) => t.name)).toEqual(['ps_a']);
    expect(registry.get('ps_paid')).toBeUndefined();
  });

  it('registers everything without an exclude rule', () => {
    const registry = new ToolRegistry();
    registry.registerAll([def('ps_a'), def('ps_paid', true)]);
    expect(registry.count()).toBe(2);
  });
});
