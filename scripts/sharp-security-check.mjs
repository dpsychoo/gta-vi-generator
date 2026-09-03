import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { File } from 'node:buffer';
import sharp from 'sharp';
import {
  INVALID_IMAGE_MESSAGE,
  validateImageFile,
} from '../src/lib/image-validation.js';

const createJobSource = await readFile(new URL('../src/pages/api/create-job.ts', import.meta.url), 'utf8');
const validationIndex = createJobSource.indexOf('validateImageFile(file');
const createJobIndex = createJobSource.indexOf('const job = await createJob');
const paymentIndex = createJobSource.indexOf('const payment = await createMercadoPagoPreference');

assert.notEqual(validationIndex, -1, 'create-job must validate uploaded files');
assert(validationIndex < createJobIndex, 'image validation must happen before job creation');
assert(validationIndex < paymentIndex, 'image validation must happen before payment preference creation');
assert(createJobSource.includes("'VipsForeignLoadNsgif'"), 'GIF decoder must be blocked');
assert(createJobSource.includes("'VipsForeignLoadTiff'"), 'TIFF decoder must be blocked');
assert(createJobSource.includes("'VipsForeignLoadVips'"), 'VIPS decoder must be blocked');

const generated = {
  jpeg: await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).jpeg().toBuffer(),
  png: await sharp({ create: { width: 1, height: 1, channels: 4, background: '#00000000' } }).png().toBuffer(),
  webp: await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).webp().toBuffer(),
  tiff: await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).tiff().toBuffer(),
};

for (const format of ['jpeg', 'png', 'webp']) {
  let decoderCalls = 0;
  const result = await validateImageFile(
    new File([generated[format]], `valid.${format}`, { type: `image/${format}` }),
    async (buffer) => {
      decoderCalls += 1;
      return sharp(buffer).metadata();
    },
  );
  assert.equal(result.valid, true, `${format} should be accepted`);
  assert.equal(decoderCalls, 1, `${format} should reach sharp after signature validation`);
}

const invalidCases = [
  ['random bytes declared as PNG', 'image/png', Buffer.from('not an image')],
  ['TIFF declared as PNG', 'image/png', generated.tiff],
  ['JPEG declared as PNG', 'image/png', generated.jpeg],
];

for (const [name, mime, bytes] of invalidCases) {
  let decoderCalls = 0;
  const result = await validateImageFile(
    new File([bytes], 'invalid.bin', { type: mime }),
    async () => {
      decoderCalls += 1;
      throw new Error('invalid input must not reach sharp');
    },
  );
  assert.equal(result.valid, false, `${name} should be rejected`);
  assert.equal(result.error, INVALID_IMAGE_MESSAGE, `${name} should use the customer-safe message`);
  assert.equal(decoderCalls, 0, `${name} must not reach sharp`);
}

assert.equal(typeof sharp.block, 'function', 'sharp.block must be available in sharp 0.35.3');
assert.equal((await sharp(generated.tiff).metadata()).format, 'tiff', 'test TIFF fixture must be valid');
sharp.block({
  operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips'],
});
await assert.rejects(() => sharp(generated.tiff).metadata(), /unsupported image format/i, 'TIFF decoder should be blocked');

console.log('sharp security checks passed');
