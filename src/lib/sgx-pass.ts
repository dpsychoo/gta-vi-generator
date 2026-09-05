import { randomInt } from 'node:crypto';
import {
  createSupabaseOperationError,
  getSupabaseAdmin,
  isSupabaseConfigured,
  SupabaseBackendError,
} from './supabase';
import type { PublicMilestoneReadModel } from './purchase-milestone';

export type SgxPassStatus = 'active' | 'suspended' | 'revoked';
export type SgxOrderStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'refunded' | 'chargeback' | 'failed';

export interface CustomerRecord {
  id: string;
  email: string;
  normalizedEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface SgxPassRecord {
  id: string;
  customerId: string;
  publicCode: string;
  status: SgxPassStatus;
  createdAt: string;
  firstOrderId?: string | null;
}

export interface SgxOrderRecord {
  id: string;
  jobId: string;
  customerId: string;
  sgxPassId: string;
  mercadopagoPaymentId: string;
  status: SgxOrderStatus;
  amount: number;
  currency: string;
  createdAt: string;
  approvedAt?: string | null;
  // Keep bigint as decimal text; never round it through a JavaScript number.
  purchaseNumber?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ApprovedSgxIdentity {
  customer: CustomerRecord;
  pass: SgxPassRecord;
  order: SgxOrderRecord;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_ID_PATTERN = /^\d{1,32}$/;
const PASS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_PASS_GENERATION_ATTEMPTS = 12;

function getSgxPassSupabase() {
  if (!isSupabaseConfigured()) {
    throw new SupabaseBackendError(
      'SUPABASE_REQUIRED_FOR_SGX_PASS',
      'La identidad SGX VI PASS requiere Supabase configurado.',
      500,
    );
  }

  return getSupabaseAdmin();
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && String(error.code) === '23505',
  );
}

function mapCustomer(row: Record<string, any>): CustomerRecord {
  return {
    id: row.id,
    email: row.email,
    normalizedEmail: row.normalized_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPass(row: Record<string, any>): SgxPassRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    publicCode: row.public_code,
    status: row.status,
    createdAt: row.created_at,
    firstOrderId: row.first_order_id,
  };
}

function mapOrder(row: Record<string, any>): SgxOrderRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    customerId: row.customer_id,
    sgxPassId: row.sgx_pass_id,
    mercadopagoPaymentId: row.mercadopago_payment_id,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    purchaseNumber: row.purchase_number === null || row.purchase_number === undefined
      ? null
      : String(row.purchase_number),
    metadata: row.metadata || {},
  };
}

export function normalizeCustomerEmail(email: string) {
  const originalEmail = email.trim();
  if (!EMAIL_PATTERN.test(originalEmail)) {
    throw new Error('No se puede crear una identidad SGX con un email inválido.');
  }

  return {
    originalEmail,
    normalizedEmail: originalEmail.toLowerCase(),
  };
}

export function generateUniqueSgxCode() {
  const chunks = Array.from({ length: 2 }, () => (
    Array.from({ length: 4 }, () => PASS_ALPHABET[randomInt(PASS_ALPHABET.length)]).join('')
  ));

  return `SGX-VI-${chunks.join('-')}`;
}

export function isSgxPassActive(pass: Pick<SgxPassRecord, 'status'>) {
  return pass.status === 'active';
}

export async function findCustomerByEmail(email: string) {
  const { normalizedEmail } = normalizeCustomerEmail(email);
  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('normalized_email', normalizedEmail)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'SGX_CUSTOMER_LOOKUP_FAILED',
      'No se pudo consultar la identidad del cliente.',
      error,
    );
  }

  return data ? mapCustomer(data) : null;
}

export async function getOrCreateCustomer(email: string) {
  const { originalEmail, normalizedEmail } = normalizeCustomerEmail(email);
  const existing = await findCustomerByEmail(originalEmail);
  if (existing) {
    return existing;
  }

  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('customers')
    .insert({
      email: originalEmail,
      normalized_email: normalizedEmail,
    })
    .select('*')
    .single();

  if (!error && data) {
    return mapCustomer(data);
  }

  if (isUniqueViolation(error)) {
    const racedCustomer = await findCustomerByEmail(originalEmail);
    if (racedCustomer) {
      return racedCustomer;
    }
  }

  throw createSupabaseOperationError(
    'SGX_CUSTOMER_CREATE_FAILED',
    'No se pudo crear la identidad del cliente.',
    error || new Error('Supabase no devolvió el cliente creado.'),
  );
}

