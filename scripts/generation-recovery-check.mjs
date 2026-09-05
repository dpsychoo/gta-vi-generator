// Offline only: execute the real route, job-store, generation and email code.
// Mock service boundaries; never import the real Supabase SDK or call a network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const git = (...args) => execFileSync('git', ['-c', 'safe.directory=' + process.cwd().replaceAll('\\', '/'), ...args], { encoding: 'utf8' });
const baseline = git('show', 'HEAD:src/lib/openai.ts');
const nodeRequire = createRequire(import.meta.url);
const jobId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const passId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const requestId = 'req_0123456789abcdef0123456789abcdef';
const adminSecret = 'offline-fixture-only-not-a-real-secret';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const sensitive = 'Bearer fixture-sensitive https://example.invalid/?token=fixture user@example.invalid sk-fixture-secret';
const plain = (value) => JSON.parse(JSON.stringify(value));
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-09-04T12:00:00.000Z'])); }
  static now() { return Date.parse('2026-09-04T12:00:00.000Z'); }
}

const serviceMock = String.raw`
export class SupabaseBackendError extends Error {
  constructor(code, message, statusCode = 500) { super(message); this.name = 'SupabaseBackendError'; this.code = code; this.statusCode = statusCode; }
}
export function createSupabaseOperationError(code, message, cause, statusCode = 500) {
  const error = new SupabaseBackendError(code, message, statusCode); error.cause = cause; return error;
}
export const isSupabaseConfigured = () => globalThis.h.configured;
export const getSupabaseAdmin = () => globalThis.h.db;
export const getSupabaseGeneratedBucket = () => 'generated-images';
export const getSupabaseUploadsBucket = () => 'customer-uploads';
export const getSupabasePrivateBucket = () => 'system-private';
export const getMasterStyleReferencePath = () => 'styles/master.webp';
export const supabaseDownload = (...args) => globalThis.h.download(...args);
export const supabaseUpload = (...args) => globalThis.h.upload(...args);
export const supabaseGetSignedUrl = () => { throw new Error('Unexpected signed URL operation'); };
`;

