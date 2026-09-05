import { createElement } from 'react';
import { render } from 'react-email';
import { Resend } from 'resend';
import { GtaResultEmail } from '../emails/GtaResultEmail';
import { PurchaseConfirmationEmail } from '../emails/PurchaseConfirmationEmail';
import { decryptJobAccessToken } from './job-access';
import {
  getLegalAcceptanceByJobId,
  updateLegalAcceptanceConfirmation,
} from './legal-acceptance';
import { LEGAL_PATHS } from './legal';
import { getJob, updateJob } from './job-store';
import { getSgxOrderByJobId, getSgxPassById, type CustomerRecord, type SgxOrderRecord } from './sgx-pass';
import { getAppBaseUrl, getResendApiKey, getResendFromEmail } from './server/env';

const emailSendInFlight = new Set<string>();
const purchaseConfirmationInFlight = new Set<string>();

function getEmailUrls(job: { id: string; accessTokenEncrypted?: string | null }) {
  if (!job.accessTokenEncrypted) {
    throw new Error('El job no tiene capability cifrada.');
  }

  const accessToken = decryptJobAccessToken(job.accessTokenEncrypted);
  const baseUrl = new URL(getAppBaseUrl());
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (baseUrl.protocol !== 'https:' || localHosts.has(baseUrl.hostname)) {
    throw new Error('APP_BASE_URL debe ser una URL HTTPS pública para enviar resultados.');
  }

  const downloadUrl = new URL('/resultado', baseUrl);
  downloadUrl.searchParams.set('jobId', job.id);
  downloadUrl.searchParams.set('token', accessToken);

  const resultImageUrl = new URL('/api/image', baseUrl);
  resultImageUrl.searchParams.set('jobId', job.id);
  resultImageUrl.searchParams.set('token', accessToken);

  return {
    generatorUrl: new URL('/', baseUrl).toString(),
    downloadUrl: downloadUrl.toString(),
    resultImageUrl: resultImageUrl.toString(),
  };
}

function formatCreatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Santiago',
  }).format(date);
}

export async function sendJobResultEmail(jobId: string) {
  if (emailSendInFlight.has(jobId)) {
    return { ok: false, skipped: true, reason: 'in_flight' as const };
  }

  emailSendInFlight.add(jobId);
  let eligibleForFailureUpdate = false;

  try {
    const job = await getJob(jobId);
    if (!job || job.status !== 'completed' || !job.outputImagePath) {
      return { ok: false, skipped: true, reason: 'not_completed' as const };
    }

    if (job.emailStatus === 'sent') {
      return { ok: true, skipped: true, reason: 'already_sent' as const };
    }

    eligibleForFailureUpdate = true;
    console.info('[resend] send_started');

    const apiKey = getResendApiKey();
    const fromEmail = getResendFromEmail();
    if (!apiKey || !fromEmail) {
      throw new Error('Resend no está configurado');
    }

    const { generatorUrl, downloadUrl, resultImageUrl } = getEmailUrls(job);
    const sgxPass = job.sgxPassId ? await getSgxPassById(job.sgxPassId) : null;
    let purchaseNumber: string | null = null;
    try {
      const order = await getSgxOrderByJobId(job.id);
      purchaseNumber = order?.purchaseNumber ?? null;
    } catch {
      // Purchase branding is optional; a lookup failure must not block the result email.
    }
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [job.email],
      subject: 'Tu imagen SGODX ya está lista 🌴',
      html: await render(createElement(GtaResultEmail, {
        customerName: null,
        customerEmail: job.email,
        resultImageUrl,
        downloadUrl,
        orderId: job.id,
        createdAt: formatCreatedAt(job.createdAt),
        generatorUrl,
        sgxPassCode: sgxPass?.publicCode,
        sgxPassStatus: sgxPass?.status,
        purchaseNumber,
      })),
    }, {
      idempotencyKey: `job-result/${job.id}`,
    });

    if (error) {
      throw new Error('Resend rechazó el envío');
    }

    await updateJob(job.id, { emailStatus: 'sent' });
    console.info('[resend] send_success');
    return { ok: true, skipped: false };
  } catch {
    if (eligibleForFailureUpdate) {
      try {
        await updateJob(jobId, { emailStatus: 'failed' });
      } catch {
        // El resultado generado sigue siendo válido aunque falle esta actualización secundaria.
      }
    }

    console.error('[resend] send_failed');
    return { ok: false, skipped: false };
  } finally {
    emailSendInFlight.delete(jobId);
  }
}