export async function getSgxPassForCustomer(customerId: string) {
  if (!UUID_PATTERN.test(customerId)) {
    throw new Error('customer_id inválido.');
  }

  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('sgx_passes')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'SGX_PASS_LOOKUP_FAILED',
      'No se pudo consultar el SGX VI PASS.',
      error,
    );
  }

  return data ? mapPass(data) : null;
}

export async function getSgxPassById(passId: string) {
  if (!UUID_PATTERN.test(passId)) {
    throw new Error('sgx_pass_id inválido.');
  }

  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('sgx_passes')
    .select('*')
    .eq('id', passId)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'SGX_PASS_LOOKUP_FAILED',
      'No se pudo consultar el SGX VI PASS.',
      error,
    );
  }

  return data ? mapPass(data) : null;
}

export async function getCustomerById(customerId: string) {
  if (!UUID_PATTERN.test(customerId)) {
    throw new Error('customer_id inválido.');
  }

  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'SGX_CUSTOMER_LOOKUP_FAILED',
      'No se pudo consultar la identidad del cliente.',
      error,
    );
  }

  return data ? mapCustomer(data) : null;
}

export async function getSgxOrderByJobId(jobId: string) {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error('jobId inválido.');
  }

  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('job_id', jobId)
    .maybeSingle();

  if (error) {
    throw createSupabaseOperationError(
      'SGX_ORDER_LOOKUP_FAILED',
      'No se pudo consultar el pedido SGX.',
      error,
    );
  }

  return data ? mapOrder(data) : null;
}

function isPositiveDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function compareDecimalStrings(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

export async function getSgxPurchaseHistoryByPassId(
  sgxPassId: string,
  currentPurchaseNumber: string | null,
) {
  if (!UUID_PATTERN.test(sgxPassId)) {
    throw new Error('sgx_pass_id invÃ¡lido.');
  }

  const supabase = getSgxPassSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('purchase_number,status')
    .eq('sgx_pass_id', sgxPassId)
    .eq('status', 'approved')
    .not('purchase_number', 'is', null)
    .order('purchase_number', { ascending: true });

  if (error) {
    throw createSupabaseOperationError(
      'SGX_PURCHASE_HISTORY_LOOKUP_FAILED',
      'No se pudo consultar el historial de compras SGX.',
      error,
    );
  }

  const purchaseNumbers = (data || [])
    .filter((row) => row.status === 'approved' && isPositiveDecimalString(String(row.purchase_number)))
    .map((row) => String(row.purchase_number))
    .sort(compareDecimalStrings);

  return purchaseNumbers.map((purchaseNumber) => ({
    purchase_number: purchaseNumber,
    is_current: purchaseNumber === currentPurchaseNumber,
  }));
}

export async function getSgxMilestoneReadModel(
  currentPurchaseNumber: string | null,
): Promise<PublicMilestoneReadModel> {
  const emptyModel: PublicMilestoneReadModel = {
    next_milestone: null,
    current_milestone: null,
  };

  try {
    const supabase = getSgxPassSupabase();
    const { data: milestoneRows, error: milestoneError } = await supabase
      .from('purchase_milestones')
      .select('id,purchase_number,status,rules_version')
      .in('status', ['active', 'reached'])
      .order('purchase_number', { ascending: true });

    if (milestoneError || !milestoneRows?.length) {
      return emptyModel;
    }

    const candidates = milestoneRows
      .map((row) => ({
        id: String(row.id),
        purchaseNumber: String(row.purchase_number),
        rulesVersion: typeof row.rules_version === 'string' ? row.rules_version.trim() : '',
      }))
      .filter((row) => isPositiveDecimalString(row.purchaseNumber) && row.rulesVersion);

    if (!candidates.length) {
      return emptyModel;
    }

    const { data: publishedRules, error: rulesError } = await supabase
      .from('purchase_milestone_rules')
      .select('milestone_id,version,published_at')
      .in('milestone_id', candidates.map((row) => row.id))
      .not('published_at', 'is', null);

    if (rulesError) {
      return emptyModel;
    }

    const publishedRuleKeys = new Set(
      (publishedRules || [])
        .filter((row) => row.published_at && row.milestone_id && row.version)
        .map((row) => `${row.milestone_id}:${row.version}`),
    );
    const milestones = candidates
      .filter((row) => publishedRuleKeys.has(`${row.id}:${row.rulesVersion}`))
      .sort((left, right) => compareDecimalStrings(left.purchaseNumber, right.purchaseNumber));

    if (!milestones.length) {
      return emptyModel;
    }

    const current = isPositiveDecimalString(currentPurchaseNumber || '')
      ? currentPurchaseNumber
      : null;
    const currentMilestone = current
      ? milestones.find((milestone) => milestone.purchaseNumber === current)
      : null;
    const nextMilestone = milestones.find((milestone) => !current || compareDecimalStrings(milestone.purchaseNumber, current) > 0);

    return {
      next_milestone: nextMilestone
        ? {
          purchase_number: nextMilestone.purchaseNumber,
          previous_purchase_number: milestones
            .filter((milestone) => compareDecimalStrings(milestone.purchaseNumber, nextMilestone.purchaseNumber) < 0)
            .at(-1)?.purchaseNumber || '0',
        }
        : null,
      current_milestone: currentMilestone
        ? { purchase_number: currentMilestone.purchaseNumber, reached: true }
        : null,
    };
  } catch {
    // Milestones remain optional until real rules are published. Never break
    // the authorized result page if the additive read model is unavailable.
    return emptyModel;
  }
}

export async function getOrCreateSgxPass(customerId: string) {
  const existing = await getSgxPassForCustomer(customerId);
  if (existing) {
    return existing;
  }

  const supabase = getSgxPassSupabase();
  for (let attempt = 0; attempt < MAX_PASS_GENERATION_ATTEMPTS; attempt += 1) {
    const { data, error } = await supabase
      .from('sgx_passes')
      .insert({
        customer_id: customerId,
        public_code: generateUniqueSgxCode(),
        status: 'active',
      })
      .select('*')
      .single();

    if (!error && data) {
      return mapPass(data);
    }

    if (isUniqueViolation(error)) {
      const racedPass = await getSgxPassForCustomer(customerId);
      if (racedPass) {
        return racedPass;
      }
      continue;
    }

    throw createSupabaseOperationError(
      'SGX_PASS_CREATE_FAILED',
      'No se pudo crear el SGX VI PASS.',
      error || new Error('Supabase no devolvió el PASS creado.'),
    );
  }

  throw new SupabaseBackendError(
    'SGX_PASS_CODE_COLLISION',
    'No se pudo reservar un código SGX VI PASS único.',
    500,
  );
}

function validateApprovedOrderInput({
  jobId,
  paymentId,
  customerId,
  sgxPassId,
  amount,
  currency,
  approvedAt,
}: {
  jobId: string;
  paymentId: string;
  customerId: string;
  sgxPassId: string;
  amount: number;
  currency: string;
  approvedAt: string;
}) {
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(customerId) || !UUID_PATTERN.test(sgxPassId)) {
    throw new Error('La asociación SGX contiene un ID interno inválido.');
  }
  if (!PAYMENT_ID_PATTERN.test(paymentId)) {
    throw new Error('El payment ID de Mercado Pago es inválido.');
  }
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Los datos monetarios del pedido son inválidos.');
  }
  if (Number.isNaN(new Date(approvedAt).getTime())) {
    throw new Error('La fecha de aprobación es inválida.');
  }
}

