import { getSecret } from 'astro:env/server';

function getOptionalServerEnv(name: string): string | undefined {
  const value = getSecret(name);
  return value && value.trim() ? value : undefined;
}

export function getSupabaseUrl() {
  return getOptionalServerEnv('SUPABASE_URL')?.trim();
}

export function getSupabaseServiceRoleKey() {
  return getOptionalServerEnv('SUPABASE_SERVICE_ROLE_KEY')?.trim();
}

export function getSupabaseUploadsBucket() {
  return getOptionalServerEnv('SUPABASE_UPLOADS_BUCKET')?.trim() || 'customer-uploads';
}

export function getSupabaseGeneratedBucket() {
  return getOptionalServerEnv('SUPABASE_GENERATED_BUCKET')?.trim() || 'generated-images';
}

export function getSupabasePrivateBucket() {
  return getOptionalServerEnv('SUPABASE_PRIVATE_BUCKET')?.trim() || 'system-private';
}

export function getMasterStyleReferencePath() {
  return getOptionalServerEnv('MASTER_STYLE_REFERENCE_PATH')?.trim() || 'styles/gta-vi-master-reference.webp';
}

// Centralized for later server-side consumers. These getters do not expose
// values to client bundles and do not change any integration's behavior.
export function getOpenAIApiKey() {
  return getOptionalServerEnv('OPENAI_API_KEY');
}

export function getOpenAIStylePrompt() {
  return getOptionalServerEnv('OPENAI_STYLE_PROMPT');
}

export function getOpenAIImageModel() {
  return getOptionalServerEnv('OPENAI_IMAGE_MODEL')?.trim() || 'gpt-image-2';
}

export function getOpenAIImageSize() {
  return getOptionalServerEnv('OPENAI_IMAGE_SIZE')?.trim() || '1024x1024';
}

export function getMercadoPagoAccessToken() {
  return getOptionalServerEnv('MERCADOPAGO_ACCESS_TOKEN')?.trim();
}

export function getMercadoPagoWebhookSecret() {
  return getOptionalServerEnv('MERCADOPAGO_WEBHOOK_SECRET');
}

export function getJobCurrency() {
  return getOptionalServerEnv('JOB_CURRENCY')?.trim();
}

export function getJobPrice() {
  return getOptionalServerEnv('JOB_PRICE')?.trim();
}

export function getResendApiKey() {
  return getOptionalServerEnv('RESEND_API_KEY')?.trim();
}

export function getResendFromEmail() {
  return getOptionalServerEnv('RESEND_FROM_EMAIL')?.trim();
}

export function getAppBaseUrl() {
  return getOptionalServerEnv('APP_BASE_URL')?.trim() || 'http://localhost:4321';
}
