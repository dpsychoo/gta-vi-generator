// Offline integration tests. Real webhook, payment verification/mapper,
// identity, legal association and job-claim code; in-memory service adapters.
// The RPC adapter is a CONTRACT DOUBLE, not a PostgreSQL execution/test.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mocks = {
  supabase: `
    export class SupabaseBackendError extends Error {}
    export const isSupabaseConfigured = () => true;
    export const getSupabaseAdmin = () => globalThis.harness.db;
    export const createSupabaseOperationError = (code) => Object.assign(new SupabaseBackendError(code), { code });
    export const getMasterStyleReferencePath = () => { throw new Error('Unexpected storage access'); };
    export { getMasterStyleReferencePath as getSupabaseGeneratedBucket,
      getMasterStyleReferencePath as getSupabasePrivateBucket, getMasterStyleReferencePath as getSupabaseUploadsBucket,
      getMasterStyleReferencePath as supabaseDownload, getMasterStyleReferencePath as supabaseGetSignedUrl,
      getMasterStyleReferencePath as supabaseUpload };
  `,
  env: `
    export const getAppBaseUrl = () => 'https://example.invalid';
    export const getJobCurrency = () => 'CLP';
    export const getJobPrice = () => '2990';
    export const getMercadoPagoAccessToken = () => 'offline-fixture';
    export const getMercadoPagoWebhookSecret = () => 'offline-signature-fixture';
  `,
  openai: `
    export class DevelopmentGenerationError extends Error {}
    export const processPaidJob = async (id) => globalThis.harness.generate(id);
  `,
  email: `export const sendPurchaseConfirmationEmail = async (input) => globalThis.harness.confirm(input);`,
};

