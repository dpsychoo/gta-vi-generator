import type { APIRoute } from 'astro';
import { getJob, getJobResultSignedUrl } from '../../lib/job-store';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('jobId');

  if (!jobId) {
    return new Response(JSON.stringify({ error: 'jobId requerido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const job = await getJob(jobId);

  if (!job) {
    return new Response(JSON.stringify({ error: 'Job no encontrado' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const safePayload = {
    id: job.id,
    status: job.status,
    payment_status: job.paymentStatus,
    resultUrl: job.status === 'completed' ? await getJobResultSignedUrl(job) || `${process.env.APP_BASE_URL || 'http://localhost:4321'}/api/image?path=${encodeURIComponent(job.outputImagePath || job.generatedImage || '')}` : null,
    error: job.status === 'failed' ? (job.errorMessage || 'La generación falló') : null,
  };

  return new Response(JSON.stringify(safePayload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
