/**
 * Pins what `src/core/tool-activity.ts` may export. The CE build's Pro-name scans exempt that
 * file wholesale (it is a tool inventory, like tool-tiers.ts), so without this pin it could
 * quietly become a place to park any Pro name a CE file wanted to reference.
 */
import { describe, it, expect } from 'vitest';
import * as activity from '../../src/core/tool-activity.js';
import { TOOL_TIERS } from '../../src/core/tool-tiers.js';

describe('core/tool-activity exports', () => {
  it('exports exactly the three activity sets and the tracked tool names', () => {
    expect(Object.keys(activity).sort()).toEqual([
      'CAMERA_RAW_TOOL',
      'KEPT_WORK_TOOLS',
      'MUTATING_TOOLS',
      'RAW_DEVELOP_TOOL',
      'READ_ONLY_TOOLS',
    ]);
  });

  it('names only registered tools', () => {
    const names = [
      ...activity.READ_ONLY_TOOLS,
      ...activity.KEPT_WORK_TOOLS,
      ...activity.MUTATING_TOOLS,
      activity.RAW_DEVELOP_TOOL,
      activity.CAMERA_RAW_TOOL,
    ];
    const unknown = names.filter((n) => !(n in TOOL_TIERS));
    expect(unknown).toEqual([]);
  });

  it('the tracked tools are the raw-develop pair the server keys its advisory on', () => {
    expect(activity.RAW_DEVELOP_TOOL).toBe('ps_develop_raw');
    expect(activity.CAMERA_RAW_TOOL).toBe('ps_apply_camera_raw');
    expect(activity.MUTATING_TOOLS.has(activity.RAW_DEVELOP_TOOL)).toBe(true);
    expect(activity.MUTATING_TOOLS.has(activity.CAMERA_RAW_TOOL)).toBe(true);
  });
});
