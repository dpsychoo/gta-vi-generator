const STAGE_MESSAGES = {
  preflight: 'Generation preconditions failed.',
  style_reference: 'Style reference download or buffer preparation failed.',
  input_1_download: 'Input 1 download or buffer preparation failed.',
  input_2_download: 'Input 2 download or buffer preparation failed.',
  form_preparation: 'Image request preparation failed.',
  openai_request: 'OpenAI transport failed.',
  openai_response: 'OpenAI response rejected or invalid.',
  output_decode: 'Output decoding or PNG validation failed.',
  storage_upload: 'Result storage upload failed.',
  db_completion: 'Job completion persistence failed.',
  result_email: 'Result email attempt failed.',
  recovery_preconditions: 'Recovery eligibility verification failed.',
  recovery_claim: 'Recovery claim failed.',
} as const;

export type GenerationStage = keyof typeof STAGE_MESSAGES;
type Phase = 'started' | 'completed';

const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError',
  'AbortError', 'TimeoutError', 'DevelopmentGenerationError', 'SupabaseBackendError',
  'StorageApiError', 'StorageUnknownError', 'PostgrestError']);
const PROVIDER_CODES = new Set(['invalid_api_key', 'invalid_request_error', 'invalid_request',
  'authentication_error', 'permission_error', 'rate_limit_error', 'rate_limit_exceeded',
  'insufficient_quota', 'billing_hard_limit_reached', 'content_policy_violation',
  'moderation_blocked', 'image_generation_user_error', 'server_error', 'api_error',
  'model_not_found', 'invalid_image', 'invalid_image_format', 'invalid_value',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'SUPABASE_UPLOAD_FAILED',
  'SUPABASE_CONNECTION_FAILED', 'GENERATION_RECOVERY_CLAIM_FAILED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Never serialize arbitrary error fields or invoke toString/toJSON. Regex
// redaction cannot remove all unlabelled prompts, short tokens or paths.
function field(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)[key] : undefined;
  } catch { return undefined; }
}

function stageOrDefault(stage: unknown): GenerationStage {
  return typeof stage === 'string' && Object.hasOwn(STAGE_MESSAGES, stage)
    ? stage as GenerationStage : 'preflight';
}

function jobIdOrNull(value: unknown) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function statusOrNull(value: unknown) {
  const status = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-5]\d{2}$/.test(value) ? Number(value) : 0;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function safeProviderToken(value: unknown) {
  return typeof value === 'string' && (PROVIDER_CODES.has(value)
    || /^(?:[0-9]{5}|PGRST[0-9]{3})$/.test(value)) ? value : null;
}

function requestIdOrNull(value: unknown) {
  // Only the dedicated x-request-id field, with known request ID shapes.
  return typeof value === 'string' && (/^req_[a-f0-9]{32}$/i.test(value) || UUID.test(value)) ? value : null;
}

export function sanitizeGenerationMessage(_error: unknown, stage: GenerationStage = 'preflight') {
  return STAGE_MESSAGES[stageOrDefault(stage)];
}

export function buildGenerationFailureLog(jobId: string, stage: GenerationStage, error: unknown) {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 5 && !chain.includes(current); depth++) {
    chain.push(current);
    current = field(current, 'cause') ?? field(current, 'originalError');
  }
  const first = <T>(read: (item: unknown) => T | null): T | null => {
    for (const item of chain) { const value = read(item); if (value !== null) return value; }
    return null;
  };
  const name = field(error, 'name');
  return {
    event: 'generation_failure',
    job_id: jobIdOrNull(jobId),
    stage: stageOrDefault(stage),
    error_name: typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Error',
    error_code: first((item) => safeProviderToken(field(item, 'errorCode') ?? field(item, 'code'))),
    http_status: first((item) => statusOrNull(field(item, 'openAIHttpStatus')))
      ?? first((item) => statusOrNull(field(item, 'status') ?? field(item, 'statusCode'))),
    provider_request_id: first((item) => requestIdOrNull(field(item, 'requestId'))),
    error_message: sanitizeGenerationMessage(error, stage),
  };
}

export function logGenerationStage(jobId: string, stage: GenerationStage, phase: Phase) {
  try {
    console.info({ event: 'generation_stage', job_id: jobIdOrNull(jobId),
      generation_stage: `${stageOrDefault(stage)}_${phase === 'completed' ? 'completed' : 'started'}` });
  } catch { /* Observability must never affect fulfillment. */ }
}

export function logGenerationFailure(jobId: string, stage: GenerationStage, error: unknown) {
  try { console.error(buildGenerationFailureLog(jobId, stage, error)); }
  catch { /* Keep the original exception and existing failure semantics. */ }
}

export function logOpenAIResponse(jobId: string, status: number | 'unavailable', requestId: string | null,
  errorMessage?: string, errorBody?: unknown) {
  try {
    const provider = field(errorBody, 'error');
    const payload = { event: 'openai_response', job_id: jobIdOrNull(jobId),
      http_status: statusOrNull(status), provider_request_id: requestIdOrNull(requestId),
      error_code: safeProviderToken(field(provider, 'code')),
      error_type: safeProviderToken(field(provider, 'type')),
      ...(errorMessage ? { error_message: STAGE_MESSAGES.openai_response } : {}) };
    // Only generation_failure is the detailed failure event.
    console.info(payload);
  } catch { /* Never replace an OpenAI error with a logging error. */ }
}

export function logResultEmailOutcome(jobId: string, result: unknown) {
  try {
    console.info({ event: 'generation_result_email', job_id: jobIdOrNull(jobId),
      outcome: field(result, 'skipped') === true ? 'skipped'
        : field(result, 'ok') === true ? 'sent' : 'failed' });
  } catch { /* Email remains secondary. */ }
}
