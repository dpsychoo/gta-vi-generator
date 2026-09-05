export type PurchaseNumberValue = string | number | bigint;

export interface MilestoneProgressInput {
  currentPurchaseNumber: PurchaseNumberValue;
  previousMilestoneNumber: PurchaseNumberValue;
  nextMilestoneNumber: PurchaseNumberValue;
}

export interface MilestoneProgress {
  percentage: number;
  remaining: bigint;
  reached: boolean;
}

export interface PublicNextMilestone {
  purchase_number: string;
  previous_purchase_number: string;
}

export interface PublicCurrentMilestone {
  purchase_number: string;
  reached: boolean;
}

export interface PublicMilestoneReadModel {
  next_milestone: PublicNextMilestone | null;
  current_milestone: PublicCurrentMilestone | null;
}

export interface PublicMilestoneProgress {
  percentage: number;
  remaining: string;
  reached: boolean;
}

function toNonNegativeBigInt(value: PurchaseNumberValue, fieldName: string) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${fieldName} must be non-negative.`);
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${fieldName} must be a non-negative safe integer.`);
    }
    return BigInt(value);
  }

  const normalized = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new RangeError(`${fieldName} must be a non-negative integer.`);
  }

  return BigInt(normalized);
}

export function calculateMilestoneProgress({
  currentPurchaseNumber,
  previousMilestoneNumber,
  nextMilestoneNumber,
}: MilestoneProgressInput): MilestoneProgress {
  const current = toNonNegativeBigInt(currentPurchaseNumber, 'currentPurchaseNumber');
  const previous = toNonNegativeBigInt(previousMilestoneNumber, 'previousMilestoneNumber');
  const next = toNonNegativeBigInt(nextMilestoneNumber, 'nextMilestoneNumber');

  if (next < previous) {
    throw new RangeError('nextMilestoneNumber must not be below previousMilestoneNumber.');
  }

  if (current >= next) {
    return { percentage: 100, remaining: 0n, reached: true };
  }

  const interval = next - previous;
  const elapsed = current > previous ? current - previous : 0n;
  const percentage = interval === 0n
    ? 0
    : Number((elapsed * 100n) / interval);

  return {
    percentage: Math.max(0, Math.min(100, percentage)),
    remaining: next - current,
    reached: false,
  };
}
