# Production Configuration

Configuración no secreta conocida para la baseline de producción. Los valores sensibles y credenciales se mantienen fuera del repositorio.

## Branch y dominio

- Branch productiva: `main`.
- Dominio productivo conocido: `create.sgodx.com`.
- URL base de aplicación: se configura externamente mediante `APP_BASE_URL`.
- DNS y Email Routing: administrados en Cloudflare; las reglas completas deben verificarse y respaldarse fuera de Git.

## Rutas relevantes

### Públicas

- `/`
- `/legal`
- `/terminos`
- `/privacidad`
- `/reembolsos`
- `/resultado`

### Backend

- `/api/create-job`
- `/api/mercadopago-webhook`
- `/api/job-status`
- `/api/image`
- `/api/cron/cleanup-images`

El endpoint `/api/generate-image` es un flujo de desarrollo y no está disponible en producción.

## Cron

- Ruta: `/api/cron/cleanup-images`.
- Schedule declarado: `0 4 * * *` en `vercel.json`.
- Protección: autorización Bearer mediante `CRON_SECRET`.
- Retención: 30 días desde `media_retention_started_at`.

## Supabase

### Buckets utilizados

- `customer-uploads`: imágenes originales del cliente.
- `generated-images`: resultados generados.
- `system-private`: referencia maestra privada.

### Tablas principales

- `jobs`: ciclo de vida del job, pago, rutas de media, estados de correo y retención.
- `legal_acceptances`: versiones legales y confirmación contractual asociada al job.
- `customers`: identidad persistente por email normalizado.
- `sgx_passes`: identidad SGX PASS persistente por customer.
- `orders`: asociación del pago aprobado con customer y SGX PASS.

`events` y `event_entries` existen como modelo de participación futura y no forman parte del flujo contractual actual.

## Email

- Proveedor: Resend.
- Remitente: valor externo configurado mediante `RESEND_FROM_EMAIL`.
- Correos: confirmación contractual y resultado de generación.
- Email Routing público: reglas del dominio de SGODX administradas externamente en Cloudflare; no se almacenan en este repositorio.

## Producto y legal

- Precio contractual: `$2.990 CLP`.
- Formatos permitidos: JPEG, PNG y WebP.
- Versiones legales: `2026-09-03`.
- Legal Center: `/legal`, `/terminos`, `/privacidad`, `/reembolsos`.
- Procesamiento de imágenes: Sharp `0.35.3` con libvips `8.18.3`.
- Seguridad de uploads: validación MIME, magic bytes y bloqueo de loaders no admitidos.

## Servicios externos

- Vercel: hosting, funciones y cron.
- Supabase: base de datos y Storage.
- Mercado Pago: checkout y webhooks de pago.
- OpenAI: generación de imágenes.
- Resend: correo transaccional.
- Cloudflare: DNS y Email Routing.

No se incluyen credenciales, tokens, API keys, secretos ni valores de variables.

