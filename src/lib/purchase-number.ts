import { getSupabaseAdmin } from './supabase';

export type PurchaseNumberResult = {
  outcome: 'assigned' | 'existing' | 'deferred' | 'not_approved' | 'not_found';
  // Keep bigint as decimal text; never round it through a JavaScript number.
  purchase_number: string | null;
  milestone_reached: boolean;
  milestone_id: string | null;
  award_id: string | null;
  reason: string | null;
};

export type PurchaseNumberAttempt = PurchaseNumberResult | { outcome: 'error'; reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBERING_TIMEOUT_MS = 3000;
const DEFERRED_REASONS = [
  'counter_paused', 'counter_backfill', 'prior_pending',
  'queue_position_missing', 'queue_order_violation',
] as const;

function parseResult(data: unknown): PurchaseNumberResult {
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') {
    throw new Error('invalid_rpc_result');
  }
  const row = data[0] as Record<string, unknown>;
  const numbered = row.outcome === 'assigned' || row.outcome === 'existing';
  if (!['assigned', 'existing', 'deferred', 'not_approved', 'not_found'].includes(String(row.outcome))
    || typeof row.milestone_reached !== 'boolean'
    || (row.reason !== null && typeof row.reason !== 'string')
    || (numbered
      ? typeof row.purchase_number !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.purchase_number)
        || BigInt(row.purchase_number) > 9223372036854775807n
      : row.purchase_number !== null)
    || (row.milestone_reached
      ? !numbered || typeof row.milestone_id !== 'string' || !UUID_PATTERN.test(row.milestone_id)
        || typeof row.award_id !== 'string' || !UUID_PATTERN.test(row.award_id)
      : row.milestone_id !== null || row.award_id !== null)
    || (numbered && row.reason !== null)
    || (row.outcome === 'deferred' && !DEFERRED_REASONS.some((reason) => reason === row.reason))
    || (row.outcome === 'not_approved' && row.reason !== 'order_not_approved')
    || (row.outcome === 'not_found' && row.reason !== 'order_not_found')) {
    throw new Error('invalid_rpc_result');
  }
  return {
    outcome: row.outcome as PurchaseNumberResult['outcome'],
    purchase_number: row.purchase_number as string | null,
    milestone_reached: row.milestone_reached,
    milestone_id: row.milestone_id as string | null,
    award_id: row.award_id as string | null,
    reason: row.reason as string | null,
  };
}

function safeErrorCode(error: unknown) {
  // Only known codes, never provider messages/details/PII or credentials.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === '55P03') return 'lock_timeout';
  if (code === '57014') return 'query_cancelled';
  if (code === 'PGRST202' || code === '42883') return 'rpc_unavailable';
  if (code === '42501') return 'rpc_forbidden';
  if (typeof code === 'string' && /^23[0-9A-Z]{3}$/.test(code)) return 'integrity_error';
  return 'numbering_failed';
}

// Backend-only supplementary work: it cannot fail the paid fulfillment path.
// No retry loop, identity writes, payment transitions, notifications or payout.
// A timeout is an unknown RPC outcome: the durable queue retains priority if
// no commit occurred. Repair must retry the queue head, never skip it.
export async function tryAssignPurchaseNumber(orderId: string): Promise<PurchaseNumberAttempt> {
  try {
    if (!UUID_PATTERN.test(orderId)) throw new Error('invalid_order_id');
    const { data, error } = await getSupabaseAdmin()
      .rpc('assign_purchase_number_v1', { p_order_id: orderId })
      .abortSignal(AbortSignal.timeout(NUMBERING_TIMEOUT_MS));
    if (error) throw error;
    const result = parseResult(data);
    const log = {
      event: 'purchase_number_assignment',
      order_id: orderId,
      ...result,
    };
    if (result.outcome === 'not_approved' || result.outcome === 'not_found'
      || (result.outcome === 'deferred' && !['counter_paused', 'counter_backfill'].includes(result.reason!))) {
      console.warn(log);
    } else {
      console.info(log);
    }
    return result;
  } catch (error) {
    const reason = safeErrorCode(error);
    console.error({
      event: 'purchase_number_assignment',
      order_id: UUID_PATTERN.test(orderId) ? orderId : null,
      outcome: 'error',
      reason,
      repair: 'check_approved_without_purchase_number',
    });
    return { outcome: 'error', reason };
  }
}