async function findExistingOrder(jobId: string, paymentId: string) {
  const supabase = getSgxPassSupabase();
  const byJob = await supabase.from('orders').select('*').eq('job_id', jobId).maybeSingle();
  if (byJob.error) {
    throw createSupabaseOperationError(
      'SGX_ORDER_LOOKUP_FAILED',
      'No se pudo consultar el pedido SGX.',
      byJob.error,
    );
  }
  if (byJob.data) {
    return mapOrder(byJob.data);
  }

  const byPayment = await supabase
    .from('orders')
    .select('*')
    .eq('mercadopago_payment_id', paymentId)
    .maybeSingle();
  if (byPayment.error) {
    throw createSupabaseOperationError(
      'SGX_ORDER_LOOKUP_FAILED',
      'No se pudo consultar el pedido SGX.',
      byPayment.error,
    );
  }

  return byPayment.data ? mapOrder(byPayment.data) : null;
}

function assertReusableOrder(
  order: SgxOrderRecord,
  expected: { jobId: string; paymentId: string; customerId: string; sgxPassId: string; amount: number; currency: string },
) {
  if (
    order.jobId !== expected.jobId
    || order.mercadopagoPaymentId !== expected.paymentId
    || order.customerId !== expected.customerId
    || order.sgxPassId !== expected.sgxPassId
    || order.amount !== expected.amount
    || order.currency !== expected.currency
  ) {
    throw new Error('El pedido SGX existente no coincide con el pago aprobado.');
  }
}

export async function associateOrderWithCustomerAndPass({
  jobId,
  paymentId,
  customerId,
  sgxPassId,
  amount,
  currency,
  approvedAt,
}: {
  jobId: string;
  paymentId: string;
  customerId: string;
  sgxPassId: string;
  amount: number;
  currency: string;
  approvedAt: string;
}) {
  validateApprovedOrderInput({ jobId, paymentId, customerId, sgxPassId, amount, currency, approvedAt });
  const supabase = getSgxPassSupabase();
  const payload = {
    job_id: jobId,
    customer_id: customerId,
    sgx_pass_id: sgxPassId,
    mercadopago_payment_id: paymentId,
    status: 'approved',
    amount,
    currency,
    approved_at: approvedAt,
  };

  const { data, error } = await supabase
    .from('orders')
    .insert(payload)
    .select('*')
    .single();

  let order: SgxOrderRecord;
  if (!error && data) {
    order = mapOrder(data);
  } else if (isUniqueViolation(error)) {
    const existing = await findExistingOrder(jobId, paymentId);
    if (!existing) {
      throw createSupabaseOperationError(
        'SGX_ORDER_UNIQUE_CONFLICT',
        'El pedido SGX tuvo una colisión de idempotencia.',
        error,
      );
    }
    assertReusableOrder(existing, { jobId, paymentId, customerId, sgxPassId, amount, currency });
    order = existing;
  } else {
    throw createSupabaseOperationError(
      'SGX_ORDER_CREATE_FAILED',
      'No se pudo asociar el pedido al SGX VI PASS.',
      error || new Error('Supabase no devolvió el pedido creado.'),
    );
  }

  const pass = await getSgxPassById(sgxPassId);
  if (!pass) {
    throw new Error('El SGX VI PASS asociado no existe.');
  }

  if (!pass.firstOrderId) {
    const { error: firstOrderError } = await supabase
      .from('sgx_passes')
      .update({ first_order_id: order.id })
      .eq('id', pass.id)
      .is('first_order_id', null);

    if (firstOrderError) {
      throw createSupabaseOperationError(
        'SGX_PASS_FIRST_ORDER_UPDATE_FAILED',
        'No se pudo completar la asociación inicial del SGX VI PASS.',
        firstOrderError,
      );
    }
  }

  return order;
}

export async function ensureSgxPassForApprovedOrder({
  email,
  jobId,
  paymentId,
  amount,
  currency,
  approvedAt,
}: {
  email: string;
  jobId: string;
  paymentId: string;
  amount: number;
  currency: string;
  approvedAt: string;
}): Promise<ApprovedSgxIdentity> {
  const customer = await getOrCreateCustomer(email);
  const pass = await getOrCreateSgxPass(customer.id);
  const order = await associateOrderWithCustomerAndPass({
    jobId,
    paymentId,
    customerId: customer.id,
    sgxPassId: pass.id,
    amount,
    currency,
    approvedAt,
  });

  return { customer, pass, order };
}
