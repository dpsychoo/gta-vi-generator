import { Resend } from 'resend';
import { getJob, updateJob } from './job-store';
import { getAppBaseUrl, getResendApiKey, getResendFromEmail } from './server/env';

const emailSendInFlight = new Set<string>();

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getResultUrl(jobId: string) {
  const baseUrl = new URL(getAppBaseUrl());
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('APP_BASE_URL inválida');
  }

  return new URL(`/resultado?jobId=${encodeURIComponent(jobId)}`, baseUrl).toString();
}

function getEmailHtml(resultUrl: string) {
  const safeResultUrl = escapeHtml(resultUrl);
  return `
    <div style="margin:0;background:#080910;padding:40px 20px;font-family:Arial,Helvetica,sans-serif;color:#f4f1ff;">
      <div style="max-width:560px;margin:0 auto;background:#141522;border:1px solid #2a2b3c;border-radius:18px;padding:36px;">
        <p style="margin:0 0 28px;color:#f5c7ff;font-size:13px;font-weight:700;letter-spacing:4px;">SGODX</p>
        <h1 style="margin:0 0 14px;font-size:30px;line-height:1.15;color:#ffffff;">Tu imagen ya está lista</h1>
        <p style="margin:0 0 28px;color:#c7c5d3;font-size:16px;line-height:1.6;">La generación terminó correctamente. Ya puedes ver y descargar tu resultado.</p>
        <a href="${safeResultUrl}" style="display:inline-block;border-radius:999px;background:#e94fae;color:#ffffff;padding:14px 24px;font-size:13px;font-weight:700;letter-spacing:1px;text-decoration:none;">VER Y DESCARGAR IMAGEN</a>
      </div>
    </div>
  `;
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

    const resultUrl = getResultUrl(job.id);
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [job.email],
      subject: 'Tu imagen está lista 🎨',
      html: getEmailHtml(resultUrl),
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
