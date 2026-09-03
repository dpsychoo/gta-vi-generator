import type { APIRoute } from 'astro';
import sharp from 'sharp';
import {
  encryptJobAccessToken,
  generateJobAccessToken,
  hashJobAccessToken,
} from '../../lib/job-access';
import { attachJobInputImages, createJob, updateJob } from '../../lib/job-store';
import { createLegalAcceptance } from '../../lib/legal-acceptance';
import { isCurrentLegalConsent } from '../../lib/legal';
import {
  createMercadoPagoPreference,
  MercadoPagoIntegrationError,
} from '../../lib/mercadopago';
import { validateImageFile } from '../../lib/image-validation.js';
import { getAppBaseUrl } from '../../lib/server/env';
import { SupabaseBackendError } from '../../lib/supabase';

const GENERIC_PAYMENT_ERROR = 'No se pudo iniciar el pago. Inténtalo nuevamente.';

sharp.block({
  operation: [
    'VipsForeignLoadNsgif',
    'VipsForeignLoadTiff',
    'VipsForeignLoadVips',
  ],
});

function isAllowedRequestOrigin(request: Request) {
  if (!import.meta.env.PROD) {
    return true;
  }

  const requestOriginHeader = request.headers.get('origin');
  if (!requestOriginHeader) {
    return false;
  }

  try {
    const configuredUrl = new URL(getAppBaseUrl());
    const requestUrl = new URL(requestOriginHeader);
    return configuredUrl.protocol === 'https:'
      && requestUrl.protocol === 'https:'
      && requestUrl.origin === configuredUrl.origin;
  } catch {
    return false;
  }
}

function getFormString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isAllowedRequestOrigin(request)) {
    console.warn('[create-job] rejected_origin');
    return new Response(JSON.stringify({ ok: false, error: 'Solicitud no autorizada.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data') && !contentType.includes('application/x-www-form-urlencoded')) {
      return new Response(JSON.stringify({ ok: false, error: 'Formato de formulario inválido. Se requiere multipart/form-data.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const formData = await request.formData();
    const email = getFormString(formData, 'email');
    const files = Array.from(formData.getAll('images')).filter((item): item is File => item instanceof File);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ ok: false, error: 'Email inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (files.length < 1 || files.length > 2) {
      return new Response(JSON.stringify({ ok: false, error: 'Debes adjuntar entre 1 y 2 imágenes' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validar que todas las imágenes sean válidas
    for (const file of files) {
      const validation = await validateImageFile(file, (buffer) => sharp(buffer).metadata());
      if (!validation.valid) {
        return new Response(JSON.stringify({ ok: false, error: validation.error || 'Archivo inválido' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const legalConsent = {
      legalAccepted: getFormString(formData, 'legalAccepted') === 'true',
      immediateExecutionAccepted: getFormString(formData, 'immediateExecutionAccepted') === 'true',
      retractExclusionAcknowledged: getFormString(formData, 'retractExclusionAcknowledged') === 'true',
      termsVersion: getFormString(formData, 'termsVersion'),
      privacyVersion: getFormString(formData, 'privacyVersion'),
      refundPolicyVersion: getFormString(formData, 'refundPolicyVersion'),
    };

    if (!legalConsent.legalAccepted || !legalConsent.immediateExecutionAccepted || !legalConsent.retractExclusionAcknowledged) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Debes aceptar el consentimiento legal y el inicio inmediato antes de continuar.',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!isCurrentLegalConsent(legalConsent)) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Las versiones legales ya no están vigentes. Recarga la página e inténtalo nuevamente.',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const accessToken = generateJobAccessToken();
    const job = await createJob({
      email,
      accessTokenHash: hashJobAccessToken(accessToken),
      accessTokenEncrypted: encryptJobAccessToken(accessToken),
    });
    try {
      await createLegalAcceptance({
        jobId: job.id,
        termsVersion: legalConsent.termsVersion,
        privacyVersion: legalConsent.privacyVersion,
        refundPolicyVersion: legalConsent.refundPolicyVersion,
        immediateExecutionAccepted: legalConsent.immediateExecutionAccepted,
        retractExclusionAcknowledged: legalConsent.retractExclusionAcknowledged,
        source: 'generator_checkout',
      });
    } catch (error) {
      console.error('[create-job] legal_acceptance_failed');
      try {
        await updateJob(job.id, {
          status: 'failed',
          paymentStatus: 'pending',
          errorMessage: 'No se pudo persistir la aceptación legal antes del checkout.',
        });
      } catch {
        console.error('[create-job] legal_acceptance_failure_status_update_failed');
      }
      throw error;
    }
    await attachJobInputImages(job.id, files);
    const payment = await createMercadoPagoPreference({
      jobId: job.id,
      email: job.email,
      accessToken,
    });
    const updatedJob = await updateJob(job.id, {
      mercadopagoPreferenceId: payment.id,
      paymentUrl: payment.initPoint,
      externalReference: job.id,
      errorMessage: null,
    });

    if (!updatedJob) {
      throw new Error('No se pudo guardar la preferencia del job.');
    }

    return new Response(JSON.stringify({
      jobId: job.id,
      paymentUrl: payment.initPoint,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof MercadoPagoIntegrationError) {
      console.error(`[create-job] ${error.code}`);
      return new Response(JSON.stringify({
        ok: false,
        error: GENERIC_PAYMENT_ERROR,
      }), {
        status: error.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (error instanceof SupabaseBackendError) {
      const diagnostic = import.meta.env.DEV && error.diagnostic ? `; provider=${error.diagnostic}` : '';
      console.error(`[create-job] ${error.code}: ${error.message}${diagnostic}`);
      return new Response(JSON.stringify({ ok: false, error: GENERIC_PAYMENT_ERROR }), {
        status: error.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const errorName = error instanceof Error ? error.name : typeof error;
    const candidateCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const safeCode = /^[a-zA-Z0-9_-]{1,32}$/.test(candidateCode) ? candidateCode : 'none';
    const stackFrames = error instanceof Error
      ? (error.stack || '').split('\n').slice(1, 5).map((line) => line.trim()).join(' | ')
      : '';
    if (import.meta.env.DEV) {
      console.error(`[create-job] unexpected ${errorName}; code=${safeCode}${stackFrames ? `; at ${stackFrames}` : ''}`);
    } else {
      console.error('[create-job] unexpected error');
    }
    return new Response(JSON.stringify({ ok: false, error: GENERIC_PAYMENT_ERROR }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