function getLegalEmailUrls() {
  const baseUrl = new URL(getAppBaseUrl());
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (baseUrl.protocol !== 'https:' || localHosts.has(baseUrl.hostname)) {
    throw new Error('APP_BASE_URL debe ser una URL HTTPS pública para enviar confirmaciones.');
  }

  return {
    legalUrl: new URL(LEGAL_PATHS.center, baseUrl).toString(),
    termsUrl: new URL(LEGAL_PATHS.terms, baseUrl).toString(),
    privacyUrl: new URL(LEGAL_PATHS.privacy, baseUrl).toString(),
    refundsUrl: new URL(LEGAL_PATHS.refunds, baseUrl).toString(),
  };
}

export async function sendPurchaseConfirmationEmail({
  jobId,
  customer,
  order,
}: {
  jobId: string;
  customer: CustomerRecord;
  order: SgxOrderRecord;
}) {
  if (purchaseConfirmationInFlight.has(jobId)) {
    return { ok: false, skipped: true, reason: 'in_flight' as const };
  }

  purchaseConfirmationInFlight.add(jobId);
  let eligibleForFailureUpdate = false;

  try {
    const job = await getJob(jobId);
    const acceptance = await getLegalAcceptanceByJobId(jobId);
    if (!job || !acceptance) {
      throw new Error('No se encontró el job o la aceptación legal para la confirmación.');
    }

    if (acceptance.confirmationEmailStatus === 'sent') {
      return { ok: true, skipped: true, reason: 'already_sent' as const };
    }

    eligibleForFailureUpdate = true;
    const apiKey = getResendApiKey();
    const fromEmail = getResendFromEmail();
    if (!apiKey || !fromEmail) {
      throw new Error('Resend no está configurado');
    }

    const resend = new Resend(apiKey);
    const urls = getLegalEmailUrls();
    let sgxPassCode: string | null = null;
    try {
      const pass = await getSgxPassById(order.sgxPassId);
      sgxPassCode = pass?.publicCode ?? null;
    } catch {
      // The confirmation remains sendable if the optional PASS display lookup fails.
    }
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [customer.email],
      subject: 'Confirmación de compra SGODX',
      html: await render(createElement(PurchaseConfirmationEmail, {
        customerEmail: customer.email,
        orderId: order.id,
        paymentId: order.mercadopagoPaymentId,
        approvedAt: formatCreatedAt(order.approvedAt || order.createdAt),
        termsVersion: acceptance.termsVersion,
        privacyVersion: acceptance.privacyVersion,
        refundPolicyVersion: acceptance.refundPolicyVersion,
        sgxPassCode,
        ...urls,
      })),
    }, {
      idempotencyKey: `contract-confirmation/${job.id}`,
    });

    if (error) {
      throw new Error('Resend rechazó el envío de la confirmación.');
    }

    await updateLegalAcceptanceConfirmation(job.id, 'sent', new Date().toISOString());
    console.info('[resend] purchase_confirmation_success');
    return { ok: true, skipped: false };
  } catch {
    if (eligibleForFailureUpdate) {
      try {
        await updateLegalAcceptanceConfirmation(jobId, 'failed');
      } catch {
        // El estado del pago y la generación no dependen de este correo secundario.
      }
    }

    console.error('[resend] purchase_confirmation_failed');
    return { ok: false, skipped: false };
  } finally {
    purchaseConfirmationInFlight.delete(jobId);
  }
}
