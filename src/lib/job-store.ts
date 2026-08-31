import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  getMasterStyleReferencePath,
  createSupabaseOperationError,
  getSupabaseAdmin,
  getSupabaseGeneratedBucket,
  getSupabasePrivateBucket,
  getSupabaseUploadsBucket,
  isSupabaseConfigured,
  supabaseDownload,
  supabaseGetSignedUrl,
  supabaseUpload,
  SupabaseBackendError,
} from './supabase';

export type JobStatus = 'pending_payment' | 'paid' | 'processing' | 'completed' | 'failed';
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'failed' | null;
export type EmailStatus = 'pending' | 'sent' | 'failed' | null;

export interface JobOriginalFile {
  name: string;
  path: string;
  size: number;
}

export interface JobRecord {
  id: string;
  email: string;
  status: JobStatus;
  paymentStatus?: PaymentStatus;
  paymentId?: string | null;
  mercadopagoPreferenceId?: string | null;
  paymentUrl?: string | null;
  externalReference?: string | null;
  inputImage1Path?: string | null;
  inputImage2Path?: string | null;
  outputImagePath?: string | null;
  outputImageUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
  emailStatus?: EmailStatus;
  originals: JobOriginalFile[];
  generatedImage?: string | null;
  metadata?: Record<string, unknown>;
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const rootDir = resolve(currentDir, '../..');
const dataDir = join(rootDir, '.data');
const uploadsDir = join(dataDir, 'uploads');
const generatedDir = join(dataDir, 'generated');
const jobsFile = join(dataDir, 'jobs.json');

async function ensureStorage() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });
}

async function readJobs(): Promise<Record<string, JobRecord>> {
  await ensureStorage();

  try {
    const content = await readFile(jobsFile, 'utf-8');
    return JSON.parse(content || '{}');
  } catch {
    return {};
  }
}

async function writeJobs(jobs: Record<string, JobRecord>) {
  await ensureStorage();
  await writeFile(jobsFile, JSON.stringify(jobs, null, 2));
}

function sanitizeFileName(name: string) {
  return name
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
}

function mapJobRow(row: Record<string, any>): JobRecord {
  const originals = [
    row.input_image_1_path ? { name: 'input-1', path: row.input_image_1_path, size: 0 } : null,
    row.input_image_2_path ? { name: 'input-2', path: row.input_image_2_path, size: 0 } : null,
  ].filter(Boolean) as JobOriginalFile[];

  return {
    id: row.id,
    email: row.email,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentId: row.payment_id,
    mercadopagoPreferenceId: row.mercadopago_preference_id,
    paymentUrl: row.payment_url,
    externalReference: row.external_reference,
    inputImage1Path: row.input_image_1_path,
    inputImage2Path: row.input_image_2_path,
    outputImagePath: row.output_image_path,
    outputImageUrl: row.output_image_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorMessage: row.error_message,
    emailStatus: row.email_status,
    originals,
    generatedImage: row.output_image_path,
    metadata: row.metadata || {},
  };
}

export async function createJob({ email, files }: { email: string; files: File[] }) {
  if (isSupabaseConfigured()) {
    const supabase = getSupabaseAdmin();
    const jobId = crypto.randomUUID();
    const bucket = getSupabaseUploadsBucket();
    const uploadedPaths: string[] = [];

    for (const [index, file] of files.entries()) {
      const fileExt = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.jpg';
      const safePath = `${jobId}/input-${index + 1}${fileExt}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      await supabaseUpload(bucket, safePath, buffer, file.type || 'application/octet-stream');
      uploadedPaths.push(safePath);
    }

    const payload = {
      id: jobId,
      email,
      status: 'pending_payment',
      payment_status: 'pending',
      payment_id: null,
      mercadopago_preference_id: null,
      payment_url: null,
      external_reference: jobId,
      input_image_1_path: uploadedPaths[0] || null,
      input_image_2_path: uploadedPaths[1] || null,
      output_image_path: null,
      error_message: null,
      email_status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { source: 'supabase' },
    };

    try {
      const { data, error } = await supabase.from('jobs').insert(payload).select().single();

      if (error) {
        throw createSupabaseOperationError(
          'SUPABASE_INSERT_FAILED',
          'No se pudo insertar el job en public.jobs. Revisa el esquema, RLS y los permisos.',
          error,
          500,
        );
      }

      return mapJobRow(data);
    } catch (error) {
      if (error instanceof SupabaseBackendError) {
        throw error;
      }

      throw createSupabaseOperationError(
        'SUPABASE_CONNECTION_FAILED',
        'No se pudo conectar con Supabase durante la inserción del job.',
        error,
      );
    }
  }

  const jobs = await readJobs();
  const jobId = crypto.randomUUID();
  const jobUploadDir = join(uploadsDir, jobId);
  await mkdir(jobUploadDir, { recursive: true });

  const originals: JobOriginalFile[] = [];

  for (const file of files) {
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${sanitizeFileName(file.name) || 'image'}`;
    const filePath = join(jobUploadDir, safeName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);
    originals.push({ name: file.name, path: safeName, size: file.size });
  }

  const now = new Date().toISOString();
  const job: JobRecord = {
    id: jobId,
    email,
    status: 'pending_payment',
    paymentStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    originals,
    generatedImage: null,
    paymentId: null,
    paymentUrl: null,
    externalReference: jobId,
    metadata: { source: 'local-file-store' },
  };

  jobs[jobId] = job;
  await writeJobs(jobs);
  return job;
}

export async function getJob(jobId: string) {
  if (isSupabaseConfigured()) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();

    if (error) {
      throw new Error(error.message || 'No se pudo consultar el job');
    }

    return data ? mapJobRow(data) : null;
  }

  const jobs = await readJobs();
  return jobs[jobId] ?? null;
}

