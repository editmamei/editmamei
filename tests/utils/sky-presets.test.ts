/**
 * Built-in sky lookup for ps_replace_sky. The Skies.psp fixture is synthetic but follows the
 * layout of Photoshop 2026's file (checked 2026-10-20 against the installed one): per sky, a
 * `skpN` TEXT name then a `Szid` TEXT GUID, each a big-endian UTF-16 code-unit count and
 * null-terminated UTF-16BE text, among image and descriptor bytes the parser has to skip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSkyPreset,
  findSkyPresetsDir,
  loadSkyPresets,
  matchSkyPreset,
  parseSkyPresets,
  prettySkyName,
  type SkyPreset,
} from '@editmamei/utils/sky-presets.ts';

const GUIDS = {
  blue000: 'e1ec0b09-795a-794b-9abe-5898fd9d34d9',
  blue001: 'd36f6769-1c16-f641-bac6-aff4f13fa601',
  blue002: '37a0c6ac-232b-804a-a5fd-4b4e9c7b91c0',
  spec004: '5a680667-6da9-d84c-a5a4-bc27a6bb7e2e',
  sunset003: 'b8dc2297-b2a2-d344-be61-1194094da676',
};

function text(key: string, value: string): Buffer {
  const chars = value + '\u0000';
  const len = Buffer.alloc(4);
  len.writeUInt32BE(chars.length);
  const body = Buffer.alloc(chars.length * 2);
  for (let i = 0; i < chars.length; i++) body.writeUInt16BE(chars.charCodeAt(i), i * 2);
  return Buffer.concat([Buffer.alloc(4), Buffer.from(key + 'TEXT', 'latin1'), len, body]);
}

function psp(entries: [string, string][]): Buffer {
  const noise = Buffer.from('JPEG\u0000\u0007ÿØ sRoiObjc Rct1 Top long', 'latin1');
  return Buffer.concat([
    Buffer.from([0x00, 0x01, 0x38, 0x42, 0x53, 0x4b]),
    ...entries.flatMap(([name, guid]) => [noise, text('skpN', name), text('Szid', guid), noise]),
  ]);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skies-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeSkies = (
  into: string,
  entries: [string, string][],
  withImages = entries.map((e) => e[1])
) => {
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, 'Skies.psp'), psp(entries));
  for (const g of withImages) writeFileSync(join(into, `${g}.jpg`), 'jpg');
};

describe('prettySkyName', () => {
  it("spaces out Photoshop's run-together names", () => {
    expect(prettySkyName('BlueSky002byRickMandia')).toBe('Blue Sky 002 by Rick Mandia');
    expect(prettySkyName('SunsetSky001byPhotoshop')).toBe('Sunset Sky 001 by Photoshop');
    expect(prettySkyName('Spectacular007byRussellBrown')).toBe('Spectacular 007 by Russell Brown');
  });

  it('leaves a name that already has spaces alone', () => {
    expect(prettySkyName('My Lake Sky')).toBe('My Lake Sky');
  });
});

describe('parseSkyPresets', () => {
  it('pairs each name with its GUID-named image', () => {
    writeSkies(dir, [
      ['BlueSky000byRickMandia', GUIDS.blue000],
      ['SunsetSky003byRussellBrown', GUIDS.sunset003],
    ]);
    const skies = loadSkyPresets(dir);
    expect(skies).toEqual([
      { name: 'Blue Sky 000 by Rick Mandia', file: join(dir, `${GUIDS.blue000}.jpg`) },
      { name: 'Sunset Sky 003 by Russell Brown', file: join(dir, `${GUIDS.sunset003}.jpg`) },
    ]);
  });

  it('drops an entry whose image is missing', () => {
    writeSkies(
      dir,
      [
        ['BlueSky000byRickMandia', GUIDS.blue000],
        ['BlueSky001byPhotoshop', GUIDS.blue001],
      ],
      [GUIDS.blue001]
    );
    expect(loadSkyPresets(dir).map((s) => s.name)).toEqual(['Blue Sky 001 by Photoshop']);
  });

  it('never builds a path from an id that is not a GUID', () => {
    writeSkies(dir, [['Sneaky', '..\\..\\Windows\\win']], []);
    expect(loadSkyPresets(dir)).toEqual([]);
  });

  it('survives a truncated or garbage buffer', () => {
    const whole = psp([['BlueSky000byRickMandia', GUIDS.blue000]]);
    expect(parseSkyPresets(whole.subarray(0, whole.length - 20), dir)).toEqual([]);
    expect(parseSkyPresets(Buffer.from('skpNTEXTÿÿÿÿ', 'latin1'), dir)).toEqual([]);
  });

  it('returns [] when there is no presets folder', () => {
    expect(loadSkyPresets(null)).toEqual([]);
    expect(loadSkyPresets(join(dir, 'missing'))).toEqual([]);
  });
});

describe('findSkyPresetsDir', () => {
  it('picks the newest Windows install that has a Skies.psp', () => {
    const adobe = join(dir, 'Adobe');
    writeSkies(
      join(adobe, 'Adobe Photoshop 2025', 'Adobe Photoshop 2025 Settings', 'Sky_Presets'),
      []
    );
    writeSkies(
      join(adobe, 'Adobe Photoshop 2026', 'Adobe Photoshop 2026 Settings', 'Sky_Presets'),
      []
    );
    mkdirSync(join(adobe, 'Adobe Photoshop 2027'), { recursive: true }); // installed, never launched
    mkdirSync(join(adobe, 'Adobe Photoshop (Beta)'), { recursive: true });
    expect(findSkyPresetsDir({ APPDATA: dir }, 'win32', 'unused')).toBe(
      join(adobe, 'Adobe Photoshop 2026', 'Adobe Photoshop 2026 Settings', 'Sky_Presets')
    );
  });

  it('looks in ~/Library/Preferences on macOS', () => {
    const prefs = join(dir, 'Library', 'Preferences');
    writeSkies(join(prefs, 'Adobe Photoshop 2026 Settings', 'Sky_Presets'), []);
    expect(findSkyPresetsDir({}, 'darwin', dir)).toBe(
      join(prefs, 'Adobe Photoshop 2026 Settings', 'Sky_Presets')
    );
  });

  it('returns null when nothing is installed', () => {
    expect(findSkyPresetsDir({}, 'win32', dir)).toBeNull();
    expect(findSkyPresetsDir({ APPDATA: dir }, 'win32', dir)).toBeNull();
    expect(findSkyPresetsDir({}, 'linux', dir)).toBeNull();
  });
});

describe('matchSkyPreset and defaultSkyPreset', () => {
  const skies: SkyPreset[] = [
    { name: 'Blue Sky 000 by Rick Mandia', file: 'a' },
    { name: 'Blue Sky 001 by Photoshop', file: 'b' },
    { name: 'Blue Sky 002 by Rick Mandia', file: 'c' },
    { name: 'Spectacular 004 by Russell Brown', file: 'd' },
    { name: 'Sunset Sky 003 by Russell Brown', file: 'e' },
    { name: 'My Lake Sky', file: 'f' },
  ];

  it.each([
    ['Blue Sky 002 by Rick Mandia', 'c'],
    ['blue sky 002', 'c'],
    ['Blue Sky 2', 'c'],
    ['bluesky002', 'c'],
    ['Spectacular 4', 'd'],
    ['Sunset 3', 'e'],
    ['Sunset Sky 003', 'e'],
    ['my lake', 'f'],
  ])('%s -> %s', (query, file) => {
    expect(matchSkyPreset(skies, query)?.file).toBe(file);
  });

  it('finds nothing for an unknown or empty name', () => {
    expect(matchSkyPreset(skies, 'Storm 9')).toBeUndefined();
    expect(matchSkyPreset(skies, 'Blue Sky 9')).toBeUndefined();
    expect(matchSkyPreset(skies, '  ')).toBeUndefined();
  });

  it("defaults to Photoshop's own blue sky, then any blue sky, then the first", () => {
    expect(defaultSkyPreset(skies)?.file).toBe('b');
    expect(defaultSkyPreset(skies.filter((s) => s.file !== 'b'))?.file).toBe('a');
    expect(defaultSkyPreset([skies[5]])?.file).toBe('f');
    expect(defaultSkyPreset([])).toBeUndefined();
  });
});
