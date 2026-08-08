import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeTemplateName,
  readSignature,
  readTemplateMd,
  extractSection,
  writeTemplate,
  readTemplate,
  deleteTemplate,
  listTemplates,
  templateExists,
  templatesRoot,
  templatePath,
} from '@editmamei/utils/template-storage.ts';

describe('sanitizeTemplateName', () => {
  it('lowercases + collapses non-alphanum runs to hyphens', () => {
    expect(sanitizeTemplateName('Warm Portrait')).toBe('warm-portrait');
    expect(sanitizeTemplateName('Foo / Bar')).toBe('foo-bar');
    expect(sanitizeTemplateName('Foo___Bar')).toBe('foo-bar');
    expect(sanitizeTemplateName('  Foo  ')).toBe('foo');
    expect(sanitizeTemplateName('UPPER')).toBe('upper');
  });

  it('strips leading/trailing hyphens', () => {
    expect(sanitizeTemplateName('--foo--')).toBe('foo');
    expect(sanitizeTemplateName('  ___MAGIC___  ')).toBe('magic');
  });

  it('throws on empty-after-sanitize input', () => {
    expect(() => sanitizeTemplateName('!!!')).toThrow(/empty slug/);
    expect(() => sanitizeTemplateName('   ')).toThrow(/empty slug/);
    expect(() => sanitizeTemplateName('-_-')).toThrow(/empty slug/);
    expect(() => sanitizeTemplateName('')).toThrow(/empty slug/);
  });

  it('rejects non-string input', () => {
    expect(() => sanitizeTemplateName(null as unknown as string)).toThrow();
    expect(() => sanitizeTemplateName(42 as unknown as string)).toThrow();
  });

  it('truncates names longer than 64 chars and re-strips trailing hyphens', () => {
    const long = 'a'.repeat(100);
    const slug = sanitizeTemplateName(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('blocks path traversal vectors via sanitization', () => {
    expect(sanitizeTemplateName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeTemplateName('foo/../bar')).toBe('foo-bar');
    expect(sanitizeTemplateName('..\\..\\windows')).toBe('windows');
  });
});

describe('templatesRoot / templatePath', () => {
  it('defaults to ~/.editmamei/templates/', () => {
    const root = templatesRoot();
    expect(root).toMatch(/[\\/]\.editmamei[\\/]templates$/);
  });

  it('honors a custom root', () => {
    const root = templatesRoot({ root: '/tmp/x' });
    expect(root).toBe('/tmp/x');
    expect(templatePath('foo', { root: '/tmp/x' })).toBe(join('/tmp/x', 'foo'));
  });
});

describe('writeTemplate / readTemplate / templateExists', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'editmamei-tpl-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes template.md + before.jpg + after.jpg + evidence.json', async () => {
    const result = await writeTemplate(
      'warm-portrait',
      {
        md: '---\nname: warm-portrait\n---\n## Intent\nA warm look.\n',
        beforeJpeg: Buffer.from([0xff, 0xd8]),
        afterJpeg: Buffer.from([0xff, 0xd8, 0x01]),
        evidence: { session_id: 's1', tool_calls: [] },
      },
      false,
      { root }
    );
    expect(result.files_written).toHaveLength(4);
    expect(result.path).toBe(join(root, 'warm-portrait'));

    const md = await readFile(join(root, 'warm-portrait', 'template.md'), 'utf8');
    expect(md).toContain('warm-portrait');

    expect(await templateExists('warm-portrait', { root })).toBe(true);
    expect(await templateExists('missing', { root })).toBe(false);
  });

  it('roundtrips via readTemplate', async () => {
    const before = Buffer.from([0xff, 0xd8, 0x42]);
    const after = Buffer.from([0xff, 0xd8, 0x99]);
    const evidence = { session_id: 'rt', tool_calls: [{ tool: 'ps_ping' }] };
    await writeTemplate(
      'rt',
      { md: '---\nname: rt\n---\nbody', beforeJpeg: before, afterJpeg: after, evidence },
      false,
      { root }
    );
    const bundle = await readTemplate('rt', { root });
    expect(bundle.md).toBe('---\nname: rt\n---\nbody');
    expect(Buffer.compare(bundle.beforeJpeg, before)).toBe(0);
    expect(Buffer.compare(bundle.afterJpeg, after)).toBe(0);
    expect(bundle.evidence).toEqual(evidence);
  });

  it('errors on collision when overwrite=false', async () => {
    await writeTemplate(
      'c',
      { md: 'v1', beforeJpeg: Buffer.from('a'), afterJpeg: Buffer.from('b'), evidence: {} },
      false,
      { root }
    );
    await expect(
      writeTemplate(
        'c',
        { md: 'v2', beforeJpeg: Buffer.from('a'), afterJpeg: Buffer.from('b'), evidence: {} },
        false,
        { root }
      )
    ).rejects.toThrow(/already exists/);
  });

  it('replaces on collision when overwrite=true', async () => {
    await writeTemplate(
      'c',
      { md: 'v1', beforeJpeg: Buffer.from('a'), afterJpeg: Buffer.from('b'), evidence: {} },
      false,
      { root }
    );
    await writeTemplate(
      'c',
      { md: 'v2', beforeJpeg: Buffer.from('a'), afterJpeg: Buffer.from('b'), evidence: {} },
      true,
      { root }
    );
    const bundle = await readTemplate('c', { root });
    expect(bundle.md).toBe('v2');
  });
});

describe('deleteTemplate', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'editmamei-tpl-del-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('returns true after deleting an existing template', async () => {
    await writeTemplate(
      'd',
      { md: 'x', beforeJpeg: Buffer.from('a'), afterJpeg: Buffer.from('b'), evidence: {} },
      false,
      { root }
    );
    expect(await templateExists('d', { root })).toBe(true);
    expect(await deleteTemplate('d', { root })).toBe(true);
    expect(await templateExists('d', { root })).toBe(false);
  });

  it('is idempotent — deleting a missing template returns true (no error)', async () => {
    expect(await deleteTemplate('does-not-exist', { root })).toBe(true);
  });
});

