import { getJob, updateJob, type JobRecord, type JobStatus } from './job-store';
import { sendJobResultEmail } from './email';
import {
  getMasterStyleReferencePath,
  getSupabaseAdmin,
  getSupabaseGeneratedBucket,
  getSupabasePrivateBucket,
  getSupabaseUploadsBucket,
  isSupabaseConfigured,
  supabaseDownload,
  supabaseUpload,
} from './supabase';
import { getOpenAIApiKey, getOpenAIStylePrompt } from './server/env';

const OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/edits';
const OPENAI_IMAGE_MODEL = 'gpt-image-2';
const OPENAI_TIMEOUT_MS = 4 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface LoadedImage {
  buffer: Buffer;
  mime: string;
  fileName: string;
}

interface OpenAIImageEditResponse {
  data: Array<{
    b64_json: string;
  }>;
}

interface OpenAIErrorResponse {
  error?: {
    code?: unknown;
    type?: unknown;
  };
}

export interface DevelopmentGenerationResult {
  jobId: string;
  previousStatus: JobStatus;
  outputPath: string;
  openAIHttpStatus: 200 | null;
  requestId: string | null;
  outputSize: number | null;
  reused: boolean;
}

export class DevelopmentGenerationError extends Error {
  readonly statusCode: number;
  readonly openAIHttpStatus: number | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      openAIHttpStatus?: number | null;
      requestId?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DevelopmentGenerationError';
    this.statusCode = options.statusCode ?? 500;
    this.openAIHttpStatus = options.openAIHttpStatus ?? null;
    this.requestId = options.requestId ?? null;
  }
}

