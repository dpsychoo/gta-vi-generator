import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { getJob } from '../../lib/job-store';
import { getSupabaseAdmin, getSupabaseGeneratedBucket, isSupabaseConfigured } from '../../lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('jobId');

  if (!jobId) {
    return new Response(JSON.stringify({ error: 'jobId requerido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const job = await getJob(jobId);
    if (!job || job.status !== 'completed' || !job.outputImagePath) {
      return new Response('No se encontró la imagen', { status: 404 });
    }

    if (isSupabaseConfigured()) {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage.from(getSupabaseGeneratedBucket()).download(job.outputImagePath);
      if (error || !data) {
        return new Response('No se encontró la imagen', { status: 404 });
      }
      const arrayBuffer = await data.arrayBuffer();
      return new Response(Buffer.from(arrayBuffer), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': `inline; filename="result.png"`,
        },
      });
    }

    const buffer = await readFile(job.outputImagePath);
    return new Response(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="result.png"`,
      },
    });
  } catch {
    return new Response('No se encontró la imagen', { status: 404 });
  }
};