describe('listTemplates', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'editmamei-tpl-list-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('returns [] when root does not exist', async () => {
    const list = await listTemplates({ root: join(root, 'no-such-dir') });
    expect(list).toEqual([]);
  });

  it('returns [] when root exists but is empty', async () => {
    const list = await listTemplates({ root });
    expect(list).toEqual([]);
  });

  it('lists templates with parsed frontmatter, sorted by created desc', async () => {
    const tpls = [
      {
        slug: 'old',
        md: '---\nname: old\ndisplay_name: Old\ncreated: 2026-01-01T00:00:00Z\ntags: [a, b]\nsource_camera: { make: Apple, model: iPhone 15, lens: 26mm }\n---\n## Intent\nFirst look.\n\nMore detail here.\n## Other\n',
      },
      {
        slug: 'new',
        md: '---\nname: new\ndisplay_name: New\ncreated: 2026-05-27T00:00:00Z\ntags: [c]\n---\n## Intent\nSecond look.\n',
      },
    ];
    for (const t of tpls) {
      await writeTemplate(
        t.slug,
        { md: t.md, beforeJpeg: Buffer.from('a'), afterJpeg: Buffer.from('b'), evidence: {} },
        false,
        { root }
      );
    }

    const list = await listTemplates({ root });
    expect(list).toHaveLength(2);
    expect(list[0].slug).toBe('new'); // newer first
    expect(list[1].slug).toBe('old');

    expect(list[0].display_name).toBe('New');
    expect(list[0].tags).toEqual(['c']);
    expect(list[0].intent).toBe('Second look.');

    expect(list[1].display_name).toBe('Old');
    expect(list[1].tags).toEqual(['a', 'b']);
    expect(list[1].source_camera).toBe('Apple iPhone 15 26mm');
    expect(list[1].intent).toBe('First look.');
  });

  it('skips directories with no template.md (silently)', async () => {
    await mkdir(join(root, 'orphan'), { recursive: true });
    await writeTemplate(
      'ok',
      {
        md: '---\nname: ok\ncreated: 2026-05-27T00:00:00Z\n---\n## Intent\nFine.\n',
        beforeJpeg: Buffer.from('a'),
        afterJpeg: Buffer.from('b'),
        evidence: {},
      },
      false,
      { root }
    );
    const list = await listTemplates({ root });
    expect(list.map((t) => t.slug)).toEqual(['ok']);
  });

  it('skips a template.md without frontmatter', async () => {
    await mkdir(join(root, 'no-front'), { recursive: true });
    const path = join(root, 'no-front', 'template.md');
    await writeTemplate(
      'no-front',
      {
        md: '# just a header, no frontmatter',
        beforeJpeg: Buffer.from('a'),
        afterJpeg: Buffer.from('b'),
        evidence: {},
      },
      false,
      { root }
    );
    const list = await listTemplates({ root });
    expect(list).toEqual([]);
    expect(path).toBeDefined();
  });

  // Reads are now parallelized via Promise.all instead of a sequential
  // per-directory await. Mixes several valid templates
  // (out of created-order on disk) with corrupt entries interspersed
  // alphabetically between them, so a naive Promise.all that just preserved
  // array-iteration order by luck wouldn't be enough to pass — the sort
  // step has to be doing the real work, and a single corrupt/missing entry
  // must not fail (or reorder) the rest of the batch.
  it('preserves created-desc order and skips corrupt entries when reads run in parallel', async () => {
    await mkdir(join(root, 'a-orphan'), { recursive: true }); // no template.md at all
    await writeTemplate(
      'b-oldest',
      {
        md: '---\nname: b-oldest\ndisplay_name: Oldest\ncreated: 2026-01-01T00:00:00Z\n---\n## Intent\nOldest.\n',
        beforeJpeg: Buffer.from('a'),
        afterJpeg: Buffer.from('b'),
        evidence: {},
      },
      false,
      { root }
    );
    await mkdir(join(root, 'c-no-front'), { recursive: true });
    await writeTemplate(
      'c-no-front',
      {
        md: '# no frontmatter here',
        beforeJpeg: Buffer.from('a'),
        afterJpeg: Buffer.from('b'),
        evidence: {},
      },
      false,
      { root }
    );
    await writeTemplate(
      'd-middle',
      {
        md: '---\nname: d-middle\ndisplay_name: Middle\ncreated: 2026-03-01T00:00:00Z\n---\n## Intent\nMiddle.\n',
        beforeJpeg: Buffer.from('a'),
        afterJpeg: Buffer.from('b'),
        evidence: {},
      },
      false,
      { root }
    );
    await writeTemplate(
      'e-newest',
      {
        md: '---\nname: e-newest\ndisplay_name: Newest\ncreated: 2026-05-27T00:00:00Z\n---\n## Intent\nNewest.\n',
        beforeJpeg: Buffer.from('a'),
        afterJpeg: Buffer.from('b'),
        evidence: {},
      },
      false,
      { root }
    );

    const list = await listTemplates({ root });
    // Corrupt/missing entries ('a-orphan', 'c-no-front') are skipped; the
    // three valid templates come back sorted newest-first regardless of
    // their alphabetical (on-disk readdir) order or which parallel read
    // settled first.
    expect(list.map((t) => t.slug)).toEqual(['e-newest', 'd-middle', 'b-oldest']);
  });
});