async function compile(useBaseline = false) {
  const compiled = await build({
    stdin: { contents: [
      "export { POST } from './src/pages/api/admin/retry-generation.ts';",
      "export { getJob, claimFailedApprovedJobForRecovery } from './src/lib/job-store.ts';",
      "export { processPaidJob } from './src/lib/openai.ts';",
      "export * from './src/lib/generation-observability.ts';",
    ].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
    define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false',
      'import.meta.url': JSON.stringify(pathToFileURL(resolve('src/lib/job-store.ts')).href) },
    plugins: [{
      name: 'offline-services',
      setup(builder) {
        const replacements = new Map([
          ['supabase', serviceMock],
          ['astro:env/server', 'export const getSecret = name => globalThis.h.secrets[name];'],
          ['job-access', "export const decryptJobAccessToken = () => 'offline-capability';"],
          ['react', 'export const createElement = () => ({});'],
          ['react-email', "export const render = async () => '<p>Offline email fixture</p>';"],
          ['resend', 'export class Resend { emails = { send: (...args) => globalThis.h.send(...args) }; }'],
          ['email-components', 'export const GtaResultEmail = () => null; export const PurchaseConfirmationEmail = () => null;'],
        ]);
        builder.onResolve({ filter: /supabase$|^astro:env\/server$|job-access$|^react$|^react-email$|^resend$|\/emails\// }, (args) => {
          const key = args.path.endsWith('supabase') ? 'supabase'
            : args.path.endsWith('job-access') ? 'job-access'
              : args.path.includes('/emails/') ? 'email-components' : args.path;
          assert(replacements.has(key), 'Unmocked service: ' + args.path);
          return { path: key, namespace: 'offline' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'offline' }, (args) => ({ contents: replacements.get(args.path), loader: 'js' }));
        if (useBaseline) builder.onLoad({ filter: /[\\/]src[\\/]lib[\\/]openai\.ts$/ }, () => ({ contents: baseline, loader: 'ts' }));
      },
    }],
  });
  // Import with no configured harness: a required global secret would fail here.
  const context = { module: { exports: {} }, Buffer, Blob, Request, Response, URL, URLSearchParams,
    Error, TypeError, RangeError, SyntaxError, AbortSignal, Date: FixtureDate,
    FormData: class extends FormData {
      constructor(...args) { if (context.h.fail === 'form_preparation') throw new Error(sensitive); super(...args); }
    },
    fetch: (...args) => context.h.fetch(...args),
    console: Object.fromEntries(['info', 'error', 'warn', 'log'].map((level) => [level, (...args) => {
      if (context.h.throwLogs && args[0]?.event) throw new Error('Broken logging transport');
      context.h.logs.push({ level, args: plain(args) });
    }])),
    require(name) {
      if (name === 'node:fs/promises') return Object.fromEntries(['mkdir', 'readFile', 'writeFile', 'access']
        .map((key) => [key, () => { throw new Error('Local file fallback forbidden'); }]));
      assert(['node:crypto', 'node:path', 'node:url'].includes(name), 'Unexpected runtime module: ' + name);
      return nodeRequire(name);
    },
  };
  runInNewContext(compiled.outputFiles[0].text, context, { filename: 'offline-recovery.cjs' });
  return { api: context.module.exports, use(harness) { context.h = harness; } };
}

// Mock PostgREST executes the REAL query's predicates and payload atomically.
// This is not a reimplementation of claim eligibility or route control flow.
class Query {
  constructor(h, table) { this.h = h; this.table = table; this.filters = []; }
  select() { return this; }
  eq(key, value) { this.filters.push([key, value]); return this; }
  is(key, value) { return this.eq(key, value); }
  update(payload) { assert.equal(this.table, 'jobs', 'No commercial writes allowed'); this.payload = payload; return this; }
  single() { return this.execute(); }
  maybeSingle() { return this.execute(); }
  then(ok, bad) { return this.execute().then(ok, bad); }
  async execute() {
    const h = this.h;
    h.calls.push({ table: this.table, payload: plain(this.payload ?? null), filters: plain(this.filters) });
    if (h.fail === 'job_read' && this.table === 'jobs' && !this.payload && !h.readFailed) {
      h.readFailed = true; return { data: null, error: { message: sensitive } };
    }
    if ((h.fail === 'db_completion' && this.payload?.status === 'completed')
      || (h.fail === 'claim' && this.payload?.status === 'processing')) return { data: null, error: { message: sensitive, code: '40001' } };
    assert(Object.hasOwn(h.tables, this.table), 'Unexpected table: ' + this.table);
    const row = h.tables[this.table].find((candidate) => this.filters.every(([key, value]) => candidate[key] === value));
    if (row && this.payload) { Object.assign(row, plain(this.payload)); h.writes++; }
    return { data: row ? plain(row) : null, error: null };
  }
}

function fixture() {
  const h = {
    configured: true, fail: null, logs: [], calls: [], writes: 0, requests: 0,
    events: [], forms: [], objects: [], emails: [], hold: null,
    secrets: { GENERATION_RECOVERY_SECRET: adminSecret, OPENAI_API_KEY: 'offline-openai-key',
      OPENAI_STYLE_PROMPT: 'offline prompt never log', RESEND_API_KEY: 'offline-resend-key',
      RESEND_FROM_EMAIL: 'sender@example.invalid', APP_BASE_URL: 'https://app.example.invalid' },
    tables: {
      jobs: [{ id: jobId, status: 'failed', payment_status: 'approved', payment_id: '123456789',
        customer_id: customerId, sgx_pass_id: passId, email: 'recipient@example.invalid',
        access_token_encrypted: 'offline-encrypted', input_image_1_path: jobId + '/input-1.jpg',
        input_image_2_path: jobId + '/input-2.png', output_image_path: null,
        media_purged_at: null, media_retention_started_at: null, error_message: 'prior failure',
        email_status: 'pending', metadata: { original: true }, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z' }],
      orders: [{ id: otherId, job_id: jobId, customer_id: customerId, sgx_pass_id: passId,
        mercadopago_payment_id: '123456789', status: 'approved', amount: 1, currency: 'CLP',
        purchase_queue_position: 4, purchase_number: null }],
      customers: [{ id: customerId, email: 'recipient@example.invalid', normalized_email: 'recipient@example.invalid' }],
      sgx_passes: [{ id: passId, customer_id: customerId, public_code: 'FIXTURE', status: 'active' }],
    },
  };
  h.db = { from: (table) => new Query(h, table) };
  h.download = async (bucket, path) => {
    const stage = bucket === 'system-private' ? 'style_reference' : path.includes('input-1') ? 'input_1_download' : 'input_2_download';
    h.events.push(['download', bucket, path]);
    if (h.fail === stage) throw new Error(sensitive);
    return new Blob([h.fail === stage + '_empty' ? Buffer.alloc(0) : png],
      { type: path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  };
  h.upload = async (bucket, path, bytes, mime) => {
    h.events.push(['upload', bucket, path, mime]);
    if (h.fail === 'storage_upload') throw Object.assign(new Error(sensitive), { code: 'SUPABASE_UPLOAD_FAILED' });
    h.objects.push({ bucket, path, mime, bytes: bytes.toString('base64') });
  };
  h.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(options.method, 'POST');
    assert(options.signal instanceof AbortSignal);
    h.requests++; h.events.push(['openai', url, options.method]);
    const entries = [];
    for (const [key, value] of options.body) entries.push([key, typeof value === 'string' ? value
      : { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()).toString('base64') }]);
    h.forms.push(entries);
    if (h.hold) await h.hold;
    if (h.fail === 'openai_request') throw Object.assign(new Error(sensitive), { code: 'ECONNRESET' });
    const headers = { 'x-request-id': requestId, 'Content-Type': 'application/json' };
    if (h.fail === 'openai_http') return new Response(JSON.stringify({ error: {
      code: 'rate_limit_exceeded', type: 'rate_limit_error', message: sensitive,
    } }), { status: 429, headers });
    if (h.fail === 'openai_json') return new Response('not json', { headers });
    if (h.fail === 'openai_b64') return new Response(JSON.stringify({ data: [] }), { headers });
    return new Response(JSON.stringify({ data: [{ b64_json: h.fail === 'output_decode'
      ? Buffer.from('invalid PNG').toString('base64') : png.toString('base64') }] }), { headers });
  };
  h.send = async (payload, options) => {
    assert.equal(h.tables.jobs[0].status, 'completed');
    assert(h.objects.length > 0, 'Email must follow storage and completion');
    assert.equal(options.idempotencyKey, 'job-result/' + jobId, 'No purchase confirmation');
    h.emails.push({ payload: plain(payload), options: plain(options) }); h.events.push(['email']);
    return { error: h.fail === 'result_email' ? { message: sensitive } : null };
  };
  return h;
}

const current = await compile();
const stable = await compile(true);
const job = (h) => h.tables.jobs[0];
const commercial = (h) => plain({ orders: h.tables.orders, customers: h.tables.customers, passes: h.tables.sgx_passes });
const failures = (h) => h.logs.map((entry) => entry.args[0]).filter((entry) => entry?.event === 'generation_failure');
async function invoke(h, options = {}) {
  current.use(h);
  const method = options.method ?? 'POST';
  const headers = { 'Content-Type': options.contentType ?? 'application/json' };
  if (options.auth !== null) headers.Authorization = options.auth ?? 'Bearer ' + adminSecret;
  const response = await current.api.POST({ request: new Request('https://offline.invalid/api/admin/retry-generation' + (options.query ?? ''), {
    method, headers, ...(method === 'POST' ? { body: options.rawBody ?? JSON.stringify(options.body ?? { job_id: jobId }) } : {}),
  }) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'outcome']);
  return { status: response.status, ...body };
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }

await check('adversarial sanitizer: no arbitrary strings, bodies, secrets or throwing getters', async () => {
  const { buildGenerationFailureLog, sanitizeGenerationMessage } = current.api;
  const cases = [sensitive, 'Bearer abc-123', 'https://example.invalid/?token=secret', 'user@example.com',
    'sk-not-a-real-key', 'A'.repeat(8192), 'data:image/png;base64,aGVsbG8=', 'shortB64==',
    'an unlabelled private prompt', 'Authorization: secret', 'cookie=private',
    'customer-uploads/private/input.png', 'encrypted_token=private', '{"raw_provider_body":"private"}'];
  for (const value of cases) {
    const log = buildGenerationFailureLog(value, value, {
      name: value, message: value, code: value, status: value, requestId: value, stack: value,
      cause: { message: value, errorCode: value }, toJSON() { throw new Error('must not run'); },
      toString() { throw new Error('must not run'); },
    });
    assert(!JSON.stringify(log).includes(value), 'Untrusted text leaked');
    assert.equal(log.error_message, 'Generation preconditions failed.');
    assert.equal(sanitizeGenerationMessage(value), log.error_message);
  }
  const log = buildGenerationFailureLog(jobId, 'openai_response', Object.assign(new Error(sensitive), {
    openAIHttpStatus: 429, requestId, code: 'rate_limit_exceeded',
  }));
  assert.equal(log.job_id, jobId); assert.equal(log.stage, 'openai_response');
  assert.equal(log.http_status, 429); assert.equal(log.provider_request_id, requestId);
  assert.equal(log.error_code, 'rate_limit_exceeded'); assert(!JSON.stringify(log).includes('fixture-sensitive'));
  const cycle = new Error(sensitive); cycle.cause = cycle;
  assert.doesNotThrow(() => buildGenerationFailureLog(jobId, 'preflight', cycle));
  assert.doesNotThrow(() => buildGenerationFailureLog(jobId, 'preflight', new Proxy({}, {
    get() { throw new Error('malicious getter'); },
  })));
});

await check('missing secret is route-local; normal paid generation and imports still work', async () => {
  for (const secret of [undefined, '', 'too-short']) {
    const h = fixture(); h.secrets.GENERATION_RECOVERY_SECRET = secret;
    assert.equal((await invoke(h)).outcome, 'misconfigured'); assert.equal(h.calls.length, 0);
  }
  const h = fixture(); delete h.secrets.GENERATION_RECOVERY_SECRET;
  job(h).status = 'processing'; current.use(h);
  await current.api.processPaidJob(jobId);
  assert.equal(job(h).status, 'completed'); assert.equal(h.emails.length, 1);
});

await check('POST Bearer-only auth, constant-time helper, bounded strict UUID JSON and generic responses', async () => {
  for (const auth of [null, 'Bearer wrong', 'Bearer ' + 'x'.repeat(adminSecret.length), 'Basic ' + adminSecret]) {
    const h = fixture();
    assert.equal((await invoke(h, { auth, query: '?secret=' + adminSecret })).status, 401);
    assert.equal(h.calls.length, 0);
  }
  assert.equal((await invoke(fixture(), { method: 'GET' })).status, 405);
  for (const options of [
    { body: { job_id: 'bad' } }, { body: { job_id: jobId, extra: true } },
    { body: [] }, { body: {} }, { body: { job_id: ' ' + jobId } },
    { rawBody: 'null' }, { rawBody: '{' }, { rawBody: ' '.repeat(2049) },
    { contentType: 'text/plain' },
  ]) {
    const h = fixture(); assert.equal((await invoke(h, options)).status, 400); assert.equal(h.calls.length, 0);
  }
  const h = fixture(); h.configured = false;
  assert.equal((await invoke(h)).status, 503); assert.equal(h.calls.length, 0);
});

await check('failed+approved+null-output+retained inputs required; idempotent states do not write', async () => {
  for (const changes of [
    { status: 'pending_payment' }, { status: 'paid' }, { payment_status: 'pending' },
    { payment_status: 'rejected' }, { status: 'completed', payment_status: 'rejected' },
    { output_image_path: 'existing/result.png' }, { output_image_path: '' },
    { input_image_1_path: null }, { media_purged_at: '2026-09-02' }, { payment_id: null },
    { customer_id: null }, { sgx_pass_id: 'bad' }, { updated_at: null },
  ]) {
    const h = fixture(); Object.assign(job(h), changes);
    assert.equal((await invoke(h)).outcome, 'not_recoverable'); assert.equal(h.writes, 0); assert.equal(h.requests, 0);
  }
  for (const status of ['completed', 'processing']) {
    const h = fixture(); job(h).status = status;
    assert.equal((await invoke(h)).outcome, 'already_' + status); assert.equal(h.writes, 0);
  }
  const h = fixture(); h.tables.jobs = [];
  assert.equal((await invoke(h)).outcome, 'not_recoverable'); assert.equal(h.writes, 0);
});

await check('real Order/Customer/PASS readers enforce paid identity coherence without creating anything', async () => {
  const changes = [
    (h) => { h.tables.orders = []; }, (h) => { h.tables.customers = []; }, (h) => { h.tables.sgx_passes = []; },
    (h) => { h.tables.orders[0].status = 'pending'; }, (h) => { h.tables.orders[0].job_id = otherId; },
    (h) => { h.tables.orders[0].customer_id = otherId; }, (h) => { h.tables.orders[0].sgx_pass_id = otherId; },
    (h) => { h.tables.orders[0].mercadopago_payment_id = '999'; }, (h) => { h.tables.sgx_passes[0].customer_id = otherId; },
  ];
  for (const change of changes) {
    const h = fixture(); change(h);
    assert.equal((await invoke(h)).outcome, 'not_recoverable'); assert.equal(h.writes, 0); assert.equal(h.requests, 0);
  }
});

await check('success: real storage/completion/retention/result email; commercial data and inputs untouched', async () => {
  const h = fixture(); const before = commercial(h); const inputs = [job(h).input_image_1_path, job(h).input_image_2_path];
  assert.equal((await invoke(h)).outcome, 'completed');
  assert.equal(job(h).output_image_path, jobId + '/result.png'); assert.equal(job(h).email_status, 'sent');
  assert(job(h).media_retention_started_at); assert.equal(job(h).metadata.original, true);
  assert.deepEqual(commercial(h), before);
  assert.deepEqual([job(h).input_image_1_path, job(h).input_image_2_path], inputs);
  assert.equal((await invoke(h)).outcome, 'already_completed'); assert.equal(h.requests, 1); assert.equal(h.emails.length, 1);
  assert.equal(failures(h).length, 0);
  const fields = h.forms[0];
  assert.equal(fields.find(([key]) => key === 'model')[1], 'gpt-image-2');
  assert.equal(fields.find(([key]) => key === 'quality')[1], 'high');
  assert.equal(fields.find(([key]) => key === 'output_format')[1], 'png');
  assert(!fields.some(([key]) => key === 'size'));
  assert.deepEqual(fields.filter(([key]) => key === 'image[]').map(([, value]) => value.name), ['master.webp', 'input-1.jpg', 'input-2.png']);
});

await check('actual conditional claim: one concurrent winner; stale failed snapshot cannot be reclaimed', async () => {
  const h = fixture(); current.use(h); const snapshot = await current.api.getJob(jobId);
  const claims = await Promise.all([
    current.api.claimFailedApprovedJobForRecovery(snapshot),
    current.api.claimFailedApprovedJobForRecovery(snapshot),
  ]);
  assert.equal(claims.filter((value) => value.claimed).length, 1);
  assert.equal(claims.find((value) => !value.claimed).reason, 'already_processing');
  const claimCall = h.calls.find((call) => call.payload?.status === 'processing');
  for (const filter of [['id', jobId], ['status', 'failed'], ['payment_status', 'approved'], ['output_image_path', null],
    ['updated_at', snapshot.updatedAt], ['media_purged_at', null]]) {
    assert(claimCall.filters.some((actual) => JSON.stringify(actual) === JSON.stringify(filter)));
  }
  assert.deepEqual(Object.keys(claimCall.payload).sort(), ['error_message', 'status', 'updated_at']);
  job(h).status = 'failed'; job(h).updated_at = '2026-09-03T00:00:00.000Z';
  assert.equal((await current.api.claimFailedApprovedJobForRecovery(snapshot)).claimed, false);
  const concurrent = fixture(); let release;
  concurrent.hold = new Promise((resolveHold) => { release = resolveHold; });
  const first = invoke(concurrent); const second = invoke(concurrent);
  assert.equal((await Promise.race([first, second])).outcome, 'already_processing');
  release();
  const responses = await Promise.all([first, second]);
  assert.equal(responses.filter((result) => result.outcome === 'completed').length, 1);
  assert.equal(concurrent.requests, 1); assert.equal(concurrent.emails.length, 1);
});

const failureStages = {
  style_reference: 'style_reference', style_reference_empty: 'style_reference',
  input_1_download: 'input_1_download', input_1_download_empty: 'input_1_download',
  input_2_download: 'input_2_download', input_2_download_empty: 'input_2_download', form_preparation: 'form_preparation',
  openai_request: 'openai_request', openai_http: 'openai_response', openai_json: 'openai_response',
  openai_b64: 'openai_response', output_decode: 'output_decode', storage_upload: 'storage_upload', db_completion: 'db_completion',
};
await check('failure injection: each real stage logs once, returns failed, preserves payment/inputs/Order; retry remains possible', async () => {
  for (const [fail, stage] of Object.entries(failureStages)) {
    const h = fixture(); h.fail = fail; const before = commercial(h); const inputs = [job(h).input_image_1_path, job(h).input_image_2_path];
    const result = await invoke(h);
    assert.equal(result.outcome, 'generation_failed', fail); assert.equal(result.status, 500);
    assert.equal(job(h).status, 'failed', fail); assert.equal(job(h).payment_status, 'approved');
    assert.equal(job(h).output_image_path, null); assert.equal(h.emails.length, 0);
    assert.deepEqual(commercial(h), before);
    assert.deepEqual([job(h).input_image_1_path, job(h).input_image_2_path], inputs);
    assert.equal(failures(h).length, 1, fail); assert.equal(failures(h)[0].stage, stage, fail);
    assert(!JSON.stringify(h.logs).includes('fixture-sensitive'));
    h.fail = null; assert.equal((await invoke(h)).outcome, 'completed', 'retry after ' + fail);
  }
});

await check('logging failures non-fatal; email failure keeps completed; claim errors generic and sanitized', async () => {
  for (const fail of [null, 'storage_upload']) {
    const h = fixture(); h.throwLogs = true; h.fail = fail;
    assert.equal((await invoke(h)).outcome, fail ? 'generation_failed' : 'completed');
    assert.equal(job(h).status, fail ? 'failed' : 'completed');
  }
  const h = fixture(); h.fail = 'result_email';
  assert.equal((await invoke(h)).outcome, 'completed');
  assert.equal(job(h).status, 'completed'); assert.equal(job(h).email_status, 'failed');
  assert.equal(failures(h).length, 0);
  assert(h.logs.some((entry) => entry.args[0]?.event === 'generation_result_email' && entry.args[0].outcome === 'failed'));
  const claim = fixture(); claim.fail = 'claim';
  assert.equal((await invoke(claim)).outcome, 'backend_unavailable');
  assert.equal(job(claim).status, 'failed'); assert.equal(claim.requests, 0);
  assert.equal(failures(claim)[0].stage, 'recovery_claim'); assert(!JSON.stringify(claim.logs).includes('fixture-sensitive'));
});

async function runNormal(runtime, fail, twoInputs) {
  const h = fixture(); h.fail = fail; job(h).status = 'processing';
  if (!twoInputs) job(h).input_image_2_path = null;
  if (fail === 'missing_key') delete h.secrets.OPENAI_API_KEY;
  if (fail === 'missing_prompt') delete h.secrets.OPENAI_STYLE_PROMPT;
  runtime.use(h);
  let outcome;
  try { outcome = { result: await runtime.api.processPaidJob(jobId) }; }
  catch (error) { outcome = { error: { name: error.name, message: error.message, statusCode: error.statusCode,
    openAIHttpStatus: error.openAIHttpStatus, requestId: error.requestId, cause: error.cause?.message } }; }
  return plain({ outcome, tables: h.tables, events: h.events, forms: h.forms, objects: h.objects, emails: h.emails });
}
await check('HEAD differential: identical request/bytes/order/MIME/output/metadata/email/error propagation in 38 scenarios', async () => {
  for (const twoInputs of [false, true]) {
    for (const fail of [null, ...Object.keys(failureStages), 'result_email', 'job_read', 'missing_key', 'missing_prompt']) {
      const before = await runNormal(stable, fail, twoInputs);
      const after = await runNormal(current, fail, twoInputs);
      assert.deepEqual(after, before, 'functional regression: ' + fail + ', twoInputs=' + twoInputs);
    }
  }
});

await check('static boundaries: unchanged normal claim, lazy env, no numbering or commercial writes in recovery', async () => {
  const source = read('src/lib/job-store.ts');
  const prior = git('show', 'HEAD:src/lib/job-store.ts');
  const normalClaim = (text) => text.split('export async function claimApprovedPaymentForProcessing')[1]
    .split(/\/\/ Administrative recovery only|export async function recordUnapprovedPayment/)[0].trim().replaceAll('\r\n', '\n');
  assert.equal(normalClaim(source), normalClaim(prior));
  const route = read('src/pages/api/admin/retry-generation.ts');
  for (const forbidden of ['tryAssignPurchaseNumber', 'sendPurchaseConfirmationEmail', 'getOrCreate', '.rpc(', '.insert(', 'purchase_number', 'purchase_queue_position']) assert(!route.includes(forbidden), forbidden);
  assert(route.includes('timingSafeEqual(received, expected)'));
  assert(read('src/lib/server/env.ts').includes("return getOptionalServerEnv('GENERATION_RECOVERY_SECRET')"));
  assert(!read('astro.config.mjs').includes('GENERATION_RECOVERY_SECRET'));
  assert(read('src/lib/openai.ts').includes('const OPENAI_TIMEOUT_MS = 4 * 60 * 1000;'));
});
console.log('generation recovery tests: PASS (' + passed + ' groups; all service calls mocked, zero external I/O)');
