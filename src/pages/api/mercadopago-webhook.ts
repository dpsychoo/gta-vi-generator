import type { APIRoute } from 'astro';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getJob, updateJob } from '../../lib/job-store';
import { verifyMercadoPagoPayment } from '../../lib/mercadopago';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : {};
    const paymentId = String(body?.data?.id || body?.payment_id || body?.id || '').trim();
    const type = String(body?.type || '').trim();
    const signature = request.headers.get('x-signature') || request.headers.get('x-mp-signature') || '';
    const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      const candidate = signature.startsWith('v1=') ? signature.slice(3) : signature;
      const a = Buffer.from(expected);
      const b = Buffer.from(candidate);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return new Response(JSON.stringify({ ok: false, error: 'Webhook no autorizado' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (!paymentId && !type) {
      return new Response(JSON.stringify({ ok: false, error: 'Webhook inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const verified = await verifyMercadoPagoPayment(paymentId);
    const jobId = String(body?.data?.external_reference || body?.external_reference || body?.externalReference || '').trim();

    if (!jobId) {
      return new Response(JSON.stringify({ ok: true, status: verified.status, skipped: true, reason: 'external_reference missing' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const job = await getJob(jobId);
    if (job && (job.status === 'processing' || job.status === 'completed')) {
      return new Response(JSON.stringify({ ok: true, status: verified.status, skipped: true, reason: 'already processed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (job && job.paymentId && job.paymentId !== String(paymentId) && job.status !== 'failed') {
      return new Response(JSON.stringify({ ok: true, status: verified.status, skipped: true, reason: 'different payment already attached' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const paymentStatus = verified.status === 'approved' ? 'approved' : 'rejected';

    await updateJob(jobId, {
      status: verified.status === 'approved' ? 'paid' : 'failed',
      paymentStatus,
      paymentId: String(paymentId),
      externalReference: jobId,
      errorMessage: verified.status === 'approved' ? null : `Pago no aprobado: ${verified.status}`,
      metadata: {
        ...(job?.metadata || {}),
        webhookType: type || 'payment',
        paymentVerifiedAt: new Date().toISOString(),
      },
    });

    if (verified.status === 'approved') {
      await fetch(`${process.env.APP_BASE_URL || 'http://localhost:4321'}/api/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, paymentStatus: 'approved' }),
      });
    }

    return new Response(JSON.stringify({ ok: true, status: verified.status }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('mercadopago-webhook error', error);
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message || 'Error del webhook' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