const compiled = await build({
  stdin: {
    contents: `export { POST } from './src/pages/api/mercadopago-webhook.ts';
      export { tryAssignPurchaseNumber } from './src/lib/purchase-number.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
  define: {
    'import.meta.env.PROD': 'false',
    'import.meta.url': JSON.stringify(pathToFileURL(resolve('src/lib/job-store.ts')).href),
  },
  plugins: [{
    name: 'offline-services',
    setup(plugin) {
      plugin.onResolve({ filter: /(?:^|\/)(supabase|server\/env|openai|email)$/ }, (args) => {
        const name = args.path.split('/').at(-1);
        return { path: name, namespace: 'offline' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'offline' }, (args) => ({ contents: mocks[args.path], loader: 'js' }));
    },
  }],
});

const nodeRequire = createRequire(import.meta.url);
const context = {
  module: { exports: {} }, URL, Request, Response, AbortSignal, Buffer,
  require(name) {
    if (name === 'node:fs/promises') return new Proxy({}, {
      get: () => () => { throw new Error('Filesystem access is forbidden in integration tests'); },
    });
    assert(['node:crypto', 'node:path', 'node:url'].includes(name), `Unexpected dependency: ${name}`);
    return nodeRequire(name);
  },
  console: Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => {
    context.harness.logs.push({ level, args });
  }])),
  // Never delegate to the real fetch. Only the synthetic payment GET exists.
  fetch: async (url, options) => {
    const h = context.harness;
    assert.equal(url, `https://api.mercadopago.com/v1/payments/${h.payment.id}`);
    assert.equal(options.method ?? 'GET', 'GET');
    h.events.push('verified_payment_fetch');
    return new Response(JSON.stringify(h.payment), { status: 200 });
  },
};
runInNewContext(compiled.outputFiles[0].text, context, { filename: 'offline-webhook.cjs' });
const { POST, tryAssignPurchaseNumber } = context.module.exports;
const jobId = '11111111-1111-4111-8111-111111111111';
const milestoneId = '22222222-2222-4222-8222-222222222222';
const awardId = '33333333-3333-4333-8333-333333333333';

function result(outcome, number = null, award = false, reason = null) {
  return { outcome, purchase_number: number, milestone_reached: award,
    milestone_id: award ? milestoneId : null, award_id: award ? awardId : null, reason };
}

class MemoryQuery {
  constructor(h, table) { this.h = h; this.table = table; this.filters = []; }
  select() { return this; }
  eq(key, value) { this.filters.push((r) => r[key] === value); return this; }
  neq(key, value) { this.filters.push((r) => r[key] !== value); return this; }
  is(key, value) { this.filters.push((r) => (r[key] ?? null) === value); return this; }
  in(key, values) { this.filters.push((r) => values.includes(r[key])); return this; }
  or(value) {
    assert.equal(value, `payment_id.is.null,payment_id.eq.${this.h.payment.id}`);
    this.filters.push((r) => r.payment_id == null || r.payment_id === this.h.payment.id);
    return this;
  }
  limit(value) { this.max = value; return this; }
  insert(value) { this.action = 'insert'; this.payload = value; return this; }
  update(value) { this.action = 'update'; this.payload = value; return this; }
  single() { return this.execute(true); }
  maybeSingle() { return this.execute(true); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }
  async execute(single) {
    const rows = this.h.tables[this.table];
    assert(rows, `Unexpected table: ${this.table}`);
    if (this.action === 'insert') {
      // Contract double for the BEFORE trigger: even a duplicate insert may
      // consume an INTERNAL ticket, but cannot consume a purchase_number.
      const queuePosition = this.table === 'orders' && this.payload.status === 'approved'
        ? String(++this.h.queueLast) : null;
      const uniqueKeys = { customers: ['normalized_email'], sgx_passes: ['customer_id', 'public_code'],
        orders: ['job_id', 'mercadopago_payment_id'] }[this.table];
      assert(uniqueKeys, `Unexpected insert: ${this.table}`);
      if (rows.some((row) => uniqueKeys.some((key) => row[key] === this.payload[key]))) {
        return { data: null, error: { code: '23505' } };
      }
      const row = { id: randomUUID(), purchase_number: null, purchase_queue_position: queuePosition,
        created_at: new Date().toISOString(), ...this.payload };
      rows.push(row);
      this.h.events.push(`persist_${this.table}`);
      return { data: single ? structuredClone(row) : [structuredClone(row)], error: null };
    }
    let selected = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.max) selected = selected.slice(0, this.max);
    if (this.action === 'update') {
      for (const row of selected) Object.assign(row, this.payload);
      if (selected.length) this.h.events.push(`update_${this.table}`);
    }
    return { data: structuredClone(single ? selected[0] ?? null : selected), error: null };
  }
}

