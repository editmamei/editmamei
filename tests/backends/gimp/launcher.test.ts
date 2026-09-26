import { describe, it, expect } from 'vitest';
import { exeLaunchSpec, flatpakLaunchSpec } from '@editmamei/backends/gimp/launcher.ts';

describe('gimp launcher specs', () => {
  it('exeLaunchSpec runs the exe directly with no extra args', () => {
    expect(exeLaunchSpec('C:\\GIMP\\bin\\gimp-console-3.exe')).toEqual({
      command: 'C:\\GIMP\\bin\\gimp-console-3.exe',
      args: [],
    });
  });

  it('flatpakLaunchSpec runs gimp-console-3.2 through flatpak run', () => {
    expect(flatpakLaunchSpec()).toEqual({
      command: 'flatpak',
      args: ['run', '--command=gimp-console-3.2', 'org.gimp.GIMP'],
    });
  });
});
