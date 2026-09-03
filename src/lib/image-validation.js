const MIME_TO_FORMAT = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const INVALID_IMAGE_MESSAGE = 'Formato de imagen no válido o no compatible.';

function hasBytes(buffer, expected, offset = 0) {
  if (buffer.length < offset + expected.length) {
    return false;
  }

  return expected.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Detect only the formats accepted by the application from their file signature.
 * @param {Uint8Array} buffer
 * @returns {'jpeg' | 'png' | 'webp' | null}
 */
export function detectImageFormat(buffer) {
  if (hasBytes(buffer, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }

  if (hasBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }

  if (hasBytes(buffer, [0x52, 0x49, 0x46, 0x46]) && hasBytes(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }

  return null;
}

/**
 * Validate the declared MIME and signature before invoking the image decoder.
 * @param {{ size: number, name: string, type: string, arrayBuffer: () => Promise<ArrayBuffer> }} file
 * @param {(buffer: Buffer) => Promise<{ format?: string | null }>} decodeMetadata
 * @returns {Promise<{ valid: true, format: 'jpeg' | 'png' | 'webp' } | { valid: false, error: string }>}
 */
export async function validateImageFile(file, decodeMetadata) {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `El archivo ${file.name} excede 10 MB` };
  }

  const declaredMime = file.type.trim().toLowerCase().split(';', 1)[0];
  const declaredFormat = MIME_TO_FORMAT.get(declaredMime);
  if (!declaredFormat) {
    return { valid: false, error: INVALID_IMAGE_MESSAGE };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedFormat = detectImageFormat(buffer);
  if (!detectedFormat || detectedFormat !== declaredFormat) {
    return { valid: false, error: INVALID_IMAGE_MESSAGE };
  }

  try {
    const metadata = await decodeMetadata(buffer);
    if (metadata?.format !== detectedFormat) {
      return { valid: false, error: INVALID_IMAGE_MESSAGE };
    }
  } catch {
    return { valid: false, error: INVALID_IMAGE_MESSAGE };
  }

  return { valid: true, format: detectedFormat };
}
