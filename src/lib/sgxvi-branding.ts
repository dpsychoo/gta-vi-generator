export const PROJECT_PASS_DISPLAY_NAME = 'SGX · VI PASS';
export const PROJECT_PURCHASE_PREFIX = 'SGXVI PURCHASE';

export type PurchaseNumberInput = string | number | bigint | null | undefined;

export function formatSgxviPurchaseNumber(purchaseNumber: PurchaseNumberInput) {
  if (purchaseNumber === null || purchaseNumber === undefined) {
    return null;
  }

  const normalized = typeof purchaseNumber === 'bigint'
    ? purchaseNumber.toString()
    : typeof purchaseNumber === 'number'
      ? Number.isSafeInteger(purchaseNumber) ? String(purchaseNumber) : ''
      : purchaseNumber.trim();

  if (!/^[1-9][0-9]*$/.test(normalized)) {
    return null;
  }

  return `${PROJECT_PURCHASE_PREFIX} #${normalized.padStart(6, '0')}`;
}
