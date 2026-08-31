import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  getAppBaseUrl,
  getJobCurrency,
  getJobPrice,
  getMercadoPagoAccessToken,
  getMercadoPagoWebhookSecret,
} from './server/env';

const MERCADOPAGO_API_BASE = 'https://api.mercadopago.com';
const MERCADOPAGO_TIMEOUT_MS = 20_000;
const REQUIRED_JOB_CURRENCY = 'CLP';
const REQUIRED_JOB_PRICE = 2_990;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_ID_PATTERN = /^\d{1,32}$/;
const PREFERENCE_ID_PATTERN = /^[a-zA-Z0-9-]{5,160}$/;

type JsonRecord = Record<string, unknown>;

interface MercadoPagoApiResponse<T> {
  data: T;
  httpStatus: number;
  requestId: string | null;
}

export interface MercadoPagoPreference {
  id: string;
  initPoint: string;
  httpStatus: number;
  requestId: string | null;
}

export interface MercadoPagoPayment {
  id: string;
  status: string;
  externalReference: string | null;
  currencyId: string | null;
  transactionAmount: number | null;
  preferenceId: string | null;
  orderId: string | null;
  httpStatus: number;
  requestId: string | null;
}

export interface MercadoPagoMerchantOrder {
  id: string;
  externalReference: string | null;
  preferenceId: string | null;
  httpStatus: number;
  requestId: string | null;
}

export class MercadoPagoIntegrationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 500, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MercadoPagoIntegrationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getPublicBaseUrl() {
  const configured = getAppBaseUrl();
  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch (error) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_APP_BASE_URL',
      'APP_BASE_URL no es una URL válida.',
      500,
      error,
    );
  }

  const hasOnlyOrigin = (parsed.pathname === '' || parsed.pathname === '/')
    && !parsed.search
    && !parsed.hash
    && !parsed.username
    && !parsed.password;
  const isLocalDevelopmentUrl = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);

  if (!hasOnlyOrigin || (parsed.protocol !== 'https:' && !isLocalDevelopmentUrl)) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_APP_BASE_URL',
      'APP_BASE_URL debe ser un origen HTTPS público (HTTP solo se permite en localhost).',
    );
  }

  if (import.meta.env.PROD && parsed.protocol !== 'https:') {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INSECURE_APP_BASE_URL',
      'APP_BASE_URL debe usar HTTPS en producción.',
    );
  }

  return parsed.origin;
}

export function getExpectedJobPaymentConfig() {
  const accessToken = getMercadoPagoAccessToken();
  const currency = getJobCurrency();
  const rawPrice = getJobPrice();
  const price = rawPrice === undefined ? Number.NaN : Number(rawPrice);

  if (!accessToken) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_ACCESS_TOKEN_MISSING',
      'Mercado Pago no está configurado en el servidor.',
    );
  }

  if (currency !== REQUIRED_JOB_CURRENCY || price !== REQUIRED_JOB_PRICE) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_JOB_CONFIG_MISMATCH',
      `La configuración de cobro debe ser exactamente ${REQUIRED_JOB_CURRENCY} ${REQUIRED_JOB_PRICE}.`,
    );
  }

  return {
    accessToken,
    appBaseUrl: getPublicBaseUrl(),
    currency: REQUIRED_JOB_CURRENCY,
    price: REQUIRED_JOB_PRICE,
  } as const;
}

export function getRequiredMercadoPagoWebhookSecret() {
  const secret = getMercadoPagoWebhookSecret();
  if (!secret) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_WEBHOOK_SECRET_MISSING',
      'La firma de Mercado Pago no está configurada en el servidor.',
    );
  }
  return secret;
}