function inferImageMimeType(path: string, declaredMime: string | undefined) {
  const normalized = declaredMime?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp') {
    return normalized;
  }

  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.png')) return 'image/png';
  if (lowerPath.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function safeFileName(path: string, fallback: string) {
  const candidate = path.split('/').pop()?.replace(/[^a-zA-Z0-9._-]/g, '');
  return candidate || fallback;
}

async function loadPrivateImage(bucket: string, path: string, fallbackName: string): Promise<LoadedImage> {
  const blob = await supabaseDownload(bucket, path);
  const buffer = Buffer.from(await blob.arrayBuffer());

  if (buffer.length === 0) {
    throw new DevelopmentGenerationError('Supabase devolviÃ³ una imagen vacÃ­a.', { statusCode: 500 });
  }

  return {
    buffer,
    mime: inferImageMimeType(path, blob.type),
    fileName: safeFileName(path, fallbackName),
  };
}

function logLoadedImageMetadata(master: LoadedImage, primary: LoadedImage, secondary: LoadedImage | null) {
  if (!import.meta.env.DEV) {
    return;
  }

  console.info(`Master image loaded: ${Boolean(master.buffer.length)}`);
  console.info(`Master image MIME: ${master.mime}`);
  console.info(`Master image size: ${master.buffer.length}`);
  console.info(`Customer image 1 loaded: ${Boolean(primary.buffer.length)}`);
  console.info(`Customer image 1 MIME: ${primary.mime}`);
  console.info(`Customer image 1 size: ${primary.buffer.length}`);
  console.info(`Customer image 2 loaded: ${Boolean(secondary?.buffer.length)}`);

  if (secondary) {
    console.info(`Customer image 2 MIME: ${secondary.mime}`);
    console.info(`Customer image 2 size: ${secondary.buffer.length}`);
  }
}

function getSafeProviderToken(value: unknown) {
  const token = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(token) ? token : null;
}

function getSanitizedOpenAIErrorMessage(status: number, errorBody: OpenAIErrorResponse | null) {
  const baseMessage = status === 400
    ? 'OpenAI rechazÃ³ la solicitud de ediciÃ³n de imagen.'
    : status === 401
      ? 'OpenAI rechazÃ³ la autenticaciÃ³n de la solicitud.'
      : status === 403
        ? 'OpenAI no autorizÃ³ la solicitud de ediciÃ³n de imagen.'
        : status === 429
          ? 'OpenAI aplicÃ³ un lÃ­mite de uso a la solicitud.'
          : status >= 500
            ? 'OpenAI tuvo un error interno al procesar la imagen.'
            : 'OpenAI no pudo completar la solicitud de ediciÃ³n de imagen.';
  const providerCode = getSafeProviderToken(errorBody?.error?.code);
  const providerType = getSafeProviderToken(errorBody?.error?.type);
  const safeDetails = [providerCode ? `code=${providerCode}` : null, providerType ? `type=${providerType}` : null]
    .filter(Boolean)
    .join(', ');

  return safeDetails ? `${baseMessage} (${safeDetails})` : baseMessage;
}

async function readOpenAIErrorBody(response: Response): Promise<OpenAIErrorResponse | null> {
  try {
    return await response.json() as OpenAIErrorResponse;
  } catch {
    return null;
  }
}

function logOpenAIResponse(status: number | 'unavailable', requestId: string | null, errorMessage?: string) {
  if (!import.meta.env.DEV) {
    return;
  }

  if (errorMessage) {
    console.error(`OpenAI HTTP status: ${status}`);
    console.error(`OpenAI request_id: ${requestId || 'unavailable'}`);
    console.error(`OpenAI error: ${errorMessage}`);
    return;
  }

  console.info(`OpenAI HTTP status: ${status}`);
  console.info(`OpenAI request_id: ${requestId || 'unavailable'}`);
}

async function markJobFailed(jobId: string, message: string) {
  try {
    await updateJob(jobId, {
      status: 'failed',
      errorMessage: message,
    });
  } catch {
    if (import.meta.env.DEV) {
      console.error('No se pudo guardar el estado failed del job.');
    }
  }
}

function asDevelopmentGenerationError(error: unknown) {
  if (error instanceof DevelopmentGenerationError) {
    return error;
  }

  return new DevelopmentGenerationError('No se pudo completar la generaciÃ³n real.', {
    statusCode: 500,
    cause: error,
  });
}

function completedResult(job: JobRecord): DevelopmentGenerationResult {
  return {
    jobId: job.id,
    previousStatus: job.status,
    outputPath: job.outputImagePath!,
    openAIHttpStatus: null,
    requestId: null,
    outputSize: null,
    reused: true,
  };
}

async function claimPendingJob(job: JobRecord) {
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('jobs')
    .update({
      status: 'processing',
      error_message: null,
      updated_at: now,
      metadata: {
        ...(job.metadata || {}),
        developmentGenerationAuthorizedAt: now,
      },
    })
    .eq('id', job.id)
    .eq('status', 'pending_payment')
    .select('id')
    .maybeSingle();

  if (error) {
    throw new DevelopmentGenerationError('No se pudo reservar el job para la generaciÃ³n.', {
      statusCode: 500,
      cause: error,
    });
  }

  if (!data) {
    throw new DevelopmentGenerationError('El job ya fue tomado por otra solicitud.', {
      statusCode: 409,
    });
  }
}

async function generateResultImage(
  jobId: string,
  authorization: 'development' | 'mercadopago',
): Promise<DevelopmentGenerationResult> {
  if (authorization === 'development' && import.meta.env.PROD) {
    throw new DevelopmentGenerationError('La generaciÃ³n manual solo estÃ¡ disponible en desarrollo.', {
      statusCode: 403,
    });
  }

  if (!UUID_PATTERN.test(jobId)) {
    throw new DevelopmentGenerationError('jobId invÃ¡lido.', { statusCode: 400 });
  }

  if (!isSupabaseConfigured()) {
    throw new DevelopmentGenerationError('La generaciÃ³n real requiere Supabase configurado.', { statusCode: 500 });
  }

  const apiKey = getOpenAIApiKey();
  const prompt = getOpenAIStylePrompt();
  if (!apiKey) {
    throw new DevelopmentGenerationError('Falta OPENAI_API_KEY en el entorno del servidor.', { statusCode: 500 });
  }
  if (!prompt) {
    throw new DevelopmentGenerationError('Falta OPENAI_STYLE_PROMPT en el entorno del servidor.', { statusCode: 500 });
  }

  const job = await getJob(jobId);
  if (!job) {
    throw new DevelopmentGenerationError('Job no encontrado.', { statusCode: 404 });
  }

  if (
    job.status === 'completed'
    && job.outputImagePath
    && (authorization === 'development' || job.paymentStatus === 'approved')
  ) {
    return completedResult(job);
  }

  const hasExpectedStatus = authorization === 'development'
    ? job.status === 'pending_payment'
    : job.status === 'processing' && job.paymentStatus === 'approved' && Boolean(job.paymentId);

  if (!hasExpectedStatus) {
    throw new DevelopmentGenerationError(`El job no se puede generar desde status=${job.status}.`, {
      statusCode: 409,
    });
  }

  if (!job.inputImage1Path) {
    throw new DevelopmentGenerationError('El job no tiene input_image_1_path.', { statusCode: 400 });
  }

  const previousStatus = job.status;
  let didStartProcessing = false;

  try {
    if (authorization === 'development') {
      await claimPendingJob(job);
      didStartProcessing = true;
    }

    const master = await loadPrivateImage(
      getSupabasePrivateBucket(),
      getMasterStyleReferencePath(),
      'master-reference.webp',
    );
    const primary = await loadPrivateImage(
      getSupabaseUploadsBucket(),
      job.inputImage1Path,
      'customer-1.jpg',
    );
    const secondary = job.inputImage2Path
      ? await loadPrivateImage(getSupabaseUploadsBucket(), job.inputImage2Path, 'customer-2.jpg')
      : null;

    logLoadedImageMetadata(master, primary, secondary);

    const form = new FormData();
    form.append('model', OPENAI_IMAGE_MODEL);
    form.append('prompt', prompt);
    form.append('quality', 'high');
    form.append('output_format', 'png');

    // Repeated image fields preserve this exact order: master, primary, optional secondary.
    form.append('image[]', new Blob([master.buffer], { type: master.mime }), master.fileName);
    form.append('image[]', new Blob([primary.buffer], { type: primary.mime }), primary.fileName);
    if (secondary) {
      form.append('image[]', new Blob([secondary.buffer], { type: secondary.mime }), secondary.fileName);
    }

    let response: Response;
    try {
      response = await fetch(OPENAI_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    } catch (error) {
      const message = 'No se pudo obtener una respuesta HTTP de OpenAI.';
      logOpenAIResponse('unavailable', null, message);
      throw new DevelopmentGenerationError(message, {
        statusCode: 502,
        cause: error,
      });
    }

    const requestId = response.headers.get('x-request-id');
    if (!response.ok) {
      const errorBody = await readOpenAIErrorBody(response);
      const message = getSanitizedOpenAIErrorMessage(response.status, errorBody);
      logOpenAIResponse(response.status, requestId, message);
      throw new DevelopmentGenerationError(message, {
        statusCode: 502,
        openAIHttpStatus: response.status,
        requestId,
      });
    }

    logOpenAIResponse(response.status, requestId);

    let rawData: unknown;
    try {
      rawData = await response.json();
    } catch (error) {
      const message = 'OpenAI HTTP 200 devolviÃ³ una respuesta JSON invÃ¡lida.';
      logOpenAIResponse(response.status, requestId, message);
      throw new DevelopmentGenerationError(message, {
        statusCode: 502,
        openAIHttpStatus: response.status,
        requestId,
        cause: error,
      });
    }

    if (
      !rawData
      || typeof rawData !== 'object'
      || !Array.isArray((rawData as OpenAIImageEditResponse).data)
      || typeof (rawData as OpenAIImageEditResponse).data[0]?.b64_json !== 'string'
      || (rawData as OpenAIImageEditResponse).data[0].b64_json.length === 0
    ) {
      const message = 'OpenAI HTTP 200 no devolviÃ³ data[0].b64_json.';
      logOpenAIResponse(response.status, requestId, message);
      throw new DevelopmentGenerationError(message, {
        statusCode: 502,
        openAIHttpStatus: response.status,
        requestId,
      });
    }

    const data = rawData as OpenAIImageEditResponse;
    const resultBase64 = data.data[0].b64_json;
    const outputBuffer = Buffer.from(resultBase64, 'base64');
    if (outputBuffer.length < PNG_SIGNATURE.length || !outputBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      const message = 'OpenAI devolviÃ³ un contenido PNG invÃ¡lido.';
      logOpenAIResponse(response.status, requestId, message);
      throw new DevelopmentGenerationError(message, {
        statusCode: 502,
        openAIHttpStatus: response.status,
        requestId,
      });
    }

    const outputPath = `${jobId}/result.png`;
    await supabaseUpload(getSupabaseGeneratedBucket(), outputPath, outputBuffer, 'image/png');

    const completedJob = await updateJob(jobId, {
      status: 'completed',
      outputImagePath: outputPath,
      errorMessage: null,
      metadata: {
        ...(job.metadata || {}),
        ...(authorization === 'development'
          ? { developmentGenerationAuthorizedAt: new Date().toISOString() }
          : { paymentGenerationAuthorizedAt: new Date().toISOString() }),
        provider: 'openai',
        model: OPENAI_IMAGE_MODEL,
        inputCount: secondary ? 3 : 2,
        openAIRequestId: requestId,
        outputSize: outputBuffer.length,
        outputGeneratedAt: new Date().toISOString(),
      },
    });

    if (!completedJob) {
      throw new DevelopmentGenerationError('No se pudo confirmar el resultado generado.', { statusCode: 500 });
    }

    // El email es secundario: un fallo de Resend nunca revierte el status completed.
    await sendJobResultEmail(jobId);

    return {
      jobId,
      previousStatus,
      outputPath,
      openAIHttpStatus: 200,
      requestId,
      outputSize: outputBuffer.length,
      reused: false,
    };
  } catch (error) {
    const safeError = asDevelopmentGenerationError(error);
    if (didStartProcessing) {
      await markJobFailed(jobId, safeError.message);
    }
    throw safeError;
  }
}

export function generateDevelopmentResultImage(jobId: string) {
  return generateResultImage(jobId, 'development');
}

export async function processPaidJob(jobId: string) {
  try {
    return await generateResultImage(jobId, 'mercadopago');
  } catch (error) {
    try {
      const job = await getJob(jobId);
      if (job?.status === 'processing' && job.paymentStatus === 'approved') {
        await markJobFailed(jobId, 'No se pudo completar la generación de la imagen.');
      }
    } catch {
      if (import.meta.env.DEV) {
        console.error('No se pudo guardar el fallo del job pagado.');
      }
    }
    throw error;
  }
}
