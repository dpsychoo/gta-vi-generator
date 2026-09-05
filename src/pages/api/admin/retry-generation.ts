import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { claimFailedApprovedJobForRecovery, getJob } from '../../../lib/job-store';
import { getCustomerById, getSgxOrderByJobId, getSgxPassById } from '../../../lib/sgx-pass';
import { processPaidJob } from '../../../lib/openai';
import { isSupabaseConfigured } from '../../../lib/supabase';
import { getGenerationRecoverySecret } from '../../../lib/server/env';
import { logGenerationFailure, type GenerationStage } from '../../../lib/generation-observability';

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Outcome = 'completed' | 'already_completed' | 'already_processing'
  | 'not_recoverable' | 'unauthorized' | 'misconfigured' | 'invalid_request'
  | 'backend_unavailable' | 'generation_failed' | 'method_not_allowed';

function response(outcome: Outcome, status: number) {
  return new Response(JSON.stringify({ ok: status < 400, outcome }), {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
  });
}

function hasValidAuthorization(request: Request, secret: string) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const received = Buffer.from(authorization.slice(7), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Bound the authenticated request, including chunked bodies, before parsing.
async function readJobId(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
    || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2048) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).length !== 1 || typeof body.job_id !== 'string') return null;
    return UUID.test(body.job_id) ? body.job_id : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export const POST: APIRoute = async ({ request }) => {
  if (request.method !== 'POST') return response('method_not_allowed', 405);
  // Lazy, route-local configuration. Never required at module import or boot.
  let secret: string | undefined;
  try { secret = getGenerationRecoverySecret(); }
  catch { return response('misconfigured', 503); }
  if (!secret || secret.length < 32) return response('misconfigured', 503);
  if (!hasValidAuthorization(request, secret)) return response('unauthorized', 401);
  const jobId = await readJobId(request);
  if (!jobId) return response('invalid_request', 400);

  let stage: GenerationStage = 'recovery_preconditions';
  try {
    // Do not allow the local-file fallback to participate in recovery.
    if (!isSupabaseConfigured()) return response('misconfigured', 503);
    const job = await getJob(jobId);
    if (!job || job.paymentStatus !== 'approved') return response('not_recoverable', 409);
    if (job.status === 'completed') return response('already_completed', 200);
    if (job.status === 'processing') return response('already_processing', 202);
    if (job.status !== 'failed' || job.outputImagePath !== null || job.mediaPurgedAt
      || !job.inputImage1Path || !job.updatedAt
      || !job.paymentId || !/^\d{1,32}$/.test(job.paymentId)
      || !job.customerId || !UUID.test(job.customerId)
      || !job.sgxPassId || !UUID.test(job.sgxPassId)) return response('not_recoverable', 409);

    const order = await getSgxOrderByJobId(jobId);
    const customer = await getCustomerById(job.customerId);
    const pass = await getSgxPassById(job.sgxPassId);
    if (!order || order.status !== 'approved' || order.jobId !== job.id
      || order.mercadopagoPaymentId !== job.paymentId
      || !customer || customer.id !== job.customerId
      || !pass || pass.id !== job.sgxPassId
      || order.customerId !== customer.id || order.sgxPassId !== pass.id
      || pass.customerId !== customer.id) return response('not_recoverable', 409);

    stage = 'recovery_claim';
    const claim = await claimFailedApprovedJobForRecovery(job);
    if (!claim.claimed) {
      if (claim.reason === 'already_completed') return response('already_completed', 200);
      if (claim.reason === 'already_processing') return response('already_processing', 202);
      return response('not_recoverable', 409);
    }
  } catch (error) {
    logGenerationFailure(jobId, stage, error);
    return response('backend_unavailable', 503);
  }

  // All exceptions from generation keep the normal processing -> failed
  // semantics. The generation wrapper emits its single sanitized failure log.
  try {
    await processPaidJob(jobId);
    return response('completed', 200);
  } catch {
    return response('generation_failed', 500);
  }
};
