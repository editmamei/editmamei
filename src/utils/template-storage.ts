import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Logger } from './logger.js';

/**
 * Disk layout, read/write, and slug sanitization for the Editmamei template
 * system (Phase 3 + 4). Templates live at:
 *
 *   ~/.editmamei/templates/<slug>/
 *     template.md      ← Claude-authored markdown with YAML frontmatter
 *     before.jpg       ← history[0] preview (JPEG q8, 1500px long edge)
 *     after.jpg        ← current-state preview (JPEG q8, 1500px long edge)
 *     evidence.json    ← session log slice + history states + metadata snapshot
 *
 * Slug rules (locked):
 *   - Lowercase
 *   - [^a-z0-9]+ collapses to '-'
 *   - Leading/trailing '-' stripped
 *   - Result must be non-empty (else throw)
 *   - Max length 64 chars (truncate with trailing '-' stripped)
 */

const logger = new Logger('TemplateStorage');

const MAX_SLUG_LEN = 64;

export interface TemplateDescriptor {
  slug: string;
  display_name: string;
  intent: string;
  created: string;
  source_camera: string;
  tags: string[];
}

export interface TemplateBundle {
  md: string;
  beforeJpeg: Buffer;
  afterJpeg: Buffer;
  evidence: unknown;
  /**
   * Pre-validated signature.json content (Templates roadmap Phase 2).
   * Optional — templates without signatures remain fully usable; verify
   * just reports that no signature exists. The caller (template_save) is
   * responsible for strict validation BEFORE handing the string here;
   * storage writes it verbatim.
   */
  signatureJson?: string;
}

export interface WriteResult {
  path: string;
  files_written: string[];
}

export interface TemplateStorageOptions {
  /** Override the default ~/.editmamei/templates/ root (used in tests). */
  root?: string;
}

/**
 * Normalize a free-form template name into a filesystem-safe slug.
 * Throws if the result would be empty.
 *
 *   "Warm Portrait"       → "warm-portrait"
 *   "Foo / Bar"           → "foo-bar"
 *   "  ___MAGIC___  "     → "magic"
 *   "!!!"                 → throws
 */
export function sanitizeTemplateName(input: string): string {
  if (typeof input !== 'string') {
    throw new Error(`template name must be a string; got ${typeof input}`);
  }
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_SLUG_LEN) {
    slug = slug.slice(0, MAX_SLUG_LEN).replace(/-+$/g, '');
  }
  if (slug.length === 0) {
    throw new Error(`template name "${input}" sanitizes to an empty slug; use letters/numbers`);
  }
  return slug;
}

export function templatesRoot(opts: TemplateStorageOptions = {}): string {
  return opts.root ?? join(homedir(), '.editmamei', 'templates');
}

export function templatePath(slug: string, opts: TemplateStorageOptions = {}): string {
  return join(templatesRoot(opts), slug);
}

