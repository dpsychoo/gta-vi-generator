# Production Monitoring Runbook

Runbook básico para la baseline `c9d692cfa46ef673ea7cd93ff6caea409eba6442`. Las verificaciones de datos deben usar agregados y no exponer emails, tokens, payment IDs, public codes ni fotografías.

No se implementan alertas externas todavía. Este documento define criterios operativos para revisión manual y para una futura automatización.

## Criterios de estado

| Estado | Criterio conservador |
| --- | --- |
| HEALTHY | Sin errores 5xx sostenidos; pagos aprobados avanzan normalmente; cobertura legal completa en jobs nuevos; sin fallos sostenidos de correo; cron y cleanup dentro de su ventana diaria; sin backlog de retención vencida. |
| WARNING | Incidente aislado, función lenta, job `processing` por más de 15 minutos, confirmación de correo pendiente, un ciclo de cron omitido o backlog pequeño que no crece. Investigar durante la misma jornada. |
| CRITICAL | 5xx sostenidos por más de 5 minutos, pagos aprobados que no completan por más de 30 minutos, aceptación legal faltante en un job nuevo, fallos repetidos de webhook/proveedor, cron ausente por más de 48 horas o backlog de media vencida creciente. Escalar y pausar cambios. |

## Vercel

Revisar logs y métricas por ventana de 24 horas:

- Errores HTTP 5xx y concentración por ruta.
- `/api/create-job`: volumen, errores, latencia anormal y rechazos esperados de validación.
- `/api/mercadopago-webhook`: errores 5xx, respuestas de verificación fallida y reintentos.
- `/api/cron/cleanup-images`: última ejecución, duración, resultado y fallos de cleanup.
- Duración anormal, timeouts o aumento de memoria en funciones.

Un 4xx de validación no es por sí solo un incidente. Un 5xx sostenido o una función que deja trabajos en estados intermedios debe investigarse como mínimo en WARNING.

## Supabase

Usar `supabase/monitoring_production.sql` en el SQL Editor, sin modificarlo y sin mostrar datos sensibles. Revisar:

- jobs `failed`;
- pagos `approved` sin job `completed`;
- jobs `processing` durante demasiado tiempo;
- `email_status = 'failed'`;
- `confirmation_email_status = 'failed'`;
- aceptación legal faltante donde corresponda para jobs Legal Center v1;
- jobs `completed` sin `media_retention_started_at` cuando tienen resultado;
- media con `media_retention_started_at` mayor a 30 días y `media_purged_at` nulo.

Una aceptación legal faltante en un job nuevo es CRITICAL porque rompe el registro contractual. Un fallo aislado de correo es WARNING mientras el resultado y el registro contractual sigan íntegros.

## Mercado Pago

Revisar el panel del proveedor y los agregados del SQL:

- estados `approved`, `rejected`, `pending` y `cancelled`;
- pagos aprobados sin finalización del job;
- errores o reintentos de webhook;
- discrepancias de monto, moneda, referencia o preferencia;
- duplicidades o fallos de idempotencia.

Un pago `pending` o `rejected` es estado normal. Un `approved` que no progresa, o una cadena de webhooks fallidos, es WARNING/CRITICAL según duración y volumen.

## Resend

Revisar entregas y errores de:

- correo de confirmación contractual;
- correo de resultado;
- estados `sent` y `failed`;
- rebotes o errores de dominio/remitente.

Un fallo aislado es WARNING. Fallos sostenidos en ambos tipos de correo o un remitente inválido son CRITICAL para la operación de comunicaciones, aunque no deben revertir un job ya completado.

## Storage

Revisar existencia, permisos y crecimiento de:

- `customer-uploads`;
- `generated-images`;
- `system-private`.

Comprobar que el cleanup elimina media elegible y marca `media_purged_at` de forma idempotente. Objetos vencidos que se acumulan o permisos que impiden borrar son WARNING; una exposición pública o pérdida de la referencia privada es CRITICAL.

## Triage recomendado

1. Confirmar si el incidente es de disponibilidad, pago, generación, correo o retención.
2. Consultar primero agregados de las últimas 24 horas.
3. Correlacionar estados sin copiar datos personales a tickets o capturas.
4. Revisar logs de la función concreta y del proveedor correspondiente.
5. Si es CRITICAL, detener cambios de configuración/código y escalar al responsable operativo.
6. Registrar la hora, el alcance agregado, la causa probable y la resolución sin incluir secretos ni identificadores sensibles.

