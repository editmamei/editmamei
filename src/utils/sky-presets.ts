/**
 * Photoshop's built-in skies, by name.
 *
 * Sky Replacement takes an image path. Photoshop keeps its skies as GUID-named .jpg files in the
 * Sky_Presets folder of its settings directory, and their names only exist inside Skies.psp, a
 * binary preset file next to them. Reading that file here lets ps_replace_sky take "Blue Sky 002"
 * instead of a path the model would otherwise have to go and look for.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SkyPreset {
  /** Display name, e.g. "Blue Sky 002 by Rick Mandia". */
  name: string;
  /** Absolute path of the sky image. */
  file: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_KEY = Buffer.from('skpNTEXT', 'latin1');
const ID_KEY = Buffer.from('SzidTEXT', 'latin1');

/** "BlueSky002byRickMandia" -> "Blue Sky 002 by Rick Mandia"; names that already have spaces pass through. */
export function prettySkyName(raw: string): string {
  return raw
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Entries of a Skies.psp buffer whose image exists in `dir`. Each sky is a `skpN` TEXT field (its
 * name) followed by a `Szid` TEXT field (the GUID its .jpg is named by). A TEXT value is a 4-byte
 * big-endian count of UTF-16BE code units, the last of them a null.
 */
export function parseSkyPresets(buf: Buffer, dir: string): SkyPreset[] {
  const readText = (at: number): { text: string; end: number } | null => {
    if (at + 4 > buf.length) return null;
    const units = buf.readUInt32BE(at);
    const end = at + 4 + units * 2;
    if (units === 0 || units > 512 || end > buf.length) return null;
    let text = '';
    for (let i = at + 4; i < end; i += 2) {
      const unit = buf.readUInt16BE(i);
      if (unit === 0) break; // the terminator
      text += String.fromCharCode(unit);
    }
    return { text, end };
  };
  const out: SkyPreset[] = [];
  for (
    let pos = buf.indexOf(NAME_KEY);
    pos !== -1;
    pos = buf.indexOf(NAME_KEY, pos + NAME_KEY.length)
  ) {
    const name = readText(pos + NAME_KEY.length);
    if (!name) continue;
    // The id field follows the name directly: a 4-byte key length, then `SzidTEXT`. Look only
    // there, so a name without an id never takes the next sky's.
    const rel = buf.subarray(name.end, name.end + 16 + ID_KEY.length).indexOf(ID_KEY);
    if (rel === -1) continue;
    const id = readText(name.end + rel + ID_KEY.length);
    if (!id || !GUID_RE.test(id.text)) continue;
    const file = join(dir, `${id.text}.jpg`);
    if (existsSync(file)) out.push({ name: prettySkyName(name.text), file });
  }
  return out;
}

/**
 * The Sky_Presets folder of the newest Photoshop install that has one, or null. Photoshop names
 * its settings folder by release year: `%APPDATA%\Adobe\Adobe Photoshop 2026\Adobe Photoshop 2026
 * Settings` on Windows, `~/Library/Preferences/Adobe Photoshop 2026 Settings` on macOS.
 */
export function findSkyPresetsDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir()
): string | null {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  let candidates: { year: number; dir: string }[] = [];
  if (platform === 'win32') {
    if (!env.APPDATA) return null;
    const base = join(env.APPDATA, 'Adobe');
    candidates = list(base).flatMap((d) => {
      const m = /^Adobe Photoshop (\d{4})$/.exec(d);
      return m ? [{ year: +m[1], dir: join(base, d, `${d} Settings`, 'Sky_Presets') }] : [];
    });
  } else if (platform === 'darwin') {
    const base = join(home, 'Library', 'Preferences');
    candidates = list(base).flatMap((d) => {
      const m = /^Adobe Photoshop (\d{4}) Settings$/.exec(d);
      return m ? [{ year: +m[1], dir: join(base, d, 'Sky_Presets') }] : [];
    });
  }
  candidates.sort((a, b) => b.year - a.year);
  return candidates.find((c) => existsSync(join(c.dir, 'Skies.psp')))?.dir ?? null;
}

/** The installed skies, or [] when no Photoshop sky presets can be found on this machine. */
export function loadSkyPresets(dir: string | null = findSkyPresetsDir()): SkyPreset[] {
  if (!dir) return [];
  try {
    return parseSkyPresets(readFileSync(join(dir, 'Skies.psp')), dir);
  } catch {
    return [];
  }
}

// Letters and digits in any script, so a sky the user saved under a non-Latin name still matches.
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const familyAndNumber = (s: string) => {
  const m = /^(\p{L}+?)(\d+)/u.exec(norm(s));
  return m ? { family: m[1], num: Number(m[2]) } : null;
};

/**
 * The preset `query` names, or undefined. Exact names win, then a family and number ("Sunset 3"
 * finds "Sunset Sky 003 by …", so unpadded numbers and a dropped "Sky" both work), then a prefix.
 */
export function matchSkyPreset(presets: SkyPreset[], query: string): SkyPreset | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const exact = presets.find((p) => norm(p.name) === q);
  if (exact) return exact;
  const want = familyAndNumber(query);
  if (want) {
    const hit = presets.find((p) => {
      const have = familyAndNumber(p.name);
      return have !== null && have.family.startsWith(want.family) && have.num === want.num;
    });
    if (hit) return hit;
  }
  return presets.find((p) => norm(p.name).startsWith(q));
}

/** The sky used when the caller names none: Photoshop's own first blue sky. */
export function defaultSkyPreset(presets: SkyPreset[]): SkyPreset | undefined {
  return (
    presets.find((p) => /^blue sky\b/i.test(p.name) && /\bby photoshop$/i.test(p.name)) ??
    presets.find((p) => /^blue sky\b/i.test(p.name)) ??
    presets[0]
  );
}