describe('signature.json storage (Phase 2)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'editmamei-sig-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const bundle = (signatureJson?: string) => ({
    md: '---\nname: t\n---\n## Intent\nx',
    beforeJpeg: Buffer.from([1]),
    afterJpeg: Buffer.from([2]),
    evidence: { ok: true },
    ...(signatureJson !== undefined ? { signatureJson } : {}),
  });

  it('writeTemplate writes signature.json when the bundle carries one', async () => {
    const result = await writeTemplate('with-sig', bundle('{"version":1,"predicates":[]}'), false, {
      root,
    });
    expect(result.files_written.some((f) => f.endsWith('signature.json'))).toBe(true);
    expect(await readSignature('with-sig', { root })).toBe('{"version":1,"predicates":[]}');
  });

  it('writeTemplate without a signature writes the classic 4-file bundle', async () => {
    const result = await writeTemplate('no-sig', bundle(), false, { root });
    expect(result.files_written).toHaveLength(4);
    expect(await readSignature('no-sig', { root })).toBeNull();
  });

  it('readSignature returns null for a missing template (no throw)', async () => {
    expect(await readSignature('never-existed', { root })).toBeNull();
  });
});

describe('extractSection / readTemplateMd (Phase 3)', () => {
  const MD =
    '---\nname: x\n---\n\n## Intent\nThe look.\n\n## Exit criteria\n- a\n- b\n\n## Tune per image\ndials';

  it('extracts a middle section up to the next heading', () => {
    expect(extractSection(MD, 'Exit criteria')).toBe('- a\n- b');
  });

  it('extracts the final section to EOF', () => {
    expect(extractSection(MD, 'Tune per image')).toBe('dials');
  });

  it('heading match is case-insensitive', () => {
    expect(extractSection(MD, 'exit CRITERIA')).toBe('- a\n- b');
  });

  it('returns null for an absent section', () => {
    expect(extractSection(MD, 'Fixed')).toBeNull();
  });

  it('does not match ### subheadings as section boundaries', () => {
    const md = '## Intent\npart one\n### detail\npart two\n## Next\nother';
    expect(extractSection(md, 'Intent')).toBe('part one\n### detail\npart two');
  });

  it('readTemplateMd returns just the markdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'editmamei-readmd-'));
    try {
      await writeTemplate(
        'md-only',
        {
          md: '---\nname: m\n---\n## Intent\nhello',
          beforeJpeg: Buffer.from([1]),
          afterJpeg: Buffer.from([2]),
          evidence: {},
        },
        false,
        { root }
      );
      const md = await readTemplateMd('md-only', { root });
      expect(md).toContain('hello');
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
