# SGODX Production Rollout v1

Este documento describe una secuencia de aplicación futura. No se ejecutó SQL,
no se conectó Supabase y no se modificó el webhook, la UI ni la API.

## Estado de entrada auditado

Los dos preflights reales de producción fueron aprobados antes de esta
propuesta. En Road to VI hay exactamente cero eventos y cero entries, todos
los conteos de integridad reportados son cero y los objetos de Auth/event rules
ausentes fueron `SKIP` esperado.

En Purchase Milestones hay exactamente 3 Orders aprobadas: las tres tienen
`approved_at`, `created_at`, Customer, SGX PASS, Job y
`mercadopago_payment_id`; no hay empates de `approved_at`, no existe aún
`purchase_number`, contador, milestone ni award. No se hace backfill en esta
fase.

## Migrations ordenadas

Aplicar sólo después de revisar el preflight y aprobar una ventana:

1. `20260904010000_customer_auth_core_v1.sql` — Auth reutilizable.
2. `20260904020000_road_to_vi_event_system_v1.sql` — eventos, reglas,
   entries e integridad Customer/PASS.
3. `20260904030000_purchase_milestones_v1.sql` — columna y schema aditivo de
   números/milestones.

Ejecutar el postflight de cada dominio después de su migration. El antiguo
`20260904000000_road_to_vi_event_system_v1.sql` queda reemplazado localmente y
no debe aplicarse.

## Anti-race exacto para Vercel y Mercado Pago

1. Aplicar C de forma aditiva mientras la aplicación actual sigue tolerando
   `orders.purchase_number IS NULL`. No se asignan números al aprobar la
   migration.
2. Desplegar una versión compatible que persista una Order aprobada aunque la
   asignación esté pausada; durante la transición debe dejarla retryable y no
   rechazarla por falta de número.
3. Tomar un mutex compartido con el futuro RPC y mantener el contador en
   `paused`/`backfill`. El webhook viejo no asigna números; el handler
   compatible tampoco los asigna fuera del RPC.
4. Ejecutar el backfill local revisado con `approved_at ASC, id ASC`, que para
   las 3 Orders produce #1, #2 y #3. La operación aborta si aparece una Order
   aprobada sin `approved_at`, si ya existen números o si las validaciones de
   continuidad fallan.
5. Validar dentro de la misma barrera que no haya duplicados, que todas las
   aprobadas estén numeradas, que no haya números en estados no aprobados y
   que `purchase_counter.last_purchase_number = MAX(purchase_number)`.
6. Antes de liberar la barrera, ejecutar un catch-up transaccional para toda
   Order aprobada que haya quedado con número nulo durante la transición,
   usando el mismo criterio determinista. Si aparece una nueva Order durante
   ese paso, se conserva y se reintenta; no se renumera lo ya asignado.
7. Cambiar el contador a `live` sólo después de esas comprobaciones. Desde ese
   punto, cada aprobación elegible llama al RPC backend-only y el RPC realiza
   Order lock, contador lock, incremento, asignación y award idempotente en una
   única transacción.

La barrera evita carreras entre instancias Vercel y webhooks duplicados o
concurrentes de Mercado Pago. Una Order aprobada sigue siendo durable aunque
el número se asigne en un retry controlado.

## Cash rewards y reversas

El schema actual permite estados `refunded` y `chargeback`, pero la ruta
actual de webhook no conserva todavía un historial durable de transiciones de
estado para una reversa posterior; además, el mapper actual de pagos trata
`refunded`/`charged_back` como `cancelled` en esa ruta. Esto es **SAFE TO DEFER
para purchase_number**, porque el número histórico no se renumera; es
**BLOCKER BEFORE CASH REWARDS** hasta disponer de evidencia autoritativa del
provider, estado de Order auditable y una política explícita de hold/void
antes de pagar efectivo.

No se cambió ese código en esta pasada.

## Artefactos operativos

- Preflights: `preflight_customer_auth_core_v1.sql`,
  `preflight_road_to_vi_v1.sql`, `preflight_purchase_milestones_v1.sql`.
- Postflights: `postflight_customer_auth_core_v1.sql`,
  `postflight_road_to_vi_v1.sql`, `postflight_purchase_milestones_v1.sql`.
- Backfill propuesto, separado y no ejecutado:
  `supabase/backfill_purchase_numbers_v1.sql`.

La propuesta de backfill sí contiene DML y locks porque es una operación
administrativa explícita. No es una migration ni se ejecutó. Los preflights y
postflights permanecen 100% read-only.
