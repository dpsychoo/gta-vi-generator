import type { APIRoute } from 'astro';
import { verifyJobAccess } from '../../lib/job-access';
import { getJob } from '../../lib/job-store';
import { getSgxPassById } from '../../lib/sgx-pass';

export const prerender = false;

const privateNoStoreHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
};

const GENERIC_GENERATION_ERROR = 'No pudimos generar tu imagen.';
const MODERATION_GENERATION_ERROR = 'No pudimos procesar una de las imágenes enviadas. No se realizó un nuevo cobro.';

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('jobId')?.trim() || '';
  const accessToken = url.searchParams.get('token');
  const unavailable = () => new Response(JSON.stringify({ error: 'Resultado no disponible' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...privateNoStoreHeaders },
  });

  if (!jobId || !accessToken) {
    return unavailable();
  }

  let job;
  try {
    job = await getJob(jobId);
  } catch {
    return unavailable();
  }

  if (!job || !verifyJobAccess(job, accessToken)) {
    return unavailable();
  }

  let sgxPass: { code: string; status: 'active' | 'suspended' | 'revoked' } | null = null;
  if (job.status === 'completed' && job.sgxPassId) {
    try {
      const pass = await getSgxPassById(job.sgxPassId);
      if (pass) {
        sgxPass = { code: pass.publicCode, status: pass.status };
      }
    } catch {
      // La vista del resultado sigue funcionando aunque falle la consulta secundaria del PASS.
    }
  }

  const safePayload = {
    status: job.status,
    payment_status: job.paymentStatus,
    resultUrl: job.status === 'completed'
      ? `/api/image?jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(accessToken)}`
      : null,
    sgxPass,
    error: job.status === 'failed'
      ? job.metadata?.generation_error_category === 'moderation_blocked'
        ? MODERATION_GENERATION_ERROR
        : GENERIC_GENERATION_ERROR
      : null,
  };

  return new Response(JSON.stringify(safePayload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...privateNoStoreHeaders },
  });
};
