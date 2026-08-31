import { createClient } from '@supabase/supabase-js';
import {
  getMasterStyleReferencePath as getConfiguredMasterStyleReferencePath,
  getSupabaseGeneratedBucket as getConfiguredGeneratedBucket,
  getSupabasePrivateBucket as getConfiguredPrivateBucket,
  getSupabaseServiceRoleKey,
  getSupabaseUploadsBucket as getConfiguredUploadsBucket,
  getSupabaseUrl,
} from './server/env';

type SupabaseErrorStatus = 500 | 503;

class DisabledAdminRealtimeTransport {
  constructor() {
    throw new Error('Realtime no está habilitado en el cliente admin server-side.');
  }
}

export class SupabaseBackendError extends Error {
  readonly code: string;
  readonly status: SupabaseErrorStatus;
  readonly diagnostic?: string;

  constructor(code: string, message: string, status: SupabaseErrorStatus, options?: ErrorOptions, diagnostic?: string) {
    super(message, options);
    this.name = 'SupabaseBackendError';
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}

function getSafeErrorIdentity(error: unknown) {
  if (!error || typeof error !== 'object') {
    return typeof error;
  }

  const record = error as Record<string, unknown>;
  const name = typeof record.name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(record.name)
    ? record.name
    : 'Error';
  const fields = ['code', 'statusCode', 'status']
    .map((field) => {
      const value = record[field];
      return value !== undefined && value !== null && /^[a-zA-Z0-9_-]{1,32}$/.test(String(value))
        ? `${field}=${String(value)}`
        : null;
    })
    .filter(Boolean);
  const nested = record.originalError && typeof record.originalError === 'object'
    ? `; original=${getSafeErrorIdentity(record.originalError)}`
    : record.cause && typeof record.cause === 'object'
      ? `; cause=${getSafeErrorIdentity(record.cause)}`
      : '';

  return `${name}${fields.length ? `(${fields.join(',')})` : ''}${nested}`;
}

function getSafeProviderCode(error: unknown) {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const candidateValue = record.code ?? record.statusCode ?? record.status;
  const candidate = candidateValue === undefined || candidateValue === null ? '' : String(candidateValue);

  return /^[a-zA-Z0-9_-]{1,32}$/.test(candidate) ? candidate : undefined;
}

function isStorageTransportError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as Record<string, unknown>).name === 'StorageUnknownError');
}

function getSupabaseOperationStatus(error: unknown): SupabaseErrorStatus {
  if (!error || typeof error !== 'object') {
    return 503;
  }

  const value = Number((error as Record<string, unknown>).status);
  return Number.isFinite(value) && value >= 400 && value < 500 ? 500 : 503;
}

export function createSupabaseOperationError(
  code: string,
  message: string,
  cause: unknown,
  status: SupabaseErrorStatus = 503,
) {
  const providerCode = getSafeProviderCode(cause);
  const safeMessage = providerCode ? `${message} (código ${providerCode})` : message;
  return new SupabaseBackendError(code, safeMessage, status, { cause }, getSafeErrorIdentity(cause));
}

let didLogSupabaseConfig = false;

function logSupabaseConfig() {
  if (!import.meta.env.DEV || didLogSupabaseConfig) {
    return;
  }

  didLogSupabaseConfig = true;
  console.info([
    '[Supabase config]',
    `URL configured: ${Boolean(getSupabaseUrl())}`,
    `Service key configured: ${Boolean(getSupabaseServiceRoleKey())}`,
    `Uploads bucket: ${getConfiguredUploadsBucket()}`,
    `Generated bucket: ${getConfiguredGeneratedBucket()}`,
    `Private bucket: ${getConfiguredPrivateBucket()}`,
  ].join('\n'));
}

