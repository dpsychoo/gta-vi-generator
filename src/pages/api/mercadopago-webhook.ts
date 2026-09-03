import type { APIRoute } from 'astro';
import {
  claimApprovedPaymentForProcessing,
  getJob,
  recordUnapprovedPayment,
  updateJob,
} from '../../lib/job-store';
import {
  getExpectedJobPaymentConfig,
  getMercadoPagoMerchantOrder,
  getMercadoPagoPayment,
  getRequiredMercadoPagoWebhookSecret,
  isValidMercadoPagoPaymentId,
  mapMercadoPagoPaymentStatus,
  MercadoPagoIntegrationError,
  validateMercadoPagoWebhookSignature,
  type MercadoPagoPayment,
} from '../../lib/mercadopago';
import { DevelopmentGenerationError, processPaidJob } from '../../lib/openai';
import { sendPurchaseConfirmationEmail } from '../../lib/email';
import {
  getLegalAcceptanceByJobId,
  updateLegalAcceptanceCustomerId,
} from '../../lib/legal-acceptance';
import { isLegalCenterV1Job } from '../../lib/legal';
import { ensureSgxPassForApprovedOrder } from '../../lib/sgx-pass';
import { SupabaseBackendError } from '../../lib/supabase';

export const prerender = false;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WebhookBody = {
  type?: unknown;
  data?: {
    id?: unknown;
  };
};

