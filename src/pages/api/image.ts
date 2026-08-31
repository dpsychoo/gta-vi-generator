import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { verifyJobAccess } from '../../lib/job-access';
import { getJob } from '../../lib/job-store';
import { getSupabaseAdmin, getSupabaseGeneratedBucket, isSupabaseConfigured } from '../../lib/supabase';

export const prerender = false;

const privateNoStoreHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
};

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('jobId')?.trim() || '';
  const accessToken = url.searchParams.get('token');

  if (!jobId || !accessToken) {
    return new Response('Resultado no disponible', {
      status: 404,
      headers: privateNoStoreHeaders,
    });
  }

  try {
    const job = await getJob(jobId);
    if (!job || !verifyJobAccess(job, accessToken) || job.status !== 'completed' || !job.outputImagePath) {
      return new Response('No se encontró la imagen', {
        status: 404,
        headers: privateNoStoreHeaders,
      });
    }

    if (isSupabaseConfigured()) {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage.from(getSupabaseGeneratedBucket()).download(job.outputImagePath);
      if (error || !data) {
        return new Response('No se encontró la imagen', {
          status: 404,
          headers: privateNoStoreHeaders,
        });
      }
      const arrayBuffer = await data.arrayBuffer();
      return new Response(Buffer.from(arrayBuffer), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': `inline; filename="result.png"`,
          ...privateNoStoreHeaders,
        },
      });
    }

    const buffer = await readFile(job.outputImagePath);
    return new Response(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="result.png"`,
        ...privateNoStoreHeaders,
      },
    });
  } catch {
    return new Response('No se encontró la imagen', {
      status: 404,
      headers: privateNoStoreHeaders,
    });
  }
};