function assertValidSupabaseUrl(value: string) {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new SupabaseBackendError(
      'SUPABASE_INVALID_URL',
      'SUPABASE_URL no es una URL válida. Debe usar https://<project-ref>.supabase.co.',
      500,
    );
  }

  const hasRootPathOnly = parsed.pathname === '' || parsed.pathname === '/';
  const hasValidHost = /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname);
  const hasUnexpectedParts = Boolean(parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash);

  if (parsed.protocol !== 'https:' || !hasValidHost || !hasRootPathOnly || hasUnexpectedParts) {
    throw new SupabaseBackendError(
      'SUPABASE_INVALID_URL',
      'SUPABASE_URL debe usar exactamente https://<project-ref>.supabase.co, sin /rest/v1 ni otra ruta.',
      500,
    );
  }
}

export function isSupabaseConfigured() {
  logSupabaseConfig();

  const supabaseUrl = getSupabaseUrl();
  const supabaseKey = getSupabaseServiceRoleKey();

  if (!supabaseUrl && !supabaseKey) {
    return false;
  }

  if (!supabaseUrl || !supabaseKey) {
    throw new SupabaseBackendError(
      'SUPABASE_INCOMPLETE_CONFIG',
      'La configuración de Supabase está incompleta: se requieren SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.',
      500,
    );
  }

  assertValidSupabaseUrl(supabaseUrl);
  return true;
}

export function getSupabaseAdmin() {
  if (!isSupabaseConfigured()) {
    throw new SupabaseBackendError(
      'SUPABASE_NOT_CONFIGURED',
      'Supabase no está configurado en el backend.',
      500,
    );
  }

  const supabaseUrl = getSupabaseUrl()!;
  const supabaseKey = getSupabaseServiceRoleKey()!;

  try {
    return createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      // This admin client only uses Database and Storage. Supplying a transport
      // prevents Realtime initialization from requiring global WebSocket on Node 20.
      realtime: {
        transport: DisabledAdminRealtimeTransport as never,
      },
    });
  } catch (error) {
    throw createSupabaseOperationError(
      'SUPABASE_CLIENT_INIT_FAILED',
      'No se pudo inicializar el cliente admin de Supabase.',
      error,
      500,
    );
  }
}

export function getSupabaseUploadsBucket() {
  return getConfiguredUploadsBucket();
}

export function getSupabaseGeneratedBucket() {
  return getConfiguredGeneratedBucket();
}

export function getSupabasePrivateBucket() {
  return getConfiguredPrivateBucket();
}

export function getMasterStyleReferencePath() {
  return getConfiguredMasterStyleReferencePath().replace(/^\/+/, '').replace('\\', '/');
}

export async function supabaseDownload(bucket: string, path: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from(bucket).download(path);

  if (error) {
    throw new Error(error.message || 'No se pudo descargar el archivo desde Supabase');
  }

  if (!data) {
    throw new Error('Supabase no devolvió un archivo válido');
  }

  return data;
}

export async function supabaseUpload(bucket: string, path: string, fileBuffer: Buffer, contentType: string) {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, fileBuffer, {
        upsert: true,
        contentType,
        duplex: 'half',
      });

    if (error) {
      if (isStorageTransportError(error)) {
        throw createSupabaseOperationError(
          'SUPABASE_CONNECTION_FAILED',
          'No se pudo conectar con Supabase durante la subida.',
          error,
        );
      }

      throw createSupabaseOperationError(
        'SUPABASE_UPLOAD_FAILED',
        'No se pudo subir la imagen a Supabase Storage. Revisa el bucket y sus permisos.',
        error,
        getSupabaseOperationStatus(error),
      );
    }
  } catch (error) {
    if (error instanceof SupabaseBackendError) {
      throw error;
    }

    throw createSupabaseOperationError(
      'SUPABASE_CONNECTION_FAILED',
      'No se pudo conectar con Supabase durante la subida.',
      error,
    );
  }
}

export async function supabaseGetSignedUrl(bucket: string, path: string, expiresIn = 60) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);

  if (error) {
    throw new Error(error.message || 'No se pudo crear la signed URL');
  }

  return data.signedUrl;
}
