# SGODX GTA VI Generator — Production Baseline

## Estado

| Campo | Valor |
| --- | --- |
| Producto | SGODX GTA VI Generator |
| Estado | Production Stable |
| Fecha | 2026-09-04 |
| Commit estable | `c9d692cfa46ef673ea7cd93ff6caea409eba6442` |
| Dominio productivo | `create.sgodx.com` |
| Precio contractual | `$2.990 CLP` |

## Stack

- Astro
- Vercel
- Mercado Pago
- OpenAI
- Supabase
- Resend
- Cloudflare DNS / Email Routing

## Flujo validado

```text
upload
  → consentimiento legal
  → legal_acceptance
  → Mercado Pago
  → approved
  → Customer
  → SGX PASS
  → confirmación contractual
  → OpenAI
  → resultado
  → email resultado
  → media_retention_started_at
```

La versión fue validada con una compra real aprobada end-to-end.

## Legal Center

- `/legal`
- `/terminos`
- `/privacidad`
- `/reembolsos`

Versiones legales vigentes: `2026-09-03`.

## Medios, seguridad y retención

- Retención: hasta 30 días desde `media_retention_started_at`.
- Sharp runtime: `0.35.3`.
- libvips: `8.18.3`.
- Formatos admitidos: JPEG, PNG y WebP.
- Seguridad de uploads: MIME + magic bytes + Sharp loader blocking.
- SGX PASS: persistente por customer.

## Cron y migración

- Ruta: `/api/cron/cleanup-images`.
- Frecuencia: diaria según `vercel.json`.
- Protección: `CRON_SECRET`.
- Migración de Legal Center aplicada en Supabase: `20260903000000_add_legal_acceptances.sql`.

## Validaciones realizadas

- Build: PASS.
- Legal tests: PASS.
- Sharp security checks: PASS.
- Pago real aprobado: PASS.
- `legal_acceptance`: PASS.
- Confirmation email: PASS.
- Generation: PASS.
- Result email: PASS.
- SGX PASS: PASS.
- Retention timestamp: PASS.

## ROLLBACK BASELINE

El tag local `prod-2026-09-04-stable` y el commit `c9d692cfa46ef673ea7cd93ff6caea409eba6442` representan la versión conocida como estable. Si una futura release introduce un problema, esta baseline es el punto conocido al que puede volver a desplegarse.

## Alcance y privacidad

Este documento no incluye emails de clientes, payment IDs, access tokens, API keys, secretos, fotografías ni información personal.