function jsonResponse(payload: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseWebhookBody(rawBody: string): WebhookBody | null {
  if (!rawBody.trim()) {
    return {};
  }

  try {
    const value = JSON.parse(rawBody);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as WebhookBody
      : null;
  } catch {
    return null;
  }
}

function getBodyDataId(body: WebhookBody) {
  const value = body.data?.id;
  return value === undefined || value === null ? '' : String(value).trim();
}

async function getVerifiedPreferenceId(payment: MercadoPagoPayment, jobId: string) {
  let preferenceId = payment.preferenceId;

  if (payment.orderId) {
    const order = await getMercadoPagoMerchantOrder(payment.orderId);
    if (order.externalReference && order.externalReference !== jobId) {
      return { valid: false, preferenceId: null };
    }
    if (preferenceId && order.preferenceId && preferenceId !== order.preferenceId) {
      return { valid: false, preferenceId: null };
    }
    preferenceId = preferenceId || order.preferenceId;
  }

  return { valid: true, preferenceId };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const queryDataId = (url.searchParams.get('data.id') || '').trim();
    const queryType = (url.searchParams.get('type') || url.searchParams.get('topic') || '').trim();
    const xRequestId = request.headers.get('x-request-id');
    const xSignature = request.headers.get('x-signature');
    const secret = getRequiredMercadoPagoWebhookSecret();
    const rawBody = await request.text();
    const body = parseWebhookBody(rawBody);

    if (!xRequestId || !validateMercadoPagoWebhookSignature({
      xSignature,
      xRequestId,
      dataId: queryDataId || null,
      secret,
    })) {
      console.warn('[mercadopago-webhook] invalid_signature');
      return jsonResponse({ ok: false, error: 'Webhook no autorizado.' }, 401);
    }

    if (!body) {
      return jsonResponse({ ok: false, error: 'Webhook inválido.' }, 400);
    }

    const bodyType = typeof body.type === 'string' ? body.type.trim() : '';
    const notificationType = (queryType || bodyType).toLowerCase();
    if (notificationType !== 'payment') {
      return jsonResponse({ ok: true, ignored: true }, 200);
    }

    const bodyDataId = getBodyDataId(body);
    if (queryDataId && bodyDataId && bodyDataId !== queryDataId) {
      return jsonResponse({ ok: false, error: 'Webhook inconsistente.' }, 400);
    }

    const paymentId = queryDataId || bodyDataId;
    if (!isValidMercadoPagoPaymentId(paymentId)) {
      return jsonResponse({ ok: false, error: 'payment_id inválido.' }, 400);
    }

    const expected = getExpectedJobPaymentConfig();
    const payment = await getMercadoPagoPayment(paymentId);
    console.info(`[mercadopago-webhook] payment_http_status=${payment.httpStatus}`);

    const jobId = payment.externalReference || '';
    if (!UUID_PATTERN.test(jobId)) {
      console.warn('[mercadopago-webhook] invalid_external_reference');
      return jsonResponse({ ok: true, ignored: true }, 200);
    }

    const job = await getJob(jobId);
    if (!job) {
      console.warn('[mercadopago-webhook] job_not_found');
      return jsonResponse({ ok: true, ignored: true }, 200);
    }

    const orderPreference = await getVerifiedPreferenceId(payment, jobId);
    const paymentMatchesJob = payment.externalReference === job.id
      && job.externalReference === job.id
      && payment.currencyId === expected.currency
      && payment.transactionAmount === expected.price
      && Boolean(job.mercadopagoPreferenceId)
      && orderPreference.valid
      && orderPreference.preferenceId === job.mercadopagoPreferenceId;

    if (!paymentMatchesJob) {
      await recordUnapprovedPayment({
        jobId,
        paymentId,
        paymentStatus: 'failed',
        errorMessage: 'El pago recibido no coincide con el cobro esperado.',
      });
      console.warn('[mercadopago-webhook] payment_validation_failed');
      return jsonResponse({ ok: true, accepted: false }, 200);
    }

    const mappedPaymentStatus = mapMercadoPagoPaymentStatus(payment.status);
    if (mappedPaymentStatus !== 'approved') {
      console.info(`[mercadopago-webhook] payment_status=${mappedPaymentStatus} generation_skipped`);
      await recordUnapprovedPayment({
        jobId,
        paymentId,
        paymentStatus: mappedPaymentStatus,
        errorMessage: mappedPaymentStatus === 'pending' ? null : 'El pago no fue aprobado.',
      });
      return jsonResponse({ ok: true, paymentStatus: mappedPaymentStatus }, 200);
    }

    const identity = await ensureSgxPassForApprovedOrder({
      email: job.email,
      jobId,
      paymentId,
      amount: expected.price,
      currency: expected.currency,
      approvedAt: new Date().toISOString(),
    });
    const associatedJob = await updateJob(jobId, {
      customerId: identity.customer.id,
      sgxPassId: identity.pass.id,
    });

    if (!associatedJob) {
      throw new Error('No se pudo asociar el job a la identidad SGX.');
    }

    const legalAcceptance = await getLegalAcceptanceByJobId(jobId);
    if (!legalAcceptance) {
      if (isLegalCenterV1Job(associatedJob)) {
        throw new Error('El job Legal Center v1 no tiene una aceptación legal persistida.');
      }

      console.info('[mercadopago-webhook] legacy_job_without_legal_acceptance');
    } else {
      const associatedAcceptance = await updateLegalAcceptanceCustomerId(jobId, identity.customer.id);
      if (!associatedAcceptance) {
        throw new Error('No se pudo asociar la aceptación legal del job aprobado.');
      }

      await sendPurchaseConfirmationEmail({
        jobId,
        customer: identity.customer,
        order: identity.order,
      });
    }

    const claim = await claimApprovedPaymentForProcessing({ jobId, paymentId });
    if (!claim.claimed) {
      console.info(`[mercadopago-webhook] generation_skipped=${claim.reason}`);
      return jsonResponse({ ok: true, skipped: true }, 200);
    }

    await processPaidJob(jobId);
    return jsonResponse({ ok: true, paymentStatus: 'approved', jobStatus: 'completed' }, 200);
  } catch (error) {
    if (error instanceof MercadoPagoIntegrationError) {
      console.error(`[mercadopago-webhook] ${error.code}`);
      return jsonResponse({ ok: false, error: 'No se pudo verificar el pago.' }, error.statusCode);
    }

    if (error instanceof SupabaseBackendError) {
      console.error(`[mercadopago-webhook] ${error.code}`);
      return jsonResponse({ ok: false, error: 'No se pudo actualizar el pedido.' }, error.status);
    }

    if (error instanceof DevelopmentGenerationError) {
      console.error('[mercadopago-webhook] generation_failed');
      return jsonResponse({ ok: false, error: 'No se pudo completar la generación.' }, 500);
    }

    console.error('[mercadopago-webhook] unexpected_error');
    return jsonResponse({ ok: false, error: 'Error interno del webhook.' }, 500);
  }
};
