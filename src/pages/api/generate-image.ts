import type { APIRoute } from 'astro';
import {
  DevelopmentGenerationError,
  generateDevelopmentResultImage,
} from '../../lib/openai';

export const prerender = false;

function jsonResponse(payload: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (import.meta.env.PROD) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const jobId = typeof body?.jobId === 'string' ? body.jobId.trim() : '';

    if (!jobId) {
      return jsonResponse({ error: 'jobId requerido' }, 400);
    }

    const result = await generateDevelopmentResultImage(jobId);
    return jsonResponse({
      ok: true,
      developmentOnly: true,
      authorizationSimulated: true,
      jobId: result.jobId,
      previousStatus: result.previousStatus,
      status: 'completed',
      imagePath: result.outputPath,
      openAIHttpStatus: result.openAIHttpStatus,
      requestId: result.requestId,
      outputSize: result.outputSize,
      reused: result.reused,
    }, 200);
  } catch (error) {
    if (error instanceof DevelopmentGenerationError) {
      console.error(`generate-image dev error: ${error.message}`);
      return jsonResponse({
        error: error.message,
        openAIHttpStatus: error.openAIHttpStatus,
        requestId: error.requestId,
      }, error.statusCode);
    }

    console.error('generate-image dev error: error no clasificado');
    return jsonResponse({ error: 'Error interno al generar la imagen.' }, 500);
  }
};
