import type { APIRoute } from 'astro';
import { verifyJobAccess } from '../../lib/job-access';
import { getJob } from '../../lib/job-store';

export const prerender = false;

const privateNoStoreHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
};

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

  const safePayload = {
    id: job.id,
    status: job.status,
    payment_status: job.paymentStatus,
    resultUrl: job.status === 'completed'
      ? `/api/image?jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(accessToken)}`
      : null,
    error: job.status === 'failed' ? (job.errorMessage || 'La generación falló') : null,
  };

  return new Response(JSON.stringify(safePayload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...privateNoStoreHeaders },
  });
};
