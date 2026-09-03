import {
  createSupabaseOperationError,
  getSupabaseAdmin,
  isSupabaseConfigured,
  SupabaseBackendError,
} from './supabase';

export type ConfirmationEmailStatus = 'pending' | 'sent' | 'failed';

export interface LegalAcceptanceRecord {
  id: string;
  jobId: string;
  customerId?: string | null;
  termsVersion: string;
  privacyVersion: string;
  refundPolicyVersion: string;
  immediateExecutionAccepted: boolean;
  retractExclusionAcknowledged: boolean;
  acceptedAt: string;
  source: string;
  confirmationEmailStatus: ConfirmationEmailStatus;
  confirmationSentAt?: string | null;
  createdAt: string;
}

export interface CreateLegalAcceptanceInput {
  jobId: string;
  customerId?: string | null;
  termsVersion: string;
  privacyVersion: string;
  refundPolicyVersion: string;
  immediateExecutionAccepted: boolean;
  retractExclusionAcknowledged: boolean;
  source: string;
}

function getLegalAcceptanceSupabase() {
  if (!isSupabaseConfigured()) {
    throw new SupabaseBackendError(
      'SUPABASE_REQUIRED_FOR_LEGAL_ACCEPTANCE',
      'La aceptación legal requiere Supabase configurado.',
      500,
    );
  }

  return getSupabaseAdmin();
}

function mapLegalAcceptance(row: Record<string, any>): LegalAcceptanceRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    customerId: row.customer_id,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    refundPolicyVersion: row.refund_policy_version,
    immediateExecutionAccepted: row.immediate_execution_accepted,
    retractExclusionAcknowledged: row.retract_exclusion_acknowledged,
    acceptedAt: row.accepted_at,
    source: row.source,
    confirmationEmailStatus: row.confirmation_email_status,
    confirmationSentAt: row.confirmation_sent_at,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && String(error.code) === '23505',
  );
}

function sameAcceptance(left: LegalAcceptanceRecord, right: CreateLegalAcceptanceInput) {
  return left.jobId === right.jobId
    && left.customerId === (right.customerId ?? null)
    && left.termsVersion === right.termsVersion
    && left.privacyVersion === right.privacyVersion
    && left.refundPolicyVersion === right.refundPolicyVersion
    && left.immediateExecutionAccepted === right.immediateExecutionAccepted
    && left.retractExclusionAcknowledged === right.retractExclusionAcknowledged
    && left.source === right.source;
}

export async function getLegalAcceptanceByJobId(jobId: string) {
  const supabase = getLegalAcceptanceSupabase();
  const { data, error } = await supabase
    .from('legal_acceptances')
    .select('*')
    .eq('job_id', jobId)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'LEGAL_ACCEPTANCE_LOOKUP_FAILED',
      'No se pudo consultar la aceptación legal del job.',
      error,
    );
  }

  return data ? mapLegalAcceptance(data) : null;
}

export async function createLegalAcceptance(input: CreateLegalAcceptanceInput) {
  if (!input.immediateExecutionAccepted || !input.retractExclusionAcknowledged) {
    throw new Error('La aceptación legal debe incluir la ejecución inmediata y la exclusión informada del retracto.');
  }

  const supabase = getLegalAcceptanceSupabase();
  const now = new Date().toISOString();
  const payload = {
    job_id: input.jobId,
    customer_id: input.customerId ?? null,
    terms_version: input.termsVersion,
    privacy_version: input.privacyVersion,
    refund_policy_version: input.refundPolicyVersion,
    immediate_execution_accepted: true,
    retract_exclusion_acknowledged: true,
    accepted_at: now,
    source: input.source,
    confirmation_email_status: 'pending',
    confirmation_sent_at: null,
    created_at: now,
  };

  const { data, error } = await supabase
    .from('legal_acceptances')
    .insert(payload)
    .select('*')
    .single();

  if (!error && data) {
    return mapLegalAcceptance(data);
  }

  if (isUniqueViolation(error)) {
    const existing = await getLegalAcceptanceByJobId(input.jobId);
    if (existing && sameAcceptance(existing, input)) {
      return existing;
    }

    throw new Error('El job ya tiene una aceptación legal incompatible.');
  }

  throw createSupabaseOperationError(
    'LEGAL_ACCEPTANCE_CREATE_FAILED',
    'No se pudo guardar la aceptación legal del job.',
    error || new Error('Supabase no devolvió la aceptación legal creada.'),
  );
}

export async function updateLegalAcceptanceCustomerId(jobId: string, customerId: string) {
  const existing = await getLegalAcceptanceByJobId(jobId);
  if (!existing) {
    return null;
  }

  if (existing.customerId && existing.customerId !== customerId) {
    throw new Error('La aceptación legal ya está asociada a otro customer.');
  }

  if (existing.customerId === customerId) {
    return existing;
  }

  const supabase = getLegalAcceptanceSupabase();
  const { data, error } = await supabase
    .from('legal_acceptances')
    .update({ customer_id: customerId })
    .eq('job_id', jobId)
    .is('customer_id', null)
    .select('*')
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'LEGAL_ACCEPTANCE_CUSTOMER_UPDATE_FAILED',
      'No se pudo asociar la aceptación legal al customer.',
      error,
    );
  }

  return data ? mapLegalAcceptance(data) : getLegalAcceptanceByJobId(jobId);
}

export async function updateLegalAcceptanceConfirmation(
  jobId: string,
  status: ConfirmationEmailStatus,
  confirmationSentAt?: string | null,
) {
  const supabase = getLegalAcceptanceSupabase();
  const payload: Record<string, string | null> = {
    confirmation_email_status: status,
  };

  if (confirmationSentAt !== undefined) {
    payload.confirmation_sent_at = confirmationSentAt;
  }

  const { data, error } = await supabase
    .from('legal_acceptances')
    .update(payload)
    .eq('job_id', jobId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'LEGAL_ACCEPTANCE_EMAIL_STATUS_UPDATE_FAILED',
      'No se pudo actualizar el estado del correo de confirmación legal.',
      error,
    );
  }

  return data ? mapLegalAcceptance(data) : null;
}