function reset({ status = 'approved', state = 'live', legacy = false, acceptance = true, award = false } = {}) {
  const h = {
    events: [], logs: [], rpcCalls: [], generated: 0, confirmations: 0,
    counter: 0n, queueLast: 0n, state, award, milestoneNumber: 1n,
    awards: new Map(), rpcOverride: null, writerBarrier: null,
    payment: { id: '123456789', status, external_reference: jobId, currency_id: 'CLP',
      transaction_amount: 2990, preference_id: 'offline-preference' },
    tables: {
      jobs: [{ id: jobId, email: 'offline@example.invalid', status: 'pending_payment',
        payment_status: 'pending', payment_id: null, external_reference: jobId,
        mercadopago_preference_id: 'offline-preference', metadata: legacy ? {} : {
          legal_center_version: '2026-09-03', legal_center_checkout: 'v1',
        } }],
      customers: [], sgx_passes: [], orders: [],
      legal_acceptances: acceptance ? [{ id: randomUUID(), job_id: jobId, customer_id: null,
        confirmation_email_status: 'pending' }] : [],
    },
    generate(id) {
      const job = this.tables.jobs.find((r) => r.id === id);
      assert.equal(job.payment_status, 'approved');
      assert.equal(job.status, 'processing');
      this.generated++;
      this.events.push('generate');
      job.status = 'completed';
    },
    confirm({ jobId: id, customer, order }) {
      const a = this.tables.legal_acceptances.find((r) => r.job_id === id);
      assert.equal(a.customer_id, customer.id);
      assert.equal(order.customerId, customer.id);
      this.confirmations++;
      this.events.push('legal_confirmation');
    },
  };
  h.db = {
    from: (table) => new MemoryQuery(h, table),
    rpc(name, args) {
      assert.equal(name, 'assign_purchase_number_v1');
      assert.deepEqual(Object.keys(args), ['p_order_id']);
      return {
        async abortSignal(signal) {
          assert(signal instanceof AbortSignal);
          h.rpcCalls.push(args.p_order_id);
          h.events.push('rpc');
          if (h.rpcOverride) return h.rpcOverride(signal, args.p_order_id);
          const order = h.tables.orders.find((o) => o.id === args.p_order_id);
          if (!order) return { data: [result('not_found', null, false, 'order_not_found')], error: null };
          assert(h.tables.customers.some((c) => c.id === order.customer_id));
          assert(h.tables.sgx_passes.some((p) => p.id === order.sgx_pass_id && p.customer_id === order.customer_id));
          assert.equal(h.tables.jobs.find((j) => j.id === order.job_id).customer_id, order.customer_id);
          if (order.purchase_number !== null) {
            return { data: [result('existing', order.purchase_number, h.awards.has(order.id))], error: null };
          }
          if (order.status !== 'approved') return { data: [result('not_approved', null, false, 'order_not_approved')], error: null };
          if (h.state !== 'live') return { data: [result('deferred', null, false, `counter_${h.state}`)], error: null };
          // Conceptual writer barrier: actual table locks are audited statically,
          // not exercised against PostgreSQL by this test adapter.
          if (h.writerBarrier) await h.writerBarrier;
          if (h.tables.orders.some((o) => o.status === 'approved'
            && o.purchase_number === null && o.purchase_queue_position === null)) {
            return { data: [result('deferred', null, false, 'queue_position_missing')], error: null };
          }
          const pending = h.tables.orders.filter((o) => o.purchase_number === null && o.purchase_queue_position !== null)
            .sort((a, b) => BigInt(a.purchase_queue_position) < BigInt(b.purchase_queue_position) ? -1 : 1);
          if (pending[0]?.id !== order.id) return { data: [result('deferred', null, false, 'prior_pending')], error: null };
          const maxAssignedQueue = h.tables.orders.filter((o) => o.purchase_number !== null)
            .reduce((max, o) => BigInt(o.purchase_queue_position ?? '0') > max ? BigInt(o.purchase_queue_position) : max, 0n);
          if (BigInt(order.purchase_queue_position) <= maxAssignedQueue) {
            return { data: [result('deferred', null, false, 'queue_order_violation')], error: null };
          }
          // Minimal contract double: no SQL, no claim of testing DB atomicity.
          order.purchase_number = String(++h.counter);
          const reached = h.award && h.counter === h.milestoneNumber;
          if (reached) h.awards.set(order.id, awardId);
          return { data: [result('assigned', order.purchase_number, reached)], error: null };
        },
      };
    },
  };
  context.harness = h;
  return h;
}

async function webhook({ signed = true } = {}) {
  const ts = '1788560000';
  const requestId = 'offline-request';
  const paymentId = context.harness.payment.id;
  const digest = createHmac('sha256', 'offline-signature-fixture')
    .update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest('hex');
  return POST({ request: new Request(`https://example.invalid/api/mercadopago-webhook?data.id=${paymentId}&type=payment`, {
    method: 'POST', headers: { 'x-request-id': requestId,
      'x-signature': `ts=${ts},v1=${signed ? digest : '0'.repeat(64)}` },
    body: JSON.stringify({ type: 'payment', data: { id: paymentId } }),
  }) });
}

