import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const checks = [];

function check(name, condition) {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  checks.push(name);
}

function includesAll(content, values) {
  return values.every((value) => content.includes(value));
}

try {
  const createJob = read('src/pages/api/create-job.ts');
  const legal = read('src/lib/legal.ts');
  const acceptance = read('src/lib/legal-acceptance.ts');
  const webhook = read('src/pages/api/mercadopago-webhook.ts');
  const email = read('src/lib/email.ts');
  const cleanup = read('src/pages/api/cron/cleanup-images.ts');
  const migration = read('supabase/migrations/20260903000000_add_legal_acceptances.sql');
  const preflight = read('supabase/preflight_legal_center_v1.sql');
  const purchaseEmailComponent = read('src/emails/PurchaseConfirmationEmail.tsx');
  const jobStore = read('src/lib/job-store.ts');
  const privacy = read('src/pages/privacidad.astro');
  const generator = read('src/components/GeneratorSection.astro');
  const footer = read('src/components/SiteFooter.astro');

  const emailValidationIndex = createJob.indexOf('if (!email ||');
  const imageCountValidationIndex = createJob.indexOf('if (files.length < 1 || files.length > 2)');
  const imageValidationIndex = createJob.indexOf('for (const file of files)');
  const consentInputIndex = createJob.indexOf('const legalConsent =');
  const consentRequiredIndex = createJob.indexOf('if (!legalConsent.legalAccepted');
  const consentVersionIndex = createJob.indexOf('if (!isCurrentLegalConsent(legalConsent))');
  const createJobIndex = createJob.indexOf('const job = await createJob({');
  const acceptanceIndex = createJob.indexOf('await createLegalAcceptance({');
  const attachIndex = createJob.indexOf('await attachJobInputImages(job.id, files);');
  const preferenceIndex = createJob.indexOf('const payment = await createMercadoPagoPreference({');
  const legacyBranchStart = webhook.indexOf('if (!legalAcceptance)');
  const legacyElseIndex = webhook.indexOf('} else {', legacyBranchStart);
  const claimIndex = webhook.indexOf('const claim = await claimApprovedPaymentForProcessing');
  const legacyBranch = webhook.slice(legacyBranchStart, legacyElseIndex);
  const purchaseEmail = email.slice(email.indexOf('export async function sendPurchaseConfirmationEmail'));

  check('A: email y fotos se validan antes del consentimiento', emailValidationIndex >= 0 && imageCountValidationIndex > emailValidationIndex && imageValidationIndex > imageCountValidationIndex && consentInputIndex > imageValidationIndex && consentRequiredIndex > consentInputIndex);
  check('B: servidor valida consentimiento y versiones vigentes', includesAll(createJob, [
    'legalAccepted', 'immediateExecutionAccepted', 'retractExclusionAcknowledged',
    'termsVersion', 'privacyVersion', 'refundPolicyVersion', 'isCurrentLegalConsent',
  ]) && consentRequiredIndex < consentVersionIndex && consentVersionIndex < createJobIndex);
  check('C: job nuevo sin consentimiento no llega a createJob', consentRequiredIndex >= 0 && consentRequiredIndex < createJobIndex && consentVersionIndex < createJobIndex);
  check('D: flujo contractual mantiene el orden completo', consentVersionIndex < createJobIndex && createJobIndex < acceptanceIndex && acceptanceIndex < attachIndex && attachIndex < preferenceIndex);
  check('E: versiones legales son constantes de código', includesAll(legal, [
    "TERMS_VERSION = '2026-09-03'", "PRIVACY_VERSION = '2026-09-03'", "REFUND_POLICY_VERSION = '2026-09-03'",
  ]));
  check('F: fallo de acceptance deja job fallido, payment pending y sin checkout', includesAll(createJob, [
    "console.error('[create-job] legal_acceptance_failed')", "status: 'failed'", "paymentStatus: 'pending'",
  ]) && acceptanceIndex < attachIndex && attachIndex < preferenceIndex);
  check('G: acceptance legal es única por job y usa estado de correo separado', includesAll(acceptance, [
    "from('legal_acceptances')", 'confirmation_email_status', 'sameAcceptance',
  ]) && migration.includes('constraint legal_acceptances_job_id_key unique (job_id)'));
  check('H: jobs nuevos tienen marcador persistido y legacy queda distinguible', includesAll(legal, [
    'LEGAL_CENTER_VERSION', 'LEGAL_CENTER_CHECKOUT_MARKER', 'isLegalCenterV1Job',
  ]) && includesAll(jobStore, ['legal_center_version: LEGAL_CENTER_VERSION', 'legal_center_checkout: LEGAL_CENTER_CHECKOUT_MARKER']));
  check('I: job legacy sin acceptance puede seguir y no recibe email contractual', legacyBranch.includes('legacy_job_without_legal_acceptance') && !legacyBranch.includes('sendPurchaseConfirmationEmail'));
  check('J: job nuevo sin acceptance no puede pasar como legacy', webhook.includes('isLegalCenterV1Job(associatedJob)') && legacyBranch.includes('throw new Error'));
  check('K: webhook asocia customer_id sin crear otra acceptance', includesAll(webhook, [
    'getLegalAcceptanceByJobId(jobId)', 'updateLegalAcceptanceCustomerId(jobId, identity.customer.id)',
  ]) && acceptance.includes('if (existing.customerId === customerId)'));
  check('L: confirmación usa idempotencia por job', email.includes('contract-confirmation/${job.id}') && email.includes('purchaseConfirmationInFlight'));
  check('M: fallo de correo marca acceptance failed sin tocar jobs.email_status', purchaseEmail.includes("updateLegalAcceptanceConfirmation(jobId, 'failed')") && !purchaseEmail.includes('emailStatus'));
  check('N: email contractual contiene reembolsos esenciales inline', includesAll(purchaseEmailComponent, [
    'Condiciones esenciales de retracto y reembolsos', 'cobros duplicados serán revisados',
    'No procede devolución voluntaria', 'Nada de lo anterior limita derechos irrenunciables',
  ]) && purchaseEmailComponent.includes('Política de Reembolsos'));
  check('O: correo de resultado permanece separado', read('src/emails/GtaResultEmail.tsx').includes('export type GtaResultEmailProps') && !read('src/emails/GtaResultEmail.tsx').includes('PurchaseConfirmationEmail'));
  check('P: media_retention_started_at se establece una sola vez al completar', includesAll(jobStore, [
    'mediaRetentionStartedAt: row.media_retention_started_at', "updates.status === 'completed'", ".is('media_retention_started_at', null)", '!current.mediaRetentionStartedAt',
  ]) && migration.includes('add column if not exists media_retention_started_at'));
  check('Q: cleanup no usa created_at y excluye marker NULL', !cleanup.includes('created_at') && includesAll(cleanup, [
    "media_retention_started_at', cutoff", ".not('media_retention_started_at', 'is', null)", ".is('media_purged_at', null)",
  ]));
  check('R: cleanup purga sólo después de 30 días', cleanup.includes('RETENTION_DAYS = 30') && cleanup.includes(".lt('media_retention_started_at', cutoff)"));
  check('S: cleanup es idempotente y tolera objetos inexistentes', includesAll(cleanup, [
    'isMissingStorageObject', 'storage.from(bucket).remove(paths)', ".is('media_purged_at', null)",
  ]));
  check('T: cleanup no elimina registros de negocio', !cleanup.includes(".from('jobs').delete(") && !cleanup.includes('.delete()') && cleanup.includes('media_purged_at: purgedAt'));
  check('U: migration aditiva sin operaciones destructivas ni backfill', !/\b(drop|truncate)\b|\bdelete\s+from\b|\bupdate\s+public\b/i.test(migration) && migration.includes('add column if not exists media_retention_started_at'));
  check('V: preflight robusto, read-only y con coverage de datos', preflight.includes("to_regclass('public.legal_acceptances')") && !preflight.includes("'public.legal_acceptances'::regclass") && includesAll(preflight, [
    'duplicate_groups', 'excess_rows', 'job_orphan_rows', 'customer_orphan_rows',
    'total_jobs', 'jobs_with_legal_acceptance', 'media_retention_started_at', 'media_purged_at',
  ]) && !/\b(insert|update|delete|alter|drop|truncate|create)\b/i.test(preflight));
  check('W: documentos muestran Legal Center, precio checkout y proveedores permitidos', includesAll(generator, [
    '$2.990 CLP', 'legal-consent', 'retractExclusionAcknowledged', 'Pagar con Mercado Pago',
  ]) && footer.includes('LEGAL_PATHS') && includesAll(legal, ["center: '/legal'", "terms: '/terminos'", "privacy: '/privacidad'", "refunds: '/reembolsos'"]) && privacy.includes('30') && includesAll(privacy, [
    'Mercado Pago', 'OpenAI', 'Supabase', 'Resend', 'Vercel', 'Google Fonts',
  ]));

  console.log(`PASS: ${checks.length} checks de SGODX LEGAL CENTER v1`);
  for (const item of checks) {
    console.log(`- ${item}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
