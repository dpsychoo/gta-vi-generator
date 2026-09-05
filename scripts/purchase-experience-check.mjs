import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = process.cwd();
const require = createRequire(import.meta.url);
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

const helperBundle = await build({
  stdin: {
    contents: "export * from './src/lib/purchase-milestone.ts';",
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
const { calculateMilestoneProgress } = helperContext.module.exports;

const progressCases = [
  [{ currentPurchaseNumber: 5n, previousMilestoneNumber: 0n, nextMilestoneNumber: 100n }, { percentage: 5, remaining: 95n, reached: false }],
  [{ currentPurchaseNumber: '99', previousMilestoneNumber: '0', nextMilestoneNumber: '100' }, { percentage: 99, remaining: 1n, reached: false }],
  [{ currentPurchaseNumber: 100n, previousMilestoneNumber: 0n, nextMilestoneNumber: 100n }, { percentage: 100, remaining: 0n, reached: true }],
  [{ currentPurchaseNumber: 150n, previousMilestoneNumber: 100n, nextMilestoneNumber: 200n }, { percentage: 50, remaining: 50n, reached: false }],
];
for (const [input, expected] of progressCases) {
  const actual = calculateMilestoneProgress(input);
  assert.equal(actual.percentage, expected.percentage);
  assert.equal(actual.remaining, expected.remaining);
  assert.equal(actual.reached, expected.reached);
}
assert.equal(calculateMilestoneProgress({
  currentPurchaseNumber: 250n,
  previousMilestoneNumber: 100n,
  nextMilestoneNumber: 200n,
}).percentage, 100);
assert.throws(() => calculateMilestoneProgress({
  currentPurchaseNumber: 1,
  previousMilestoneNumber: 100,
  nextMilestoneNumber: 50,
}), /must not be below/);
console.log('PASS: bigint-safe milestone progress and variable intervals');

const resultSource = read('src/pages/resultado.astro');
const statusSource = read('src/pages/api/job-status.ts');
const passSource = read('src/lib/sgx-pass.ts');
const migrationC = read('supabase/migrations/20260904030000_purchase_milestones_v1.sql');
const identityMigration = read('supabase/migrations/20260902000000_add_sgx_vi_pass_identity.sql');

assert(resultSource.includes('job.purchase_history'));
assert(resultSource.includes('job.next_milestone'));
assert(resultSource.includes('job.current_milestone'));
assert(resultSource.includes('job.milestone_progress'));
assert(resultSource.includes('PURCHASE HISTORY'));
assert(resultSource.includes('MILESTONE UNLOCKED'));
assert(resultSource.includes('prefers-reduced-motion: reduce'));
assert(!resultSource.includes('#000100'));
assert(!resultSource.includes('WINNER'));
assert(!resultSource.includes('CASH REWARD'));
assert(!resultSource.includes('purchase_queue_position'));
assert(!statusSource.includes('purchase_queue_position'));
assert(statusSource.includes('getSgxPurchaseHistoryByPassId'));
assert(statusSource.includes('getSgxMilestoneReadModel'));
assert(statusSource.includes('calculateMilestoneProgress'));
assert(passSource.includes(".eq('sgx_pass_id', sgxPassId)"));
assert(passSource.includes(".eq('status', 'approved')"));
assert(passSource.includes(".not('purchase_number', 'is', null)"));
assert(passSource.includes(".from('purchase_milestones')"));
assert(passSource.includes(".from('purchase_milestone_rules')"));
for (const schemaToken of [
  'create table if not exists public.purchase_milestones',
  'purchase_number bigint not null',
  'status text not null default \'draft\'',
  'rules_version text',
  'create table if not exists public.purchase_milestone_rules',
  'milestone_id uuid not null references public.purchase_milestones(id)',
  'version text not null',
  'published_at timestamptz',
  'purchase_number bigint',
]) {
  assert(migrationC.includes(schemaToken), `Migration C missing schema token: ${schemaToken}`);
}
for (const schemaToken of ['sgx_pass_id uuid not null', 'status text not null']) {
  assert(identityMigration.includes(schemaToken), `Identity migration missing schema token: ${schemaToken}`);
}
assert(passSource.includes(".not('published_at', 'is', null)"));
assert(passSource.includes(".in('status', ['active', 'reached'])"));
assert(resultSource.includes('currentNumber === unlockedNumber'));
assert(resultSource.includes("classList.toggle('is-milestone'"));
for (const forbidden of ['email', 'customer_id', 'sgx_pass_id', 'payment_id', 'purchase_queue_position', 'metadata']) {
  assert(!statusSource.includes(`JSON.stringify({ ${forbidden}`));
}
console.log('PASS: history/milestone source boundaries and public-field audit');

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
        ['sgx-pass', [
          "export const getSgxPassById = () => globalThis.__statusPass;",
          "export const getSgxOrderByJobId = () => globalThis.__statusOrder;",
          "export const getSgxPurchaseHistoryByPassId = (passId, current) => {",
          "  if (passId !== globalThis.__statusOrder.sgxPassId || current !== globalThis.__statusOrder.purchaseNumber) throw new Error('wrong authorized identity');",
          "  if (globalThis.__statusHistoryError) throw new Error('db history secret');",
          "  return globalThis.__statusHistory;",
          "};",
          "export const getSgxMilestoneReadModel = () => {",
          "  if (globalThis.__statusMilestoneError) throw new Error('db milestone secret');",
          "  return globalThis.__statusMilestones;",
          "};",
        ].join('\n')],
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
  Response,
  URL,
  __statusJob: {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    paymentStatus: 'approved',
    customerId: '22222222-2222-4222-8222-222222222222',
    sgxPassId: '33333333-3333-4333-8333-333333333333',
  },
  __statusPass: { publicCode: 'SGX-VI-TEST-1234', status: 'active' },
  __statusOrder: {
    customerId: '22222222-2222-4222-8222-222222222222',
    sgxPassId: '33333333-3333-4333-8333-333333333333',
    status: 'approved',
    purchaseNumber: '5',
  },
  __statusHistory: [
    { purchase_number: '4', is_current: false },
    { purchase_number: '5', is_current: true },
  ],
  __statusMilestones: {
    next_milestone: { purchase_number: '100', previous_purchase_number: '0' },
    current_milestone: null,
  },
  __statusHistoryError: false,
  __statusMilestoneError: false,
};
runInNewContext(statusBundle.outputFiles[0].text, statusContext);
const statusResponse = await statusContext.module.exports.GET({
  url: new URL('https://example.invalid/api/job-status?jobId=11111111-1111-4111-8111-111111111111&token=offline-token'),
});
const payload = await statusResponse.json();
assert.equal(statusResponse.status, 200);
assert.deepEqual(payload.purchase_history, statusContext.__statusHistory);
assert.deepEqual(payload.next_milestone, statusContext.__statusMilestones.next_milestone);
assert.equal(payload.current_milestone, null);
assert.deepEqual(payload.milestone_progress, { percentage: 5, remaining: '95', reached: false });
assert.equal(payload.purchase_number, '5');
for (const forbidden of ['email', 'customer_id', 'sgx_pass_id', 'payment_id', 'purchase_queue_position', 'metadata']) {
  assert(!JSON.stringify(payload).includes(forbidden));
}

statusContext.__statusOrder.purchaseNumber = '4';
statusContext.__statusHistory = [
  { purchase_number: '4', is_current: true },
  { purchase_number: '5', is_current: false },
];
const historicalResponse = await statusContext.module.exports.GET({
  url: new URL('https://example.invalid/api/job-status?jobId=11111111-1111-4111-8111-111111111111&token=offline-token'),
});
const historicalPayload = await historicalResponse.json();
assert.equal(historicalPayload.purchase_number, '4');
assert.equal(historicalPayload.purchase_history[0].is_current, true);
assert.equal(historicalPayload.purchase_history[1].is_current, false);

statusContext.__statusOrder.purchaseNumber = '5';
statusContext.__statusHistory = [
  { purchase_number: '4', is_current: false },
  { purchase_number: '5', is_current: true },
];
statusContext.__statusHistoryError = true;
statusContext.__statusMilestoneError = true;
const auxiliaryFailureResponse = await statusContext.module.exports.GET({
  url: new URL('https://example.invalid/api/job-status?jobId=11111111-1111-4111-8111-111111111111&token=offline-token'),
});
const auxiliaryFailurePayload = await auxiliaryFailureResponse.json();
assert.equal(auxiliaryFailureResponse.status, 200);
assert.equal(auxiliaryFailurePayload.status, 'completed');
assert.equal(auxiliaryFailurePayload.purchase_number, '5');
assert.equal(auxiliaryFailurePayload.sgxPass.code, 'SGX-VI-TEST-1234');
assert.deepEqual(auxiliaryFailurePayload.purchase_history, []);
assert.equal(auxiliaryFailurePayload.next_milestone, null);
assert.equal(auxiliaryFailurePayload.milestone_progress, null);
assert(!JSON.stringify(auxiliaryFailurePayload).includes('db secret'));
statusContext.__statusHistoryError = false;
statusContext.__statusMilestoneError = false;

statusContext.__statusJob.status = 'processing';
const processingResponse = await statusContext.module.exports.GET({
  url: new URL('https://example.invalid/api/job-status?jobId=11111111-1111-4111-8111-111111111111&token=offline-token'),
});
const processingPayload = await processingResponse.json();
assert.deepEqual(processingPayload.purchase_history, []);
assert.equal(processingPayload.next_milestone, null);
assert.equal(processingPayload.milestone_progress, null);
console.log('PASS: authorized history payload, milestone payload and non-completed suppression');

const readModelBundle = await build({
  stdin: {
    contents: [
      "export { getSgxPurchaseHistoryByPassId, getSgxMilestoneReadModel } from './src/lib/sgx-pass.ts';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  plugins: [{
    name: 'offline-read-model-supabase',
    setup(builder) {
      builder.onResolve({ filter: /supabase$/ }, () => ({ path: 'supabase', namespace: 'offline-read-model' }));
      builder.onLoad({ filter: /.*/, namespace: 'offline-read-model' }, () => ({
        loader: 'ts',
        contents: `
          export class SupabaseBackendError extends Error {}
          export const isSupabaseConfigured = () => true;
          export const getSupabaseAdmin = () => globalThis.__readDb;
          export const createSupabaseOperationError = (code) => Object.assign(new Error(code), { code });
        `,
      }));
    },
  }],
});

class ReadQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
  }
  select() { return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  not(key, operator, value) {
    assert.equal(operator, 'is');
    this.filters.push((row) => row[key] !== value);
    return this;
  }
  order() { return this; }
  then(resolve, reject) {
    try {
      const db = this.db;
      if (db.failTable === this.table) {
        return resolve({ data: null, error: { message: 'provider secret must stay server-side' } });
      }
      const rows = (db.tables[this.table] || []).filter((row) => this.filters.every((filter) => filter(row)));
      return resolve({ data: structuredClone(rows), error: null });
    } catch (error) {
      return reject(error);
    }
  }
}

const readModelContext = {
  module: { exports: {} },
  exports: {},
  require,
  __readDb: {
    failTable: null,
    tables: {
      orders: [],
      purchase_milestones: [],
      purchase_milestone_rules: [],
    },
    from(table) { return new ReadQuery(this, table); },
  },
};
runInNewContext(readModelBundle.outputFiles[0].text, readModelContext);
const { getSgxPurchaseHistoryByPassId, getSgxMilestoneReadModel } = readModelContext.module.exports;
const emptyHistory = await getSgxPurchaseHistoryByPassId('33333333-3333-4333-8333-333333333333', '5');
const emptyMilestoneModel = await getSgxMilestoneReadModel('5');
assert.deepEqual(JSON.parse(JSON.stringify(emptyHistory)), []);
assert.deepEqual(JSON.parse(JSON.stringify(emptyMilestoneModel)), { next_milestone: null, current_milestone: null });

readModelContext.__readDb.tables.orders = [
  { sgx_pass_id: '33333333-3333-4333-8333-333333333333', status: 'approved', purchase_number: '4' },
  { sgx_pass_id: '33333333-3333-4333-8333-333333333333', status: 'approved', purchase_number: '5' },
  { sgx_pass_id: '33333333-3333-4333-8333-333333333333', status: 'rejected', purchase_number: '6' },
  { sgx_pass_id: '33333333-3333-4333-8333-333333333333', status: 'approved', purchase_number: null },
  { sgx_pass_id: '44444444-4444-4444-8444-444444444444', status: 'approved', purchase_number: '7' },
];
readModelContext.__readDb.tables.purchase_milestones = [
  { id: 'milestone-100', purchase_number: '100', status: 'reached', rules_version: 'v1' },
  { id: 'milestone-200', purchase_number: '200', status: 'active', rules_version: 'v1' },
];
readModelContext.__readDb.tables.purchase_milestone_rules = [
  { milestone_id: 'milestone-100', version: 'v1', published_at: '2026-09-05T00:00:00.000Z' },
  { milestone_id: 'milestone-200', version: 'v1', published_at: '2026-09-05T00:00:00.000Z' },
];
const historicalNumbers = await getSgxPurchaseHistoryByPassId('33333333-3333-4333-8333-333333333333', '4');
assert.deepEqual(JSON.parse(JSON.stringify(historicalNumbers)), [
  { purchase_number: '4', is_current: true },
  { purchase_number: '5', is_current: false },
]);
const exactMilestone = await getSgxMilestoneReadModel('100');
assert.deepEqual(JSON.parse(JSON.stringify(exactMilestone)), {
  next_milestone: { purchase_number: '200', previous_purchase_number: '100' },
  current_milestone: { purchase_number: '100', reached: true },
});
const betweenMilestones = await getSgxMilestoneReadModel('101');
assert.deepEqual(JSON.parse(JSON.stringify(betweenMilestones)), {
  next_milestone: { purchase_number: '200', previous_purchase_number: '100' },
  current_milestone: null,
});
readModelContext.__readDb.failTable = 'purchase_milestones';
assert.deepEqual(JSON.parse(JSON.stringify(await getSgxMilestoneReadModel('101'))), {
  next_milestone: null,
  current_milestone: null,
});
console.log('PASS: empty/read-error models, historical CURRENT, exact milestone and no fake target');

console.log('purchase experience checks: PASS (zero external I/O)');
