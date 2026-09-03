import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import {
  getSupabaseAdmin,
  getSupabaseGeneratedBucket,
  getSupabaseUploadsBucket,
  isSupabaseConfigured,
  SupabaseBackendError,
} from '../../../lib/supabase';
import { getCronSecret } from '../../../lib/server/env';

export const prerender = false;

const RETENTION_DAYS = 30;
const BATCH_SIZE = 100;

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hasValidCronAuthorization(request: Request, secret: string) {
  const authorization = request.headers.get('authorization') || '';
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return false;
  }

  const received = Buffer.from(authorization.slice(prefix.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isMissingStorageObject(error: unknown) {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = Number(record.status ?? record.statusCode);
  const message = String(record.message || '').toLowerCase();
  return status === 404 || message.includes('not found') || message.includes('not_found') || message.includes('does not exist');
}

async function removeStoragePaths(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  bucket: string,
  paths: string[],
) {
  if (!paths.length) {
    return;
  }

  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error && !isMissingStorageObject(error)) {
    throw error;
  }
}

export const GET: APIRoute = async ({ request }) => {
  const secret = getCronSecret();
  if (!secret) {
    return jsonResponse({ ok: false, error: 'CRON_SECRET no está configurado.' }, 503);
  }

  if (!hasValidCronAuthorization(request, secret)) {
    return jsonResponse({ ok: false, error: 'Cron no autorizado.' }, 401);
  }

  try {
    if (!isSupabaseConfigured()) {
      return jsonResponse({ ok: false, error: 'Supabase no está configurado.' }, 503);
    }

    const supabase = getSupabaseAdmin();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: jobs, error } = await supabase
      .from('jobs')
      .select('id, media_retention_started_at, input_image_1_path, input_image_2_path, output_image_path')
      .lt('media_retention_started_at', cutoff)
      .not('media_retention_started_at', 'is', null)
      .is('media_purged_at', null)
      .order('media_retention_started_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      throw error;
    }

    let purged = 0;
    let alreadyMarked = 0;
    const failures: string[] = [];

    for (const job of jobs || []) {
      try {
        const inputPaths = [job.input_image_1_path, job.input_image_2_path].filter(Boolean) as string[];
        const outputPaths = job.output_image_path ? [job.output_image_path] : [];
        await removeStoragePaths(supabase, getSupabaseUploadsBucket(), inputPaths);
        await removeStoragePaths(supabase, getSupabaseGeneratedBucket(), outputPaths);

        const purgedAt = new Date().toISOString();
        const { data: markedJob, error: markError } = await supabase
          .from('jobs')
          .update({ media_purged_at: purgedAt, updated_at: purgedAt })
          .eq('id', job.id)
          .is('media_purged_at', null)
          .select('id')
          .maybeSingle();

        if (markError) {
          throw markError;
        }

        if (markedJob) {
          purged += 1;
        } else {
          alreadyMarked += 1;
        }
      } catch (error) {
        failures.push(job.id);
        console.error(`[cleanup-images] failed job=${job.id} missing=${isMissingStorageObject(error)}`);
      }
    }

    return jsonResponse({
      ok: failures.length === 0,
      retentionDays: RETENTION_DAYS,
      cutoff,
      scanned: jobs?.length || 0,
      purged,
      alreadyMarked,
      failed: failures,
    }, failures.length ? 500 : 200);
  } catch (error) {
    if (error instanceof SupabaseBackendError) {
      return jsonResponse({ ok: false, error: error.message }, error.status);
    }

    console.error('[cleanup-images] unexpected_error');
    return jsonResponse({ ok: false, error: 'No se pudo ejecutar la limpieza de imágenes.' }, 500);
  }
};