const checks = [];
async function check(name, run) { await run(); checks.push(name); console.log(`PASS: ${name}`); }
function oneIdentity(h) {
  for (const table of ['orders', 'customers', 'sgx_passes']) assert.equal(h.tables[table].length, 1, table);
}

for (const status of ['pending', 'rejected', 'cancelled', 'refunded', 'charged_back', 'authorized', 'in_process', 'unknown']) {
  await check(`${status}: no assignment or generation`, async () => {
    const h = reset({ status });
    assert.equal((await webhook()).status, 200);
    assert.equal(h.rpcCalls.length, 0);
    assert.equal(h.generated, 0);
    assert.equal(h.tables.orders.length, 0);
  });
}
await check('invalid signature/payment mismatch cannot reach identity or assignment', async () => {
  let h = reset();
  assert.equal((await webhook({ signed: false })).status, 401);
  assert.equal(h.events.length, 0);
  h = reset(); h.payment.transaction_amount = 1;
  assert.equal((await webhook()).status, 200);
  assert.equal(h.rpcCalls.length, 0);
  assert.equal(h.tables.orders.length, 0);
});
await check('approved: verified payment, durable identity, legal association, RPC, generation in order', async () => {
  const h = reset();
  assert.equal((await webhook()).status, 200);
  oneIdentity(h);
  assert.equal(h.rpcCalls.length, 1);
  assert.equal(h.counter, 1n);
  assert.equal(h.generated, 1);
  const order = ['verified_payment_fetch', 'persist_customers', 'persist_sgx_passes',
    'persist_orders', 'legal_confirmation', 'rpc', 'generate'].map((e) => h.events.indexOf(e));
  assert(order.every((position, index) => position >= 0 && (!index || position > order[index - 1])));
});
for (const state of ['paused', 'backfill']) {
  await check(`${state}: deferred does not break paid generation`, async () => {
    const h = reset({ state });
    assert.equal((await webhook()).status, 200);
    assert.equal(h.generated, 1);
    assert.equal(h.counter, 0n);
    assert.equal(h.tables.orders[0].purchase_number, null);
    assert(h.logs.some((r) => r.args[0]?.outcome === 'deferred'));
  });
}
await check('duplicate approved: existing number/award; actual identity and job claim remain idempotent', async () => {
  const h = reset({ award: true });
  assert.equal((await webhook()).status, 200);
  const approvedAt = h.tables.orders[0].approved_at;
  assert.equal((await webhook()).status, 200);
  oneIdentity(h);
  assert.equal(h.rpcCalls.length, 2);
  assert.equal(new Set(h.rpcCalls).size, 1);
  assert.equal(h.counter, 1n);
  assert.equal(h.awards.size, 1);
  assert.equal(h.tables.orders[0].approved_at, approvedAt);
  assert.equal(h.generated, 1);
  assert(h.logs.some((r) => r.args[0]?.outcome === 'existing' && r.args[0].award_id === awardId));
});
await check('concurrent duplicate notifications: one identity and one fulfillment with RPC contract double', async () => {
  const h = reset({ award: true });
  const responses = await Promise.all([webhook(), webhook()]);
  assert(responses.every((r) => r.status === 200));
  oneIdentity(h);
  assert.equal(h.counter, 1n);
  assert.equal(h.awards.size, 1);
  assert.equal(h.generated, 1);
});
await check('unexpected RPC error: payment/identity preserved; completed-job retry repairs numbering only', async () => {
  const h = reset();
  h.rpcOverride = () => ({ data: null, error: { code: '23505', message: 'sensitive-provider-payload' } });
  assert.equal((await webhook()).status, 200);
  oneIdentity(h);
  assert.equal(h.generated, 1);
  assert.equal(h.tables.jobs[0].payment_status, 'approved');
  assert.equal(h.tables.orders[0].purchase_number, null);
  assert(!JSON.stringify(h.logs).includes('sensitive-provider-payload'));
  h.rpcOverride = null;
  assert.equal((await webhook()).status, 200);
  oneIdentity(h);
  assert.equal(h.counter, 1n);
  assert.equal(h.generated, 1);
});
await check('RPC unavailable, permission/lock failures, malformed return and thrown transport error are nonfatal', async () => {
  for (const response of [{ data: null, error: { code: 'PGRST202' } },
    { data: null, error: { code: '42501' } }, { data: null, error: { code: '55P03' } },
    { data: [result('assigned', 9007199254740992)], error: null },
    { data: [], error: null }, new Error('sensitive-provider-payload')]) {
    const h = reset();
    h.rpcOverride = () => { if (response instanceof Error) throw response; return response; };
    assert.equal((await webhook()).status, 200);
    assert.equal(h.generated, 1);
    oneIdentity(h);
    assert(h.logs.some((r) => r.args[0]?.outcome === 'error'));
    assert(!JSON.stringify(h.logs).includes('sensitive-provider-payload'));
  }
});
await check('bounded numbering wait aborts transport and paid generation continues', async () => {
  const h = reset();
  h.rpcOverride = (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const start = performance.now();
  // AbortSignal.timeout uses an unref timer; keep just this offline test alive.
  const keepAlive = setInterval(() => {}, 1000);
  try { assert.equal((await webhook()).status, 200); } finally { clearInterval(keepAlive); }
  assert(performance.now() - start < 6000);
  assert.equal(h.generated, 1);
});
await check('bigint return remains exact; not_found/not_approved produce structured warnings', async () => {
  const h = reset();
  h.rpcOverride = () => ({ data: [result('existing', '9223372036854775807')], error: null });
  assert.equal((await tryAssignPurchaseNumber(jobId)).purchase_number, '9223372036854775807');
  for (const outcome of ['not_found', 'not_approved']) {
    h.rpcOverride = () => ({ data: [result(outcome, null, false, `order_${outcome}`)], error: null });
    assert.equal((await tryAssignPurchaseNumber(jobId)).outcome, outcome);
  }
});
await check('new legal job without acceptance still blocked; legacy still fulfilled without contractual email', async () => {
  let h = reset({ acceptance: false });
  assert.equal((await webhook()).status, 500);
  assert.equal(h.rpcCalls.length, 0);
  assert.equal(h.generated, 0);
  h = reset({ legacy: true, acceptance: false });
  assert.equal((await webhook()).status, 200);
  assert.equal(h.generated, 1);
  assert.equal(h.confirmations, 0);
});
await check('reversal after completed approval: current webhook leaves Order/number unchanged (cash blocker)', async () => {
  const h = reset();
  await webhook();
  for (const state of ['refunded', 'charged_back']) {
    h.payment.status = state;
    assert.equal((await webhook()).status, 200);
    assert.equal(h.tables.orders[0].status, 'approved');
    assert.equal(h.tables.orders[0].purchase_number, '1');
    assert.equal(h.tables.jobs[0].payment_status, 'approved');
  }
  assert.equal(h.rpcCalls.length, 1);
  assert.equal(h.generated, 1);
});

function laterCheckout(h) {
  const id = randomUUID();
  const paymentId = String(BigInt(h.payment.id) + 1n);
  h.tables.jobs.push({ ...structuredClone(h.tables.jobs[0]), id, external_reference: id,
    customer_id: null, sgx_pass_id: null, status: 'pending_payment', payment_status: 'pending', payment_id: null });
  h.tables.legal_acceptances.push({ id: randomUUID(), job_id: id, customer_id: null });
  h.payment = { ...h.payment, id: paymentId, status: 'approved', external_reference: id };
  return id;
}

for (const failure of ['rpc_error', 'deferred', 'lock_timeout', 'transport_timeout']) {
  await check(`A ${failure}, then B: no overtaking; head repair gets N, later retry N+1, fulfillment unaffected`, async () => {
    const h = reset({ award: true });
    if (failure === 'deferred') h.state = 'paused';
    else h.rpcOverride = () => {
      if (failure === 'transport_timeout') throw new DOMException('offline timeout', 'TimeoutError');
      return { data: null, error: { code: failure === 'lock_timeout' ? '55P03' : '23505' } };
    };
    assert.equal((await webhook()).status, 200);
    const a = h.tables.orders[0];
    h.rpcOverride = null; h.state = 'live';
    laterCheckout(h);
    assert.equal((await webhook()).status, 200);
    const b = h.tables.orders[1];
    assert.equal(h.generated, 2);
    assert.equal(h.counter, 0n);
    assert.equal(b.purchase_number, null);
    assert(h.logs.some((l) => l.args[0]?.reason === 'prior_pending'));
    assert.equal(h.tables.customers.length, 1);
    assert.equal(h.tables.sgx_passes.length, 1);
    const assignedA = await tryAssignPurchaseNumber(a.id);
    assert.equal(assignedA.purchase_number, '1');
    assert.equal(assignedA.award_id, awardId);
    assert.equal((await tryAssignPurchaseNumber(b.id)).purchase_number, '2');
    assert.equal((await tryAssignPurchaseNumber(a.id)).outcome, 'existing');
    assert.equal((await tryAssignPurchaseNumber(b.id)).outcome, 'existing');
    assert.equal(h.counter, 2n);
    assert.equal(h.awards.size, 1);
    assert.equal(h.awards.has(a.id), true);
    assert.equal(h.generated, 2, 'administrative repair must not regenerate images');
  });
}
await check('late provider approval and earlier backend timestamp do not insert ahead of a registered pending head', async () => {
  const h = reset({ state: 'paused' });
  h.payment.date_approved = '2020-01-02T00:00:00Z';
  await webhook();
  const a = h.tables.orders[0];
  assert.notEqual(a.approved_at, h.payment.date_approved, 'actual mapper does not use provider date_approved');
  laterCheckout(h);
  h.payment.date_approved = '2020-01-01T00:00:00Z';
  await webhook();
  const b = h.tables.orders[1];
  // Models backend observation before a long pre-insert delay or clock skew.
  b.approved_at = '2019-01-01T00:00:00Z';
  h.state = 'live';
  assert.equal((await tryAssignPurchaseNumber(b.id)).reason, 'prior_pending');
  assert.equal((await tryAssignPurchaseNumber(a.id)).purchase_number, '1');
  assert.equal((await tryAssignPurchaseNumber(b.id)).purchase_number, '2');
});
await check('earlier ticket in uncommitted writer: barrier prevents later target from reading an incomplete queue (model)', async () => {
  const h = reset({ state: 'paused' });
  await webhook(); laterCheckout(h); await webhook();
  const a = h.tables.orders.shift();
  const b = h.tables.orders[0];
  let release;
  h.writerBarrier = new Promise((resolve) => { release = resolve; });
  h.state = 'live';
  let completed = false;
  const laterResult = tryAssignPurchaseNumber(b.id).then((r) => { completed = true; return r; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(h.counter, 0n);
  h.tables.orders.unshift(a); // Commit earlier writer before releasing barrier.
  release();
  assert.equal((await laterResult).reason, 'prior_pending');
  h.writerBarrier = null;
  assert.equal((await tryAssignPurchaseNumber(a.id)).purchase_number, '1');
  assert.equal((await tryAssignPurchaseNumber(b.id)).purchase_number, '2');
});
await check('transport error after commit: existing number remains before B, without another award', async () => {
  const h = reset();
  h.rpcOverride = (_signal, id) => {
    h.tables.orders.find((o) => o.id === id).purchase_number = '1'; h.counter = 1n;
    throw new DOMException('response lost after commit', 'TimeoutError');
  };
  await webhook();
  const a = h.tables.orders[0];
  h.rpcOverride = null; laterCheckout(h); await webhook();
  assert.equal(h.tables.orders[1].purchase_number, '2');
  assert.equal((await tryAssignPurchaseNumber(a.id)).outcome, 'existing');
  assert.equal(h.counter, 2n);
});
await check('duplicate inserts may burn queue tickets, never customer-visible purchase numbers', async () => {
  const h = reset();
  await webhook(); await webhook(); laterCheckout(h); await webhook();
  assert.equal(h.tables.orders[0].purchase_queue_position, '1');
  assert.equal(h.tables.orders[1].purchase_queue_position, '3');
  assert.equal(h.tables.orders[1].purchase_number, '2');
});
await check('missing position, overtaking evidence and non-approved registered head stop progression', async () => {
  const h = reset({ state: 'paused' });
  await webhook(); laterCheckout(h); await webhook();
  const [a, b] = h.tables.orders;
  h.state = 'live';
  a.purchase_queue_position = null;
  assert.equal((await tryAssignPurchaseNumber(b.id)).reason, 'queue_position_missing');
  a.purchase_queue_position = '1'; a.status = 'refunded';
  assert.equal((await tryAssignPurchaseNumber(b.id)).reason, 'prior_pending');
  a.status = 'approved'; b.purchase_number = '1'; h.counter = 1n;
  assert.equal((await tryAssignPurchaseNumber(a.id)).reason, 'queue_order_violation');
  assert.equal(h.counter, 1n);
});
await check('initial #1-#3 prefix remains fixed; post-cut admission gets #4 even if its internal ticket is #1', async () => {
  const h = reset({ state: 'paused' });
  await webhook();
  const a = h.tables.orders[0];
  // Historical fixed prefix; model only, the administrative SQL is never run.
  a.purchase_number = '1'; a.purchase_queue_position = null;
  h.tables.orders.push({ ...a, id: randomUUID(), purchase_number: '2' },
    { ...a, id: randomUUID(), purchase_number: '3' });
  h.counter = 3n; h.queueLast = 0n; h.state = 'live';
  laterCheckout(h); await webhook();
  assert.equal(h.tables.orders.at(-1).purchase_queue_position, '1');
  assert.equal(h.tables.orders.at(-1).purchase_number, '4');
});

await check('static SQL audit: postflight read-only; counter-first; atomic award and backend ACL', () => {
  const migration = read('supabase/migrations/20260904040000_purchase_number_assignment_v1.sql');
  const backfill = read('supabase/backfill_purchase_numbers_v1.sql');
  const preflight = read('supabase/preflight_purchase_number_assignment_v1.sql');
  const postflight = read('supabase/postflight_purchase_number_assignment_v1.sql');
  // Keep literal SELECT strings in scope: a mutation hidden in query_to_xml must fail too.
  assert(!/\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|do|call|execute|vacuum|refresh)\b/i
    .test(postflight.replace(/--[^\n]*/g, '').replace(/'EXECUTE'|'USAGE, SELECT, UPDATE'/g, "'privilege'")));
  assert(!/\b(pg_advisory|set_config|nextval|setval)\w*\s*\(/i.test(postflight));
  assert(!/\bfor\s+(update|share)\b/i.test(postflight));
  assert(postflight.includes('select section, check_name, value, status, detail'));
  assert(postflight.includes("else 'SKIP'"));
  assert(!/\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|do|call|execute|vacuum|refresh)\b/i
    .test(preflight.replace(/--[^\n]*/g, '').replace(/'EXECUTE'|'USAGE, SELECT, UPDATE'/g, "'privilege'")));
  assert(!/\braise\s+notice\b|\bdo\s+\$\$/i.test(preflight));
  assert(preflight.includes('select section, check_name, value, status, detail'));
  assert(preflight.includes("'EXPECTED_ABSENT'"));
  assert(preflight.includes("'table_or_column_missing'"));
  assert(preflight.includes('query_to_xml'));
  const counterLock = migration.indexOf('from public.purchase_counter as c where c.id = 1 for update');
  const orderLock = migration.indexOf('where o.id = p_order_id for update');
  assert(counterLock >= 0 && orderLock > counterLock);
  const tableBarrier = migration.indexOf('lock table public.orders in share row exclusive mode');
  const queueHead = migration.indexOf('order by o.purchase_queue_position asc limit 1');
  const increment = migration.indexOf('v_next := v_counter.last_purchase_number + 1');
  assert(tableBarrier > counterLock && orderLock > tableBarrier && queueHead > orderLock && increment > queueHead);
  assert(migration.includes("pg_catalog.current_setting('transaction_isolation') <> 'read committed'"));
  assert(migration.includes("'prior_pending'::text"));
  assert(!/skip\s+locked/i.test(migration));
  assert(migration.slice(orderLock).includes('if v_order.purchase_number is not null'));
  assert(backfill.indexOf('from public.purchase_counter') < backfill.indexOf('lock table public.orders'));
  assert(backfill.includes('begin isolation level read committed'));
  assert(backfill.includes("set local sgodx.purchase_assignment_context = 'backfill'"));
  assert(backfill.includes('order by approved_at asc, id asc'));
  assert(backfill.includes('assigned_queue_position'));
  assert(backfill.includes('order by purchase_queue_position asc'));
  assert(backfill.includes('queue_sequence_behind_historical_positions'));
  assert(backfill.includes('and orders.purchase_number is null'));
  assert(backfill.includes('approved_orders_without_approved_at'));
  assert(!/\bsetval\s*\(/i.test(backfill));
  assert(backfill.indexOf("assignment_state = 'live'") < backfill.indexOf('\ncommit;'));
  assert(migration.includes('security definer\nset search_path = pg_catalog, pg_temp'));
  assert(migration.includes('revoke all on function public.assign_purchase_number_v1(uuid) from public, anon, authenticated'));
  assert(migration.includes('grant execute on function public.assign_purchase_number_v1(uuid) to service_role'));
  assert(migration.includes('cache 1 no cycle'));
  assert(migration.includes('select pg_catalog.setval('));
  assert(migration.indexOf('select pg_catalog.setval(')
    < migration.indexOf('create function public.guard_purchase_queue_v1()'));
  assert(migration.includes('revoke all on sequence public.purchase_queue_position_v1_seq from public, anon, authenticated, service_role'));
  const guard = migration.split('$queue_guard$')[1];
  assert(guard.includes('pg_catalog.nextval'));
  assert(!/for\s+update|from\s+public.purchase_counter/i.test(guard));
  assert(guard.includes('purchase_queue_position_is_immutable'));
  assert(guard.includes('purchase_number_is_permanent'));
  assert(guard.includes("v_assignment_context = 'backfill'"));
  assert(guard.includes("session_user = 'postgres'"));
  assert(migration.includes("set_config('sgodx.purchase_assignment_context', 'rpc', true)"));
  const functionBody = migration.split('$function$')[1];
  assert(!/\b(nextval|setval)\s*\(/i.test(functionBody));
  assert(!/\b(commit|rollback|execute)\b/i.test(functionBody.replace(/--[^\n]*/g, '')));
  assert(!/exception\s+when|on\s+conflict/i.test(functionBody));
  assert(functionBody.includes("v_milestone.status = 'active'"));
  assert(functionBody.includes('v_rule.published_at <= v_awarded_at'));
  for (const field of ['milestone_name', 'reward_type', 'reward_amount', 'reward_currency', 'rules_version']) {
    assert(functionBody.includes(field));
  }
  assert(!/\b(insert|update|delete)\s+(into\s+)?public\./i.test(migration.split('$function$')[2]));
});

console.log(`PASS: ${checks.length} offline purchase-number checks. No SQL, database, provider, email or image service contacted.`);