export async function updateJob(jobId: string, updates: Partial<JobRecord>) {
  if (isSupabaseConfigured()) {
    const supabase = getSupabaseAdmin();
    const payload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.paymentStatus !== undefined) payload.payment_status = updates.paymentStatus;
    if (updates.paymentId !== undefined) payload.payment_id = updates.paymentId;
    if (updates.mercadopagoPreferenceId !== undefined) payload.mercadopago_preference_id = updates.mercadopagoPreferenceId;
    if (updates.paymentUrl !== undefined) payload.payment_url = updates.paymentUrl;
    if (updates.externalReference !== undefined) payload.external_reference = updates.externalReference;
    if (updates.inputImage1Path !== undefined) payload.input_image_1_path = updates.inputImage1Path;
    if (updates.inputImage2Path !== undefined) payload.input_image_2_path = updates.inputImage2Path;
    if (updates.outputImagePath !== undefined) payload.output_image_path = updates.outputImagePath;
    if (updates.outputImageUrl !== undefined) payload.output_image_url = updates.outputImageUrl;
    if (updates.errorMessage !== undefined) payload.error_message = updates.errorMessage;
    if (updates.emailStatus !== undefined) payload.email_status = updates.emailStatus;
    if (updates.metadata !== undefined) payload.metadata = updates.metadata;

    const { data, error } = await supabase.from('jobs').update(payload).eq('id', jobId).select().single();

    if (error) {
      throw new Error(error.message || 'No se pudo actualizar el job');
    }

    return data ? mapJobRow(data) : null;
  }

  const jobs = await readJobs();
  const current = jobs[jobId];

  if (!current) {
    return null;
  }

  const next: JobRecord = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  jobs[jobId] = next;
  await writeJobs(jobs);
  return next;
}

export type PaidJobClaimReason =
  | 'claimed'
  | 'job_not_found'
  | 'already_processing'
  | 'already_completed'
  | 'payment_id_in_use'
  | 'incompatible_payment'
  | 'not_claimable';

export interface PaidJobClaimResult {
  claimed: boolean;
  reason: PaidJobClaimReason;
  job: JobRecord | null;
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && String(error.code) === '23505',
  );
}

async function isPaymentIdUsedByAnotherJob(paymentId: string, jobId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('jobs')
    .select('id')
    .eq('payment_id', paymentId)
    .neq('id', jobId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'SUPABASE_PAYMENT_LOOKUP_FAILED',
      'No se pudo comprobar la unicidad del pago.',
      error,
    );
  }

  return Boolean(data);
}

