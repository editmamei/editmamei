import { ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { validateArgs, ValidationError, type JsonSchemaObject } from '../utils/validate.js';
import { readSourceMetadata } from '../utils/source-metadata.js';
import { toolErrorResult } from '../utils/tool-helpers.js';

// get_metadata was merged into ps_inspect(what='metadata') on
// 2026-06-26 (Phase 1b). This module no longer registers a tool factory; it
// exports the handler + schema that inspect-tools.ts dispatches to.

const ALL_SECTIONS = ['document', 'iptc', 'camera', 'gps', 'acr', 'context'] as const;
type Section = (typeof ALL_SECTIONS)[number];

export const getMetadataSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      description:
        'Optional subset of sections to return. Omit for all sections. The context block (active doc + layer + selection state) is always returned regardless. Use ["context"] for a cheap orientation call that skips the IPTC traversal and the source-file read.',
      items: { type: 'string', enum: ALL_SECTIONS as unknown as string[] },
    },
  },
};

interface DomMetadata {
  document?: { full_path?: string | null; [k: string]: unknown };
  iptc?: Record<string, unknown>;
  dom_exif?: Record<string, string>;
  context: Record<string, unknown>;
}

/**
 * Convert PS's `doc.info.exif` (array of [name, value] pairs the snippet
 * has already mapped to a flat object) into a basic camera section. PS
 * uses human-readable spaced names ("Date Time Original", "F-Stop") that
 * differ from the EXIF tag names exifr returns; this maps the common ones
 * so the caller gets a uniform `camera` shape regardless of source.
 *
 * Used as a fallback when readSourceMetadata can't read the file (e.g.
 * filename has '?' which ENOENTs on re-open).
 */
function cameraFromDomExif(domExif: Record<string, string> | undefined): {
  make?: string;
  model?: string;
  lens?: string;
  datetime_original?: string;
  exposure_time?: string;
  f_number?: number;
  iso?: number;
  focal_length?: number;
  orientation?: number;
  white_balance?: string;
  flash?: string;
} | null {
  if (!domExif || Object.keys(domExif).length === 0) return null;
  const grab = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (k in domExif && domExif[k] !== undefined && domExif[k] !== '') return domExif[k];
    }
    return undefined;
  };
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const m = v.match(/-?\d+(\.\d+)?/);
    if (!m) return undefined;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: ReturnType<typeof cameraFromDomExif> = {};
  const make = grab('Make');
  if (make) out!.make = make;
  const model = grab('Model');
  if (model) out!.model = model;
  const lens = grab('Lens Model', 'LensModel', 'Lens');
  if (lens) out!.lens = lens;
  const dto = grab('Date Time Original', 'DateTimeOriginal', 'Date Time');
  if (dto) out!.datetime_original = dto;
  const exp = grab('Exposure Time', 'ExposureTime');
  if (exp) out!.exposure_time = exp;
  const fn = num(grab('F-Stop', 'FNumber', 'Aperture Value'));
  if (fn !== undefined) out!.f_number = fn;
  const iso = num(grab('ISO Speed Ratings', 'ISOSpeedRatings', 'ISO', 'Photographic Sensitivity'));
  if (iso !== undefined) out!.iso = iso;
  const fl = num(grab('Focal Length'));
  if (fl !== undefined) out!.focal_length = fl;
  const o = num(grab('Orientation'));
  if (o !== undefined) out!.orientation = o;
  const wb = grab('White Balance', 'WhiteBalance');
  if (wb) out!.white_balance = wb;
  const fl2 = grab('Flash');
  if (fl2) out!.flash = fl2;
  return out;
}

function parseSections(raw: unknown): Set<Section> {
  if (raw === undefined) return new Set(ALL_SECTIONS);
  if (!Array.isArray(raw)) {
    throw new ValidationError('sections must be an array of strings');
  }
  if (raw.length === 0) {
    throw new ValidationError('sections must contain at least one entry');
  }
  const out = new Set<Section>();
  for (const item of raw) {
    if (typeof item !== 'string' || !ALL_SECTIONS.includes(item as Section)) {
      throw new ValidationError(
        `Invalid section: ${JSON.stringify(item)}. Allowed: ${ALL_SECTIONS.join(', ')}`
      );
    }
    out.add(item as Section);
  }
  return out;
}

export async function getMetadata(
  connection: PhotoshopConnection,
  snippetClient: SnippetClient,
  rawArgs: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const args = validateArgs(getMetadataSchema, rawArgs);
    const sections = parseSections(args.sections);

    const wantsDocument = sections.has('document');
    const wantsIptc = sections.has('iptc');
    const wantsCamera = sections.has('camera');
    const wantsGps = sections.has('gps');
    const wantsAcr = sections.has('acr');
    const needsSourceFile = wantsCamera || wantsGps || wantsAcr;

    // Need full_path to drive exifr, so include the document block when any
    // source-file section is requested even if the caller didn't ask for it.
    const includeDocumentInScript = wantsDocument || needsSourceFile;

    const script = await snippetClient.build('getMetadata', {
      document: includeDocumentInScript,
      iptc: wantsIptc,
      // dom_exif is the in-doc EXIF PS already parsed. Always pull it when
      // the caller asked for camera/gps/acr so we have a fallback if the
      // source file can't be re-opened (filename special chars, file
      // moved/deleted, etc).
      dom_exif: wantsCamera,
    });
    const dom = (await runScript(connection, script)) as DomMetadata;

    // Context is always returned regardless of `sections` — get_* tools ARE
    // the context, and skipping it would leave the LLM blind.
    const out: Record<string, unknown> = { context: dom.context };
    if (wantsDocument && dom.document) out.document = dom.document;
    if (wantsIptc && dom.iptc) out.iptc = dom.iptc;

    if (needsSourceFile) {
      const sourcePath = dom?.document?.full_path ?? null;
      const source = await readSourceMetadata(sourcePath);
      if (source.available) {
        if (wantsCamera) out.camera = source.camera;
        if (wantsGps && source.gps) out.gps = source.gps;
        if (wantsAcr && source.acr) out.acr = source.acr;
        out.source_metadata = {
          available: true,
          source_file: source.source_file,
          source: 'exifr',
        };
      } else {
        // Source file unreadable. Fall back to PS's already-parsed
        // doc.info.exif so the LLM still gets camera basics. ACR/GPS
        // are not available from this path — PS doesn't surface the
        // crs:* fields here.
        let fallbackUsed = false;
        if (wantsCamera) {
          const cameraFallback = cameraFromDomExif(dom.dom_exif);
          if (cameraFallback) {
            out.camera = cameraFallback;
            fallbackUsed = true;
          }
        }
        out.source_metadata = {
          available: false,
          reason: source.reason,
          source_file: source.source_file ?? null,
          source: fallbackUsed ? 'dom_exif_fallback' : 'none',
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Metadata:\n${JSON.stringify(out, null, 2)}`,
        },
      ],
      structuredContent: out,
    };
  } catch (error) {
    return toolErrorResult('Error getting metadata', error);
  }
}
