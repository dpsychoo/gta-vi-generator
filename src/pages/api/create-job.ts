import type { APIRoute } from 'astro';
import sharp from 'sharp';
import { createJob } from '../../lib/job-store';
import { createMercadoPagoPreference } from '../../lib/mercadopago';
import { SupabaseBackendError } from '../../lib/supabase';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'];

async function validateImageFile(file: File): Promise<{ valid: boolean; error?: string }> {
  // Validar tamaño
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `El archivo ${file.name} excede 10 MB` };
  }

  // Validar MIME type como primera línea de defensa
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return { valid: false, error: `El archivo ${file.name} no es una imagen válida (MIME type: ${file.type})` };
  }

  // Validar que sea realmente una imagen usando sharp
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(buffer).metadata();

    if (!metadata.format) {
      return { valid: false, error: `No se pudo determinar el formato de ${file.name}` };
    }

    if (!ALLOWED_FORMATS.includes(metadata.format)) {
      return { valid: false, error: `El archivo ${file.name} es ${metadata.format.toUpperCase()}, solo se permiten JPG, PNG o WebP` };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: `El archivo ${file.name} no es una imagen válida: ${(error as Error).message}` };
  }
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data') && !contentType.includes('application/x-www-form-urlencoded')) {
      return new Response(JSON.stringify({ ok: false, error: 'Formato de formulario inválido. Se requiere multipart/form-data.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const formData = await request.formData();
    const email = String(formData.get('email') || '').trim();
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
      const validation = await validateImageFile(file);
      if (!validation.valid) {
        return new Response(JSON.stringify({ ok: false, error: validation.error || 'Archivo inválido' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const job = await createJob({ email, files });
    const payment = await createMercadoPagoPreference({ jobId: job.id, email });

    return new Response(JSON.stringify({
      ok: true,
      jobId: job.id,
      paymentUrl: payment.init_point,
      paymentId: payment.id,
      mocked: payment.mocked,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof SupabaseBackendError) {
      const diagnostic = import.meta.env.DEV && error.diagnostic ? `; provider=${error.diagnostic}` : '';
      console.error(`[create-job] ${error.code}: ${error.message}${diagnostic}`);
      return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), {
        status: error.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const message = import.meta.env.DEV
      ? 'No se pudo crear el job. Revisa el log del servidor.'
      : 'Error al crear el job';
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
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
