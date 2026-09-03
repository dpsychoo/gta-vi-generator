export const TERMS_VERSION = '2026-09-03' as const;
export const PRIVACY_VERSION = '2026-09-03' as const;
export const REFUND_POLICY_VERSION = '2026-09-03' as const;
export const LEGAL_CENTER_VERSION = TERMS_VERSION;
export const LEGAL_CENTER_CHECKOUT_MARKER = 'v1' as const;

export const LEGAL_LAST_UPDATED = '2026-09-03' as const;

export const LEGAL_PROVIDER = {
  company: 'SGODX SpA',
  rut: '78.500.041-2',
  address: 'Santiago de Apóstol 4191, La Serena, Región de Coquimbo, Chile',
  representative: 'David Ignacio Areas Castro',
  supportEmail: 'support@sgodx.com',
  legalEmail: 'legal@sgodx.com',
  privacyEmail: 'privacy@sgodx.com',
} as const;

export const LEGAL_PATHS = {
  center: '/legal',
  terms: '/terminos',
  privacy: '/privacidad',
  refunds: '/reembolsos',
} as const;

export const SERVICE_PRICE = '$2.990 CLP' as const;

export const CONTRACTUAL_COPY = {
  service: 'Generación personalizada de imagen mediante inteligencia artificial.',
  input: '1 o 2 imágenes proporcionadas por el cliente.',
  result: 'Imagen digital generada disponible en /resultado y enviada mediante enlace al correo indicado.',
  payment: 'Mercado Pago',
  start: 'Una vez confirmado el pago, el procesamiento comienza automáticamente.',
} as const;

export const RETRACT_NOTICE = 'Servicio digital personalizado. Una vez confirmado el pago, la generación comienza automáticamente. SGODX SpA excluye el derecho a retracto para este servicio conforme a las condiciones informadas antes de la compra.';

export const LEGAL_CONSENT_COPY = 'He leído y acepto los Términos del Servicio y la Política de Privacidad. Solicito que el servicio digital personalizado comience inmediatamente una vez confirmado el pago y reconozco que SGODX SpA excluye el derecho a retracto para este servicio en los términos informados antes de la compra.';

export type LegalVersionSet = {
  termsVersion: string;
  privacyVersion: string;
  refundPolicyVersion: string;
};

export type LegalConsentInput = LegalVersionSet & {
  legalAccepted: boolean;
  immediateExecutionAccepted: boolean;
  retractExclusionAcknowledged: boolean;
};

export function getCurrentLegalVersions(): LegalVersionSet {
  return {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    refundPolicyVersion: REFUND_POLICY_VERSION,
  };
}

export function isCurrentLegalConsent(input: LegalConsentInput) {
  const current = getCurrentLegalVersions();

  return input.legalAccepted === true
    && input.immediateExecutionAccepted === true
    && input.retractExclusionAcknowledged === true
    && input.termsVersion === current.termsVersion
    && input.privacyVersion === current.privacyVersion
    && input.refundPolicyVersion === current.refundPolicyVersion;
}

export function isLegalCenterV1Job(job: { metadata?: Record<string, unknown> }) {
  return job.metadata?.legal_center_version === LEGAL_CENTER_VERSION
    && job.metadata?.legal_center_checkout === LEGAL_CENTER_CHECKOUT_MARKER;
}