export async function templateExists(
  slug: string,
  opts: TemplateStorageOptions = {}
): Promise<boolean> {
  try {
    await readFile(join(templatePath(slug, opts), 'template.md'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a template bundle to disk. Returns the directory path and the list
 * of files written. If `overwrite` is false and the template exists, throws.
 */
export async function writeTemplate(
  slug: string,
  bundle: TemplateBundle,
  overwrite: boolean,
  opts: TemplateStorageOptions = {}
): Promise<WriteResult> {
  const exists = await templateExists(slug, opts);
  if (exists && !overwrite) {
    throw new Error(`template "${slug}" already exists; pass overwrite=true to replace`);
  }
  const dir = templatePath(slug, opts);
  await mkdir(dir, { recursive: true });

  const filesWritten: string[] = [];
  const mdPath = join(dir, 'template.md');
  await writeFile(mdPath, bundle.md, 'utf8');
  filesWritten.push(mdPath);

  const beforePath = join(dir, 'before.jpg');
  await writeFile(beforePath, bundle.beforeJpeg);
  filesWritten.push(beforePath);

  const afterPath = join(dir, 'after.jpg');
  await writeFile(afterPath, bundle.afterJpeg);
  filesWritten.push(afterPath);

  const evidencePath = join(dir, 'evidence.json');
  await writeFile(evidencePath, JSON.stringify(bundle.evidence, null, 2), 'utf8');
  filesWritten.push(evidencePath);

  if (bundle.signatureJson !== undefined) {
    const signaturePath = join(dir, 'signature.json');
    await writeFile(signaturePath, bundle.signatureJson, 'utf8');
    filesWritten.push(signaturePath);
  }

  return { path: dir, files_written: filesWritten };
}

/**
 * Read a template's signature.json verbatim. Returns null when the template
 * has no signature (the common case for pre-Phase-2 templates) — callers
 * distinguish "no signature" from "template missing" via templateExists.
 */
export async function readSignature(
  slug: string,
  opts: TemplateStorageOptions = {}
): Promise<string | null> {
  try {
    return await readFile(join(templatePath(slug, opts), 'signature.json'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read just the markdown body — recall (Phase 3) re-surfaces text sections
 * without paying to load the JPEG buffers that readTemplate pulls in.
 */
export async function readTemplateMd(
  slug: string,
  opts: TemplateStorageOptions = {}
): Promise<string> {
  return readFile(join(templatePath(slug, opts), 'template.md'), 'utf8');
}

export async function readTemplate(
  slug: string,
  opts: TemplateStorageOptions = {}
): Promise<TemplateBundle> {
  const dir = templatePath(slug, opts);
  const [md, beforeJpeg, afterJpeg, evidenceRaw] = await Promise.all([
    readFile(join(dir, 'template.md'), 'utf8'),
    readFile(join(dir, 'before.jpg')),
    readFile(join(dir, 'after.jpg')),
    readFile(join(dir, 'evidence.json'), 'utf8'),
  ]);
  let evidence: unknown;
  try {
    evidence = JSON.parse(evidenceRaw);
  } catch (err) {
    logger.warn(`evidence.json for "${slug}" is unparseable: ${(err as Error).message}`);
    evidence = null;
  }
  return { md, beforeJpeg, afterJpeg, evidence };
}

/**
 * Extract one `## <heading>` section from a template's markdown body
 * (Templates roadmap Phase 3 — generalizes the section slicing that
 * parseDescriptor does for Intent).
 *
 * Returns the text between the matched heading line and the next `## `
 * heading (or EOF), trimmed. Heading match is case-insensitive on the
 * full heading text. Returns null when the section is absent — callers
 * distinguish "template has no such section" from "empty section" (which
 * returns '').
 */
export function extractSection(md: string, heading: string): string | null {
  const lines = md.split(/\r?\n/);
  const want = heading.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m && m[1].trim().toLowerCase() === want) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

export async function deleteTemplate(
  slug: string,
  opts: TemplateStorageOptions = {}
): Promise<boolean> {
  const dir = templatePath(slug, opts);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    logger.warn(`deleteTemplate("${slug}") failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Walk the templates directory, parse each template.md's frontmatter, and
 * return descriptors sorted by created-desc. Templates with unreadable or
 * frontmatter-less .md files are skipped (warn). Missing root dir returns [].
 */
export async function listTemplates(
  opts: TemplateStorageOptions = {}
): Promise<TemplateDescriptor[]> {
  const root = templatesRoot(opts);
  let entries: string[];
  try {
    const all = await readdir(root, { withFileTypes: true });
    entries = all.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return [];
    logger.warn(`listTemplates: cannot read ${root}: ${(err as Error).message}`);
    return [];
  }

  // Reads are independent per-slug — parallelize with Promise.all instead of
  // a sequential per-directory await. Order doesn't matter here: the explicit
  // sort below re-orders by `created` regardless of which read settles first.
  const results = await Promise.all(
    entries.map(async (slug): Promise<TemplateDescriptor | null> => {
      try {
        const md = await readFile(join(root, slug, 'template.md'), 'utf8');
        return parseDescriptor(slug, md);
      } catch {
        // template.md missing or unreadable; skip
        return null;
      }
    })
  );
  const out: TemplateDescriptor[] = results.filter((d): d is TemplateDescriptor => d !== null);

  out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return out;
}

/**
 * Hand-rolled YAML frontmatter parser for the fields we use. Avoids adding
 * a js-yaml dep for our fixed, tiny schema. Recognizes:
 *   string scalars:   name: foo
 *   array scalars:    tags: [a, b, c]
 *   nested object:    source_camera: { make: X, model: Y, lens: Z }
 * Anything we don't recognize is silently ignored — the .md is the source
 * of truth for human readers; descriptors are just for listing.
 */
function parseDescriptor(slug: string, md: string): TemplateDescriptor | null {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const front = match[1];

  const grab = (key: string): string | undefined => {
    const m = front.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1] : undefined;
  };

  const tagsRaw = grab('tags');
  const tags: string[] = [];
  if (tagsRaw) {
    const arr = tagsRaw.match(/^\[(.*)\]$/);
    if (arr) {
      for (const t of arr[1].split(',')) {
        const trimmed = t.trim();
        if (trimmed) tags.push(trimmed);
      }
    }
  }

  // source_camera can be inline {...} or nested across multiple lines.
  // For the inline form, try to extract make + model + lens. Locals are
  // named `makeMatch` / `modelMatch` / `lensMatch` rather than `mk`/`md`
  // /`ln` so the inner `md` doesn't shadow the outer `md: string` function
  // parameter — caught in the 2026-06-07 audit as a read-confusion trap
  // (a maintainer scanning here for "the markdown" would land on the
  // model-regex match instead).
  const cameraRaw = grab('source_camera');
  let sourceCamera = '';
  if (cameraRaw) {
    const inline = cameraRaw.match(/^\{(.+)\}$/);
    if (inline) {
      const parts: string[] = [];
      const makeMatch = inline[1].match(/make:\s*([^,}]+)/i);
      const modelMatch = inline[1].match(/model:\s*([^,}]+)/i);
      const lensMatch = inline[1].match(/lens:\s*([^,}]+)/i);
      if (makeMatch) parts.push(makeMatch[1].trim().replace(/^["']|["']$/g, ''));
      if (modelMatch) parts.push(modelMatch[1].trim().replace(/^["']|["']$/g, ''));
      if (lensMatch) parts.push(lensMatch[1].trim().replace(/^["']|["']$/g, ''));
      sourceCamera = parts.join(' ');
    } else {
      sourceCamera = cameraRaw;
    }
  }

  // Intent = first paragraph of the first `## Intent` section.
  let intent = '';
  const intentSection = md.match(/^##\s+Intent\s*\n+([\s\S]+?)(?:\n##\s|$)/m);
  if (intentSection) {
    intent = intentSection[1]
      .trim()
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    slug,
    display_name: grab('display_name') ?? grab('name') ?? slug,
    intent,
    created: grab('created') ?? '',
    source_camera: sourceCamera,
    tags,
  };
}
