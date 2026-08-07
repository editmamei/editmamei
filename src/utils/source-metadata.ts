import { readExif } from './exif-reader.js';
import { Logger } from './logger.js';

/**
 * Node-side metadata reader.
 *
 * Photoshop's DocumentInfo exposes some EXIF/IPTC but normalizes or drops
 * fields when it loads RAW/HEIC. Reading the source file directly with the
 * vendored `exif-reader` returns the untouched camera/lens/exposure block
 * plus the XMP crs:* ACR fields. The handler merges this with the DOM-side
 * data so the LLM sees a complete metadata picture in one call.
 *
 * Format coverage:
 *  - JPEG / TIFF / DNG — full EXIF + GPS + XMP-crs read by the vendored
 *    parser (see `exif-reader.ts`).
 *  - HEIC / vendor RAW (NEF, CR2, CR3, ARW, etc.) — parser returns null;
 *    the handler in `metadata-tools.ts` falls back to PS's already-parsed
 *    `doc.info.exif` so camera basics still surface.
 */

export interface CameraMetadata {
  make?: string;
  model?: string;
  lens?: string;
  datetime_original?: string;
  exposure_time?: string;
  f_number?: number;
  iso?: number;
  focal_length?: number;
  focal_length_35mm?: number;
  white_balance?: string;
  flash?: string;
  orientation?: number;
}

export interface GpsMetadata {
  lat?: number;
  lon?: number;
  altitude?: number;
}

export interface AcrMetadata {
  white_balance?: string;
  temperature?: number;
  tint?: number;
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  vibrance?: number;
  saturation?: number;
  clarity?: number;
  dehaze?: number;
  sharpness?: number;
  noise_reduction?: number;
}

export interface SourceMetadata {
  available: true;
  source_file: string;
  camera: CameraMetadata;
  gps?: GpsMetadata;
  acr?: AcrMetadata;
}

export interface SourceMetadataUnavailable {
  available: false;
  reason: string;
  source_file?: string;
}

const logger = new Logger('SourceMetadata');

/**
 * Read camera/GPS/ACR metadata from the source file directly. Returns a
 * tagged-union result so the caller can render a sensible message when the
 * file is missing or the format isn't supported by the vendored parser.
 */
export async function readSourceMetadata(
  filePath: string | null | undefined
): Promise<SourceMetadata | SourceMetadataUnavailable> {
  if (!filePath) {
    return { available: false, reason: 'no_source_path' };
  }

  let parsed: Record<string, unknown> | null;
  try {
    parsed = await readExif(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`exif read failed for ${filePath}: ${msg}`);
    return { available: false, reason: `exif_error: ${msg}`, source_file: filePath };
  }

  if (parsed === null) {
    return { available: false, reason: 'unsupported_format', source_file: filePath };
  }
  if (Object.keys(parsed).length === 0) {
    return { available: false, reason: 'no_metadata_found', source_file: filePath };
  }

  return {
    available: true,
    source_file: filePath,
    camera: extractCamera(parsed),
    ...extractGps(parsed),
    ...extractAcr(parsed),
  };
}

function extractCamera(d: Record<string, unknown>): CameraMetadata {
  const out: CameraMetadata = {};
  if (str(d.Make)) out.make = str(d.Make);
  if (str(d.Model)) out.model = str(d.Model);
  if (str(d.LensModel)) out.lens = str(d.LensModel);
  else if (str(d.Lens)) out.lens = str(d.Lens);
  if (d.DateTimeOriginal) out.datetime_original = isoDate(d.DateTimeOriginal);
  if (num(d.ExposureTime) !== undefined) out.exposure_time = formatExposure(num(d.ExposureTime)!);
  if (num(d.FNumber) !== undefined) out.f_number = num(d.FNumber);
  if (num(d.ISO) !== undefined) out.iso = num(d.ISO);
  if (num(d.FocalLength) !== undefined) out.focal_length = num(d.FocalLength);
  if (num(d.FocalLengthIn35mmFormat) !== undefined) {
    out.focal_length_35mm = num(d.FocalLengthIn35mmFormat);
  }
  if (d.WhiteBalance !== undefined) out.white_balance = String(d.WhiteBalance);
  if (d.Flash !== undefined) out.flash = String(d.Flash);
  if (num(d.Orientation) !== undefined) out.orientation = num(d.Orientation);
  return out;
}

function extractGps(d: Record<string, unknown>): { gps?: GpsMetadata } {
  const lat = num(d.latitude ?? d.GPSLatitude);
  const lon = num(d.longitude ?? d.GPSLongitude);
  const alt = num(d.GPSAltitude);
  if (lat === undefined && lon === undefined && alt === undefined) return {};
  const gps: GpsMetadata = {};
  if (lat !== undefined) gps.lat = lat;
  if (lon !== undefined) gps.lon = lon;
  if (alt !== undefined) gps.altitude = alt;
  return { gps };
}

function extractAcr(d: Record<string, unknown>): { acr?: AcrMetadata } {
  // The vendored reader surfaces XMP crs:* attributes under the `crs` key.
  // Older `exifr`-shaped callers also passed flattened `crs:X` keys at the
  // top level, so we keep both lookup paths for forward-compat with any
  // payload variants that show up.
  const acrRaw = (d.crs as Record<string, unknown> | undefined) ?? {};
  const out: AcrMetadata = {};
  const grab = (k: string): unknown => acrRaw[k] ?? d[`crs:${k}`] ?? d[k];

  if (str(grab('WhiteBalance'))) out.white_balance = str(grab('WhiteBalance'));
  if (num(grab('Temperature')) !== undefined) out.temperature = num(grab('Temperature'));
  if (num(grab('Tint')) !== undefined) out.tint = num(grab('Tint'));
  if (num(grab('Exposure2012')) !== undefined) out.exposure = num(grab('Exposure2012'));
  else if (num(grab('Exposure')) !== undefined) out.exposure = num(grab('Exposure'));
  if (num(grab('Contrast2012')) !== undefined) out.contrast = num(grab('Contrast2012'));
  if (num(grab('Highlights2012')) !== undefined) out.highlights = num(grab('Highlights2012'));
  if (num(grab('Shadows2012')) !== undefined) out.shadows = num(grab('Shadows2012'));
  if (num(grab('Whites2012')) !== undefined) out.whites = num(grab('Whites2012'));
  if (num(grab('Blacks2012')) !== undefined) out.blacks = num(grab('Blacks2012'));
  if (num(grab('Vibrance')) !== undefined) out.vibrance = num(grab('Vibrance'));
  if (num(grab('Saturation')) !== undefined) out.saturation = num(grab('Saturation'));
  if (num(grab('Clarity2012')) !== undefined) out.clarity = num(grab('Clarity2012'));
  if (num(grab('Dehaze')) !== undefined) out.dehaze = num(grab('Dehaze'));
  if (num(grab('Sharpness')) !== undefined) out.sharpness = num(grab('Sharpness'));
  if (num(grab('LuminanceSmoothing')) !== undefined) {
    out.noise_reduction = num(grab('LuminanceSmoothing'));
  }

  return Object.keys(out).length > 0 ? { acr: out } : {};
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isoDate(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return undefined;
}

/**
 * Format a decimal shutter speed as a human-readable fraction or seconds
 * (e.g. 0.004 → "1/250", 2 → "2"). Photographers expect this form.
 */
function formatExposure(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds);
  if (seconds >= 1) return String(seconds);
  const denom = Math.round(1 / seconds);
  return `1/${denom}`;
}
