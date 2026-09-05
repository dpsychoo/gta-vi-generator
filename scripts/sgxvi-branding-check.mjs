import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const require = createRequire(import.meta.url);

const helperBundle = await build({
  stdin: {
    contents: "export * from './src/lib/sgxvi-branding.ts';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
});
const helperContext = { module: { exports: {} }, exports: {}, require };
runInNewContext(helperBundle.outputFiles[0].text, helperContext);
const { formatSgxviPurchaseNumber, PROJECT_PASS_DISPLAY_NAME, PROJECT_PURCHASE_PREFIX } = helperContext.module.exports;

assert.equal(PROJECT_PASS_DISPLAY_NAME, 'SGX · VI PASS');
assert.equal(PROJECT_PURCHASE_PREFIX, 'SGXVI PURCHASE');
assert.equal(formatSgxviPurchaseNumber('1'), 'SGXVI PURCHASE #000001');
assert.equal(formatSgxviPurchaseNumber('4'), 'SGXVI PURCHASE #000004');
assert.equal(formatSgxviPurchaseNumber('100'), 'SGXVI PURCHASE #000100');
assert.equal(formatSgxviPurchaseNumber('999999'), 'SGXVI PURCHASE #999999');
assert.equal(formatSgxviPurchaseNumber('1000000'), 'SGXVI PURCHASE #1000000');
assert.equal(formatSgxviPurchaseNumber(null), null);
assert.equal(formatSgxviPurchaseNumber(undefined), null);
assert.equal(formatSgxviPurchaseNumber('0'), null);

const purchaseEmailSource = read('src/emails/PurchaseConfirmationEmail.tsx');
const resultEmailSource = read('src/emails/GtaResultEmail.tsx');
const resultPageSource = read('src/pages/resultado.astro');
const statusSource = read('src/pages/api/job-status.ts');
const orderSource = read('src/lib/sgx-pass.ts');
const emailSource = read('src/lib/email.ts');

assert(purchaseEmailSource.includes('sgxPassCode?: string | null'));
assert(resultEmailSource.includes('PROJECT_PASS_DISPLAY_NAME'));
assert(resultEmailSource.includes('purchaseNumber?: string | null'));
assert(resultPageSource.includes('SGX · VI PASS'));
assert(resultPageSource.includes('job.purchase_number'));
assert(resultPageSource.includes('formatSgxviPurchaseNumber(purchaseNumber)'));
assert(statusSource.includes("getSgxOrderByJobId(job.id)"));
assert(statusSource.includes('purchase_number: purchaseNumber'));
assert(orderSource.includes('purchaseNumber: row.purchase_number'));
assert(emailSource.includes('purchaseNumber,'));
assert(emailSource.includes('sgxPassCode'));
assert(!purchaseEmailSource.includes('purchaseNumber?: string | null'));
assert(!purchaseEmailSource.includes('formatSgxviPurchaseNumber'));
for (const source of [purchaseEmailSource, resultEmailSource, resultPageSource, statusSource]) {
  assert(!source.includes('SGX PASS'));
  assert(!source.includes('purchase_queue_position'));
}

const statusBundle = await build({
  stdin: {
    contents: "export { GET } from './src/pages/api/job-status.ts';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  plugins: [{
    name: 'offline-status-services',
    setup(builder) {
      const replacements = new Map([
        ['job-access', "export const verifyJobAccess = () => true;"],
        ['job-store', "export const getJob = () => globalThis.__statusJob;"],
        ['sgx-pass', "export const getSgxPassById = () => globalThis.__statusPass; export const getSgxOrderByJobId = () => globalThis.__statusOrder;"],
      ]);
      builder.onResolve({ filter: /job-access$|job-store$|sgx-pass$/ }, (args) => ({
        path: args.path.endsWith('job-access') ? 'job-access' : args.path.endsWith('job-store') ? 'job-store' : 'sgx-pass',
        namespace: 'offline-status',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'offline-status' }, (args) => ({
        contents: replacements.get(args.path),
        loader: 'ts',
      }));
    },
  }],
});
const statusContext = {
  module: { exports: {} },
  exports: {},
  require,
  Request,
  Response,
  URL,
  __statusJob: { id: 'offline-job', status: 'completed', paymentStatus: 'approved', sgxPassId: 'offline-pass' },
  __statusPass: { publicCode: 'SGX-VI-DDXJ-7A8M', status: 'active' },
  __statusOrder: { purchaseNumber: '1000000' },
};
runInNewContext(statusBundle.outputFiles[0].text, statusContext);
const statusResponse = await statusContext.module.exports.GET({
  url: new URL('https://example.invalid/api/job-status?jobId=offline-job&token=offline-token'),
});
const statusPayload = await statusResponse.json();
assert.equal(statusPayload.purchase_number, '1000000');
assert.equal(statusPayload.sgxPass.code, 'SGX-VI-DDXJ-7A8M');
assert(!JSON.stringify(statusPayload).includes('purchase_queue_position'));
assert(!JSON.stringify(statusPayload).includes('payment_id'));
statusContext.__statusOrder = { purchaseNumber: null };
const nullStatusResponse = await statusContext.module.exports.GET({
  url: new URL('https://example.invalid/api/job-status?jobId=offline-job&token=offline-token'),
});
assert.equal((await nullStatusResponse.json()).purchase_number, null);

const componentBundle = await build({
  stdin: {
    contents: [
      "export { PurchaseConfirmationEmail } from './src/emails/PurchaseConfirmationEmail.tsx';",
      "export { GtaResultEmail } from './src/emails/GtaResultEmail.tsx';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
});
const componentContext = {
  module: { exports: {} },
  exports: {},
  require,
  process,
  console,
};
runInNewContext(componentBundle.outputFiles[0].text, componentContext);
const { PurchaseConfirmationEmail, GtaResultEmail } = componentContext.module.exports;
const { createElement } = require('react');
const { render } = await import('react-email');

const sharedResultProps = {
  customerName: null,
  customerEmail: 'offline@example.invalid',
  resultImageUrl: 'https://example.invalid/result.png',
  downloadUrl: 'https://example.invalid/result',
  orderId: 'offline-job',
  createdAt: '2026-09-05',
  generatorUrl: 'https://example.invalid/',
  sgxPassCode: 'SGX-VI-DDXJ-7A8M',
  sgxPassStatus: 'active',
};
const sharedConfirmationProps = {
  customerEmail: 'offline@example.invalid',
  orderId: 'offline-order',
  paymentId: '123',
  approvedAt: '2026-09-05',
  termsVersion: 'terms-v1',
  privacyVersion: 'privacy-v1',
  refundPolicyVersion: 'refund-v1',
  termsUrl: 'https://example.invalid/terms',
  privacyUrl: 'https://example.invalid/privacy',
  refundsUrl: 'https://example.invalid/refunds',
  legalUrl: 'https://example.invalid/legal',
  sgxPassCode: 'SGX-VI-DDXJ-7A8M',
};

const resultWithNumber = await render(createElement(GtaResultEmail, { ...sharedResultProps, purchaseNumber: '4' }));
const resultWithoutNumber = await render(createElement(GtaResultEmail, { ...sharedResultProps, purchaseNumber: null }));
const confirmation = await render(createElement(PurchaseConfirmationEmail, sharedConfirmationProps));

for (const html of [resultWithNumber]) {
  assert(html.includes('SGX · VI PASS'));
  assert(html.includes('SGXVI PURCHASE #000004'));
}
for (const html of [resultWithoutNumber, confirmation]) {
  assert(html.includes('SGX · VI PASS'));
  assert(!html.includes('SGXVI PURCHASE'));
}
assert(confirmation.includes('SGX-VI-DDXJ-7A8M'));

console.log('PASS: SGXVI branding offline checks');
console.log('- exact SGX · VI PASS branding');
console.log('- purchase formatting, null omission and >999999 preservation');
console.log('- confirmation branding without purchase_number; result email with and without it');
console.log('- result API/UI purchase propagation');
console.log('- queue position and internal commercial fields excluded');
