# Environment Manifest

Inventario de nombres de variables detectados en `.env.example`, `src/lib/server/env.ts` y sus consumidores. Este documento registra nombres y propósito general; no registra valores.

| NAME | REQUIRED/OPTIONAL | SERVER/CLIENT | PRODUCTION | PROPÓSITO GENERAL | PROVEEDOR |
| --- | --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | REQUIRED | SERVER | Sí | Autenticación de llamadas de generación de imágenes | OpenAI |
| `OPENAI_IMAGE_MODEL` | OPTIONAL | SERVER | Sí | Configuración del modelo de imagen expuesta por el manifiesto de entorno | OpenAI |
| `OPENAI_IMAGE_SIZE` | OPTIONAL | SERVER | Sí | Configuración de tamaño de imagen disponible en el manifiesto de entorno | OpenAI |
| `OPENAI_STYLE_PROMPT` | REQUIRED | SERVER | Sí | Prompt maestro privado para generación | OpenAI |
| `MERCADOPAGO_ACCESS_TOKEN` | REQUIRED | SERVER | Sí | Autenticación de API, preferencias y consulta de pagos | Mercado Pago |
| `MERCADOPAGO_WEBHOOK_SECRET` | REQUIRED | SERVER | Sí | Validación de autenticidad del webhook | Mercado Pago |
| `RESEND_API_KEY` | REQUIRED | SERVER | Sí | Autenticación para correo transaccional | Resend |
| `RESEND_FROM_EMAIL` | REQUIRED | SERVER | Sí | Remitente de correos transaccionales | Resend |
| `APP_BASE_URL` | REQUIRED | SERVER | Sí | URL pública para checkout, enlaces de resultado y enlaces legales | Vercel / aplicación |
| `JOB_ACCESS_TOKEN_ENCRYPTION_KEY` | REQUIRED | SERVER | Sí | Cifrado server-side de tokens de acceso de jobs | Aplicación |
| `CRON_SECRET` | REQUIRED | SERVER | Sí | Autorización del endpoint de cleanup | Vercel Cron / aplicación |
| `SUPABASE_URL` | REQUIRED | SERVER | Sí | URL del proyecto de backend y Storage | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED | SERVER | Sí | Acceso administrativo server-side a Database y Storage | Supabase |
| `SUPABASE_UPLOADS_BUCKET` | OPTIONAL | SERVER | Sí | Bucket de imágenes originales de clientes | Supabase Storage |
| `SUPABASE_GENERATED_BUCKET` | OPTIONAL | SERVER | Sí | Bucket de imágenes generadas | Supabase Storage |
| `SUPABASE_PRIVATE_BUCKET` | OPTIONAL | SERVER | Sí | Bucket de referencia maestra privada | Supabase Storage |
| `MASTER_STYLE_REFERENCE_PATH` | OPTIONAL | SERVER | Sí | Ruta de la referencia maestra privada | Supabase Storage |
| `JOB_CURRENCY` | REQUIRED | SERVER | Sí | Moneda contractual del job | Mercado Pago / aplicación |
| `JOB_PRICE` | REQUIRED | SERVER | Sí | Precio contractual del job | Mercado Pago / aplicación |

## Variables de plataforma

El código también consulta las banderas integradas `import.meta.env.DEV` e `import.meta.env.PROD` de Astro. No son secretos ni variables que deban configurarse manualmente en este manifiesto.

`SUPABASE_ANON_KEY` aparece únicamente en documentación histórica (`README.md`) y no fue detectada como variable consumida por el código actual ni por `.env.example`; no forma parte del inventario operativo.

## Regla de almacenamiento

**Los valores reales NO deben almacenarse en Git.**

No incluir valores de variables en README, documentación, SQL, capturas públicas, issues ni archivos del proyecto.