async function requestMercadoPago<T>(
  path: string,
  accessToken: string,
  init: Omit<RequestInit, 'signal'> = {},
): Promise<MercadoPagoApiResponse<T>> {
  let response: Response;

  try {
    response = await fetch(`${MERCADOPAGO_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(MERCADOPAGO_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_CONNECTION_FAILED',
      'No se pudo conectar con Mercado Pago.',
      502,
      error,
    );
  }

  const requestId = response.headers.get('x-request-id') || response.headers.get('x-correlation-id');
  let data: unknown = null;

  try {
    data = await response.json();
  } catch {
    // La respuesta se valida abajo sin exponer su cuerpo.
  }

  if (!response.ok) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_API_ERROR',
      `Mercado Pago respondió HTTP ${response.status}.`,
      502,
    );
  }

  if (!asRecord(data)) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_RESPONSE',
      'Mercado Pago devolvió una respuesta inválida.',
      502,
    );
  }

  return {
    data: data as T,
    httpStatus: response.status,
    requestId,
  };
}

export async function createMercadoPagoPreference({
  jobId,
  email,
  accessToken: jobAccessToken,
}: {
  jobId: string;
  email: string;
  accessToken: string;
}): Promise<MercadoPagoPreference> {
  if (!UUID_PATTERN.test(jobId)) {
    throw new MercadoPagoIntegrationError('MERCADOPAGO_INVALID_JOB_ID', 'El jobId no es válido.', 400);
  }
  if (!jobAccessToken) {
    throw new MercadoPagoIntegrationError('MERCADOPAGO_ACCESS_TOKEN_MISSING', 'El token del job no es válido.', 400);
  }

  const { accessToken, appBaseUrl, currency, price } = getExpectedJobPaymentConfig();
  const resultUrl = `${appBaseUrl}/resultado?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(jobAccessToken)}`;
  const response = await requestMercadoPago<JsonRecord>('/checkout/preferences', accessToken, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [
        {
          id: 'gta-vi-image-generation',
          title: 'Generación de imagen estilo GTA VI',
          quantity: 1,
          currency_id: currency,
          unit_price: price,
        },
      ],
      payer: { email },
      external_reference: jobId,
      back_urls: {
        success: `${resultUrl}&payment=success`,
        pending: `${resultUrl}&payment=pending`,
        failure: `${resultUrl}&payment=failure`,
      },
      auto_return: 'approved',
    }),
  });

  const id = asNonEmptyString(response.data.id);
  const initPoint = asNonEmptyString(response.data.init_point);
  if (!id || !PREFERENCE_ID_PATTERN.test(id) || !initPoint) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_PREFERENCE',
      'Mercado Pago no devolvió una preferencia utilizable.',
      502,
    );
  }

  let checkoutUrl: URL;
  try {
    checkoutUrl = new URL(initPoint);
  } catch (error) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_CHECKOUT_URL',
      'Mercado Pago devolvió una URL de checkout inválida.',
      502,
      error,
    );
  }

  if (checkoutUrl.protocol !== 'https:') {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_CHECKOUT_URL',
      'Mercado Pago devolvió una URL de checkout no segura.',
      502,
    );
  }

  return {
    id,
    initPoint,
    httpStatus: response.httpStatus,
    requestId: response.requestId,
  };
}

function getConsistentPreferenceId(data: JsonRecord) {
  const metadata = asRecord(data.metadata);
  const order = asRecord(data.order);
  const candidates = [
    asNonEmptyString(data.preference_id),
    asNonEmptyString(metadata?.preference_id),
    asNonEmptyString(metadata?.mercadopago_preference_id),
    asNonEmptyString(metadata?.mercado_pago_preference_id),
    asNonEmptyString(order?.preference_id),
  ].filter((value): value is string => Boolean(value));
  const unique = [...new Set(candidates)];

  if (unique.length > 1) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INCONSISTENT_PREFERENCE',
      'Mercado Pago devolvió identificadores de preferencia incompatibles.',
      502,
    );
  }

  return unique[0] || null;
}

export function isValidMercadoPagoPaymentId(value: string) {
  return PAYMENT_ID_PATTERN.test(value);
}

export async function getMercadoPagoPayment(paymentId: string): Promise<MercadoPagoPayment> {
  if (!isValidMercadoPagoPaymentId(paymentId)) {
    throw new MercadoPagoIntegrationError('MERCADOPAGO_INVALID_PAYMENT_ID', 'payment_id inválido.', 400);
  }

  const { accessToken } = getExpectedJobPaymentConfig();
  const response = await requestMercadoPago<JsonRecord>(`/v1/payments/${paymentId}`, accessToken);
  const returnedId = String(response.data.id ?? '').trim();
  const status = asNonEmptyString(response.data.status);
  const amount = response.data.transaction_amount;
  const order = asRecord(response.data.order);

  if (returnedId !== paymentId || !status) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_PAYMENT',
      'Mercado Pago devolvió un pago inválido.',
      502,
    );
  }

  return {
    id: returnedId,
    status,
    externalReference: asNonEmptyString(response.data.external_reference),
    currencyId: asNonEmptyString(response.data.currency_id),
    transactionAmount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    preferenceId: getConsistentPreferenceId(response.data),
    orderId: order?.id === undefined || order.id === null ? null : String(order.id).trim() || null,
    httpStatus: response.httpStatus,
    requestId: response.requestId,
  };
}

export async function getMercadoPagoMerchantOrder(orderId: string): Promise<MercadoPagoMerchantOrder> {
  if (!PAYMENT_ID_PATTERN.test(orderId)) {
    throw new MercadoPagoIntegrationError('MERCADOPAGO_INVALID_ORDER_ID', 'order_id inválido.', 400);
  }

  const { accessToken } = getExpectedJobPaymentConfig();
  const response = await requestMercadoPago<JsonRecord>(`/merchant_orders/${orderId}`, accessToken);
  const returnedId = String(response.data.id ?? '').trim();

  if (returnedId !== orderId) {
    throw new MercadoPagoIntegrationError(
      'MERCADOPAGO_INVALID_ORDER',
      'Mercado Pago devolvió una orden inválida.',
      502,
    );
  }

  return {
    id: returnedId,
    externalReference: asNonEmptyString(response.data.external_reference),
    preferenceId: asNonEmptyString(response.data.preference_id),
    httpStatus: response.httpStatus,
    requestId: response.requestId,
  };
}

export function validateMercadoPagoWebhookSignature({
  xSignature,
  xRequestId,
  dataId,
  secret,
}: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string;
}) {
  if (!xSignature) {
    return false;
  }

  const parts = new Map<string, string>();
  for (const rawPart of xSignature.split(',')) {
    const separatorIndex = rawPart.indexOf('=');
    if (separatorIndex <= 0) {
      return false;
    }

    const key = rawPart.slice(0, separatorIndex).trim();
    const value = rawPart.slice(separatorIndex + 1).trim();
    if (!key || !value || parts.has(key)) {
      return false;
    }
    parts.set(key, value);
  }

  const timestamp = parts.get('ts');
  const suppliedHash = parts.get('v1');
  if (!timestamp || !/^\d{10,16}$/.test(timestamp) || !suppliedHash || !/^[a-fA-F0-9]{64}$/.test(suppliedHash)) {
    return false;
  }

  const manifest = [
    dataId ? `id:${dataId};` : '',
    xRequestId ? `request-id:${xRequestId};` : '',
    `ts:${timestamp};`,
  ].join('');
  const expectedHash = createHmac('sha256', secret).update(manifest).digest();
  const candidateHash = Buffer.from(suppliedHash, 'hex');

  return expectedHash.length === candidateHash.length && timingSafeEqual(expectedHash, candidateHash);
}

export function mapMercadoPagoPaymentStatus(status: string) {
  if (status === 'approved') return 'approved' as const;
  if (status === 'rejected') return 'rejected' as const;
  if (['cancelled', 'refunded', 'charged_back'].includes(status)) return 'cancelled' as const;
  if (['pending', 'in_process', 'in_mediation', 'authorized'].includes(status)) return 'pending' as const;
  return 'failed' as const;
}
