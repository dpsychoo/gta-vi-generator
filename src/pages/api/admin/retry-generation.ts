import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { getJob, type JobRecord } from '../../../lib/job-store';
import { getCustomerById, getSgxOrderByJobId, getSgxPassById } from '../../../lib/sgx-pass';
import { processPaidJob, type GenerationStrategy } from '../../../lib/openai';
import { getSupabaseAdmin, isSupabaseConfigured } from '../../../lib/supabase';
import { getGenerationRecoverySecret } from '../../../lib/server/env';
import { logGenerationFailure, type GenerationStage } from '../../../lib/generation-observability';

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Outcome = 'completed' | 'already_completed' | 'already_processing'
  | 'not_recoverable' | 'unauthorized' | 'misconfigured' | 'invalid_request'
  | 'backend_unavailable' | 'generation_failed' | 'method_not_allowed';

type RecoveryRequest = {
  jobId: string;
  strategy: GenerationStrategy;
};

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

// The explicit fallback marker and the failed->processing transition are one
// conditional DB update. This makes omit_input2 single-use across restarts.
async function claimRecoveryJob(job: JobRecord, strategy: GenerationStrategy) {
  const isOmitInput2 = strategy === 'omit_input2';
  const metadata = isOmitInput2
    ? {
      ...(job.metadata || {}),
      generation_fallback_strategy: 'omit_input2',
      generation_fallback_attempted_at: new Date().toISOString(),
    }
    : undefined;
  let query = getSupabaseAdmin()
    .from('jobs')
    .update({
      status: 'processing',
      error_message: null,
      updated_at: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    })
    .eq('id', job.id)
    .eq('status', 'failed')
    .eq('payment_status', 'approved')
    .is('output_image_path', null)
    .eq('updated_at', job.updatedAt)
    .eq('payment_id', job.paymentId!)
    .eq('customer_id', job.customerId!)
    .eq('sgx_pass_id', job.sgxPassId!)
    .eq('input_image_1_path', job.inputImage1Path!)
    .is('media_purged_at', null);

  if (isOmitInput2) {
    query = query.is('metadata->>generation_fallback_strategy', null);
  }

  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw new Error('No se pudo reservar el job para recuperación.');
  return Boolean(data);
}

// Bound the authenticated request, including chunked bodies, before parsing.
async function readRecoveryRequest(request: Request): Promise<RecoveryRequest | null> {
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
      || typeof body.job_id !== 'string' || !UUID.test(body.job_id)) return null;

    const keys = Object.keys(body).sort();
    if (keys.length === 1 && keys[0] === 'job_id') {
      return { jobId: body.job_id, strategy: 'default' };
    }
    if (keys.length === 2 && keys[0] === 'job_id' && keys[1] === 'strategy'
      && body.strategy === 'omit_input2') {
      return { jobId: body.job_id, strategy: 'omit_input2' };
    }
    return null;
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
  const recoveryRequest = await readRecoveryRequest(request);
  if (!recoveryRequest) return response('invalid_request', 400);
  const { jobId, strategy } = recoveryRequest;

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

    if (strategy === 'omit_input2') {
      const category = job.metadata?.generation_error_category;
      const isModerationFailure = category === 'moderation_blocked';
      const isLegacyUnclassifiedFailure = category === undefined;
      const fallbackAlreadyAttempted = job.metadata?.generation_fallback_strategy === 'omit_input2';
      if (!job.inputImage2Path || fallbackAlreadyAttempted
        || (!isModerationFailure && !isLegacyUnclassifiedFailure)) {
        return response('not_recoverable', 409);
      }
    } else if (job.metadata?.generation_error_category === 'moderation_blocked') {
      // Do not silently replay the original master+input1+input2 request after
      // an explicit provider moderation decision.
      return response('not_recoverable', 409);
    }

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
    const claimed = await claimRecoveryJob(job, strategy);
    if (!claimed) {
      const current = await getJob(jobId);
      if (current?.status === 'completed') return response('already_completed', 200);
      if (current?.status === 'processing') return response('already_processing', 202);
      return response('not_recoverable', 409);
    }
  } catch (error) {
    logGenerationFailure(jobId, stage, error);
    return response('backend_unavailable', 503);
  }

  // All exceptions from generation keep the normal processing -> failed
  // semantics. The generation wrapper emits its single sanitized failure log.
  try {
    await processPaidJob(jobId, { generationStrategy: strategy });
    return response('completed', 200);
  } catch {
    return response('generation_failed', 500);
  }
};