export async function claimApprovedPaymentForProcessing({
  jobId,
  paymentId,
}: {
  jobId: string;
  paymentId: string;
}): Promise<PaidJobClaimResult> {
  if (!isSupabaseConfigured()) {
    throw new SupabaseBackendError(
      'SUPABASE_REQUIRED_FOR_PAYMENTS',
      'El procesamiento de pagos reales requiere Supabase.',
      500,
    );
  }

  if (await isPaymentIdUsedByAnotherJob(paymentId, jobId)) {
    return { claimed: false, reason: 'payment_id_in_use', job: null };
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .update({
      status: 'processing',
      payment_status: 'approved',
      payment_id: paymentId,
      external_reference: jobId,
      error_message: null,
      updated_at: now,
    })
    .eq('id', jobId)
    .eq('status', 'pending_payment')
    .in('payment_status', ['pending', 'rejected', 'cancelled', 'failed'])
    .or(`payment_id.is.null,payment_id.eq.${paymentId}`)
    .select('*')
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      return { claimed: false, reason: 'payment_id_in_use', job: null };
    }

    throw createSupabaseOperationError(
      'SUPABASE_PAYMENT_CLAIM_FAILED',
      'No se pudo reservar el job pagado para procesamiento.',
      error,
    );
  }

  if (data) {
    return { claimed: true, reason: 'claimed', job: mapJobRow(data) };
  }

  const current = await getJob(jobId);
  if (!current) {
    return { claimed: false, reason: 'job_not_found', job: null };
  }
  if (current.paymentId && current.paymentId !== paymentId) {
    return { claimed: false, reason: 'incompatible_payment', job: current };
  }
  if (current.status === 'processing') {
    return { claimed: false, reason: 'already_processing', job: current };
  }
  if (current.status === 'completed') {
    return { claimed: false, reason: 'already_completed', job: current };
  }
  return { claimed: false, reason: 'not_claimable', job: current };
}

export async function recordUnapprovedPayment({
  jobId,
  paymentId,
  paymentStatus,
  errorMessage,
}: {
  jobId: string;
  paymentId: string;
  paymentStatus: Exclude<PaymentStatus, 'approved' | null>;
  errorMessage: string | null;
}) {
  if (!isSupabaseConfigured()) {
    throw new SupabaseBackendError(
      'SUPABASE_REQUIRED_FOR_PAYMENTS',
      'El procesamiento de pagos reales requiere Supabase.',
      500,
    );
  }

  if (await isPaymentIdUsedByAnotherJob(paymentId, jobId)) {
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('jobs')
    .update({
      payment_status: paymentStatus,
      external_reference: jobId,
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', 'pending_payment')
    .in('payment_status', ['pending', 'rejected', 'cancelled', 'failed'])
    .or(`payment_id.is.null,payment_id.eq.${paymentId}`)
    .select('*')
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      return null;
    }

    throw createSupabaseOperationError(
      'SUPABASE_PAYMENT_STATUS_UPDATE_FAILED',
      'No se pudo actualizar el estado del pago.',
      error,
    );
  }

  return data ? mapJobRow(data) : null;
}

export async function getUploadPath(jobId: string, fileName: string) {
  return join(uploadsDir, jobId, fileName);
}

export async function getGeneratedPath(jobId: string, fileName: string) {
  return join(generatedDir, `${jobId}-${fileName}`);
}

export async function resolveMasterStyleReferencePath() {
  if (isSupabaseConfigured()) {
    return getMasterStyleReferencePath();
  }

  const configured = process.env.MASTER_STYLE_REFERENCE_PATH?.trim();
  const candidates = [
    configured,
    join(rootDir, '.data', 'master-style-reference.png'),
    join(rootDir, '.data', 'master-style-reference.jpg'),
    join(rootDir, '.data', 'master-style-reference.jpeg'),
    join(rootDir, '.data', 'master-style-reference.webp'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // continuar
    }
  }

  return null;
}

export async function getAllJobs() {
  if (isSupabaseConfigured()) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from('jobs').select('*');
    if (error) {
      throw new Error(error.message || 'No se pudo consultar jobs');
    }
    return (data || []).reduce((acc, row) => {
      acc[row.id] = mapJobRow(row);
      return acc;
    }, {} as Record<string, JobRecord>);
  }

  return readJobs();
}

export async function getMasterReferenceBlob() {
  if (!isSupabaseConfigured()) {
    const resolvedPath = await resolveMasterStyleReferencePath();
    if (!resolvedPath) {
      throw new Error('No existe la imagen maestra local configurada');
    }
    return { bucket: null, path: resolvedPath, blob: await readFile(resolvedPath) };
  }

  const path = getMasterStyleReferencePath();
  const bucket = getSupabasePrivateBucket();
  const blob = await supabaseDownload(bucket, path);
  return { bucket, path, blob };
}

export async function getJobResultSignedUrl(job: JobRecord) {
  if (!isSupabaseConfigured() || !job.outputImagePath) {
    return null;
  }

  return supabaseGetSignedUrl(getSupabaseGeneratedBucket(), job.outputImagePath, 60 * 60 * 24);
}

