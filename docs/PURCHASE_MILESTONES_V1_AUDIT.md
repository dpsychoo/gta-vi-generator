# SGODX PURCHASE MILESTONES v1 — arquitectura y auditoría

## Decisión ejecutiva

**GO para diseño, preflight y revisión. NO-GO para aplicar migrations,
backfill, cambios de webhook o producción en esta fase.**

La arquitectura recomendada es un contador transaccional de una sola fila,
un `purchase_number` permanente en `orders`, milestones globales y awards
idempotentes. No se usará `COUNT(*) + 1` ni una PostgreSQL Sequence normal.

Los dos preflights reales de producción fueron aprobados antes de esta pasada.
El preflight de Purchase Milestones encontró exactamente 3 Orders aprobadas,
las 3 con `approved_at`, `created_at`, Customer, SGX PASS, Job y
`mercadopago_payment_id`; no encontró empates ni objetos de números,
contador, milestones o awards. La estrategia histórica propuesta es #1, #2,
#3 por `approved_at ASC, id ASC`, sin backfill ejecutado ahora.

La migration Road to VI antigua no debe aplicarse tal como estaba: mezclaba
Customer Auth Core con el dominio de eventos. La separación A/B/C documentada
abajo mantiene Auth reusable y usa `customer_login` como propósito general.

Esta auditoría se basa únicamente en el schema, migrations, código y
documentación disponibles localmente en el workspace, más el resultado de
producción pegado por el usuario. No se consultó producción ni se ejecutó SQL.

## Evidencia auditada

- `supabase/migrations/20260902000000_add_sgx_vi_pass_identity.sql`: define
  `customers`, `sgx_passes`, `orders`, `events` y `event_entries`.
- `supabase/migrations/20260904010000_customer_auth_core_v1.sql`,
  `20260904020000_road_to_vi_event_system_v1.sql` y
  `20260904030000_purchase_milestones_v1.sql`: propuestas separadas; no fueron
  aplicadas por este trabajo.
- `src/lib/sgx-pass.ts`: crea/recupera Customer y SGX PASS y crea Orders
  aprobadas con `approved_at` y `mercadopago_payment_id`.
- `src/pages/api/mercadopago-webhook.ts`: valida el webhook antes de asociar
  la compra aprobada.
- `docs/ROAD_TO_VI_EVENT_SYSTEM_V1_AUDIT.md`: auditoría previa del dominio de
  eventos y de la separación conceptual de Customer/PASS/Auth.

El resultado pegado indica `blockers = 0`, cero duplicados, cero huérfanos y
cero participantes actuales. También indica que `event_rules`, Auth tokens,
sessions y rate limits todavía no existen en producción. Ese resultado no se
revalidó remotamente en esta fase.

## 1. Purchase number

### Recomendación

Añadir a `orders`:

| Campo | Decisión |
| --- | --- |
| `purchase_number` | `bigint`, nullable durante el rollout, positivo cuando existe |
| Unicidad | `UNIQUE(purchase_number)`; los NULL legacy pueden coexistir |
| Asignación | sólo dentro del RPC transaccional, después de confirmar `status = 'approved'` |
| Permanencia | nunca se limpia ni se reasigna después de refund, chargeback o reversa |

No se añade `purchase_number_assigned_at` en v1: `approved_at`, el número y
`awarded_at` cubren la evidencia necesaria sin duplicar timestamps.

La unicidad por sí sola no impide que un cliente escriba el campo. La API
pública no debe exponer esa capacidad y el RPC debe ser la única ruta
autorizada para asignarlo. Si se concede acceso de escritura administrativo,
debe quedar restringido a una función/rol específico y auditable.

## 2. Contador transaccional

### `purchase_counter`

Una única fila global, conceptualmente:

| Campo | Propósito |
| --- | --- |
| `id` | `smallint`, PK y siempre `1` |
| `last_purchase_number` | último número confirmado; inicia en `0` |
| `assignment_state` | `paused`, `backfill` o `live` |
| `created_at` | auditoría |
| `updated_at` | auditoría operacional |

`assignment_state` es la barrera de rollout. El RPC rechaza nuevas
asignaciones mientras esté en `paused` o `backfill`.

### RPC propuesta

La función futura `assign_purchase_number(order_id)` debe ejecutar, en este
orden y en una sola transacción:

1. Bloquear la Order con `FOR UPDATE`.
2. Si ya tiene `purchase_number`, devolver ese mismo número de forma
   idempotente, incluso si la Order luego quedó refunded o chargeback.
3. Si no tiene número, exigir `status = 'approved'` y `approved_at` válido.
4. Bloquear la fila única de `purchase_counter` con `FOR UPDATE`.
5. Exigir `assignment_state = 'live'`.
6. Incrementar `last_purchase_number` en memoria y asignar el siguiente valor
   a la Order.
7. Buscar el milestone de ese número que esté habilitado para award.
8. Crear el award, si corresponde, en la misma transacción.
9. Marcar el milestone como `reached`, si el award se creó.
10. Devolver Order, número y award; el commit de la función confirma todo
    junto.

Si falla la asignación, el award o la validación, también se revierten el
contador y el número. Un timeout después del commit se resuelve reintentando:
la Order ya contiene el mismo número. La función debe usar nombres calificados,
`search_path` fijo y ejecución reservada al backend autorizado.

El orden de locks debe ser idéntico en todos los caminos: Order, contador,
milestone/award. Así se evita que otro endpoint cree un deadlock bloqueando el
contador antes de la Order.

## 3. Histórico existente y backfill

La preferencia de producto es que las compras reales anteriores cuenten desde
el inicio. El preflight aprobado encontró exactamente 3 Orders aprobadas,
sin empates de `approved_at`, todas con `approved_at`, `created_at`, Customer,
SGX PASS, Job y `mercadopago_payment_id`. Por tanto, el orden histórico
propuesto es #1, #2, #3 y la siguiente compra live será #4.

El backfill, sin embargo, debe ser una operación separada y aprobada, no una
parte automática de la migration. No se ejecuta en esta fase.

### Alcance recomendado

- Candidatas primarias: Orders con `status = 'approved'` y `approved_at IS NOT
  NULL`.
- Orders `refunded`, `chargeback`, `cancelled` o `reversed`: no se deben
  considerar aprobadas históricas sólo por el status actual. Se necesita
  evidencia versionada de que estuvieron aprobadas; `approved_at` puede ser
  evidencia operativa, pero debe confirmarse como invariante del sistema.
- Orders approved sin `approved_at`: bloquear el backfill o resolverlas
  manualmente antes de asignar números.
- Si ya existen números, preservarlos y detenerse ante duplicados, conflictos
  o una numeración parcial no explicada.

### Corte y barrera

1. Ejecutar el preflight.
2. Tomar el mutex compartido y bloquear el contador en `backfill`.
3. Congelar la población histórica como las compras aprobadas elegibles en
   esa transacción; las nuevas aprobaciones quedan durables y retryable, pero
   no reciben número mientras la barrera esté activa.
4. Asignar sólo filas sin número, por `approved_at ASC, id ASC`, sin
   renumerar las ya asignadas.
5. Abortar ante cualquier approved sin `approved_at`, número existente,
   duplicado o conflicto de estado.
6. Validar unicidad, continuidad desde `1` y coincidencia con el total
   esperado.
7. Fijar `last_purchase_number = N`.
8. Ejecutar catch-up de approved sin número que hayan quedado durante la
   transición y cambiar a `live` sólo después de validar todo.

Si no se puede garantizar el corte o detener el camino de asignación, no se
debe abrir `live`. El backfill no debe ser una migration repetible: depende de
datos, evidencia de pagos y una decisión irreversible de producto. El archivo
propuesto es `supabase/backfill_purchase_numbers_v1.sql`.

## 4. Tie-breaker histórico

El orden determinista recomendado es:

```text
approved_at ASC NULLS LAST, orders.id ASC
```

`orders.id` es la PK UUID disponible en el schema versionado, por lo que es
único y estable como desempate. No es un reloj ni codifica causalidad; sólo
resuelve empates exactos de `approved_at`. `created_at` es un dato secundario
de auditoría, no sustituye al tie-breaker.

La inmutabilidad de `orders.id` no está garantizada por una regla de negocio
visible en Git, sino por privilegios, PK y convención de aplicación. Si el
preflight no confirma `orders.id` como PK, el resultado es **NO-GO** para
backfill automático. Un `approved_at` NULL también requiere resolución
manual, no un desempate inventado.

## 5. `purchase_milestones`

Schema mínimo recomendado:

| Campo | Decisión |
| --- | --- |
| `id` | UUID PK |
| `purchase_number` | `bigint NOT NULL`, positivo y UNIQUE |
| `name` | nombre administrativo/público configurable |
| `reward_type` | tipo de premio; no hardcodea un número |
| `reward_amount` | importe nullable para premios no monetarios |
| `reward_currency` | moneda nullable; obligatoria si el tipo es monetario |
| `status` | `draft`, `scheduled`, `active`, `reached`, `cancelled` |
| `rules_version` | versión publicada actualmente, nullable mientras es draft |
| `starts_at` / `ends_at` | ventana opcional de activación, en UTC |
| `created_at` / `updated_at` | auditoría |

No se añaden contador cacheado, `winner_id`, `customer_id`, `sgx_pass_id`,
provider de pagos, slug ni una columna de progreso. El número global es la
identidad del milestone; el progreso se deriva de Orders.

`active` significa que el hito puede resolverse cuando se asigna exactamente
su número. Al crear el award, la misma transacción pasa el milestone a
`reached`. Un milestone alcanzado no debe editar recompensa ni reglas; si se
requiere corregir un error, debe existir una operación explícita y auditable,
no un cambio silencioso.

## 6. Reglas promocionales versionadas

Se recomienda `purchase_milestone_rules`, separada de `event_rules`,
`terms_version`, `privacy_version` y `refund_policy_version`:

| Campo | Propósito |
| --- | --- |
| `id` | UUID PK |
| `milestone_id` | FK al milestone |
| `version` | versión del texto y condiciones |
| `title` | título de las bases del hito |
| `content` | contenido completo versionado |
| `content_hash` | prueba de integridad del contenido |
| `published_at` | NULL hasta publicar |
| `created_at` | auditoría |

`UNIQUE(milestone_id, version)` y una política append-only son suficientes
para v1. El puntero `purchase_milestones.rules_version` debe referenciar una
versión perteneciente al mismo milestone. Una versión publicada no se edita ni
se elimina; se publica otra versión.

No se redactan bases legales en esta fase. El award guarda la versión usada
para otorgar el premio (`rules_version`) y, cuando se reclama, la versión que
el ganador aceptó (`claim_rules_version`). El contenido se deriva de la fila
inmutable y no se reutiliza `Road to VI rules_version`.

## 7. `purchase_milestone_awards`

Campos mínimos más la evidencia necesaria:

| Campo | Propósito |
| --- | --- |
| `id` | UUID PK |
| `milestone_id` | milestone ganador |
| `order_id` | Order que recibió el número |
| `customer_id` | snapshot del Customer ganador |
| `sgx_pass_id` | snapshot del PASS relacionado |
| `purchase_number` | copia permanente y verificable del número |
| `rules_version` | bases vigentes al otorgar |
| `claim_rules_version` | bases aceptadas al reclamar, nullable |
| `claim_status` | estado del claim |
| `awarded_at` | momento del otorgamiento |
| `claimed_at` | momento del claim, nullable |
| `verified_at` | momento de verificación, nullable |
| `voided_at` / `void_reason` | invalidación conservando historial |
| `created_at` / `updated_at` | auditoría |

Para no cambiar retroactivamente el premio de un award, se recomienda copiar
también `milestone_name`, `reward_type`, `reward_amount` y
`reward_currency` en el award. No hace falta copiar los identificadores del
provider: la Order es la fuente de evidencia de pago.

Garantías relacionales recomendadas:

- `UNIQUE(milestone_id)`: como un número identifica un único milestone,
  impide más de un award por milestone y también ganar el mismo milestone dos
  veces.
- FK compuesta `(milestone_id, purchase_number)` hacia el milestone: impide
  que el snapshot use otro número.
- FK compuesta `(order_id, customer_id, sgx_pass_id, purchase_number)` hacia
  Orders: impide cruzar Order, Customer, PASS y número.
- El RPC usa `ON CONFLICT` o una lectura bloqueada para devolver el award
  existente de forma idempotente.

No se implementa pago automático del premio. `paid` queda fuera del estado v1
hasta diseñar un payout separado, con ledger, reconciliación y controles de
fraude.

## 8. Claim y Customer Authentication

El claim debe exigir una sesión de Customer válida. El cliente no envía ni
elige `customer_id`, `sgx_pass_id`, `order_id` o `purchase_number` como fuente
de autorización.

Flujo conceptual:

1. Customer solicita magic link con respuesta genérica.
2. Se consume un token single-use, expirado y almacenado sólo como hash.
3. Se crea una sesión nueva, opaca, con cookie `HttpOnly`, `Secure`,
   `SameSite=Lax` y duración absoluta corta.
4. El claim carga `session.customer_id` server-side.
5. Bloquea el award, verifica que `award.customer_id` coincide y que no está
   `void`/`expired`.
6. Revalida la política de Order, refund/chargeback, Customer y PASS.
7. Guarda `claimed_at`, `claim_rules_version` y avanza el estado de forma
   idempotente.

`sgx_passes.public_code` no es autenticación. Una persona que conoce un código
público no debe poder consultar un award ni reclamarlo. La identidad del
ganador tampoco se expone en el progreso público sin consentimiento.

## 9. Generalización de Auth Core

La propuesta antigua de Road to VI usaba:

```text
customer_auth_tokens.purpose = 'road_to_vi_login'
```

Eso acoplaba un mecanismo de identidad general a una sola campaña. La
recomendación implementada en Migration A es:

- default y propósito v1: `customer_login`;
- no guardar `road_to_vi` en el propósito de autenticación;
- mantener la autorización de Road to VI, milestones y futuras features en la
  sesión y en sus propias comprobaciones de dominio;
- si aparece un token one-shot con otra intención, añadir un propósito
  explícito mediante una decisión de seguridad y allow-list server-side;
- no aceptar propósitos arbitrarios enviados por el cliente.

`customer_auth_tokens`, `customer_sessions` y
`customer_auth_rate_limits` pertenecen a **CUSTOMER AUTH CORE**. No deben
referenciar tablas de eventos ni milestones para poder servir a SGX PASS,
Road to VI, claims y futuras capacidades.

## 10. Estados

### Configuración del milestone

```text
draft -> scheduled -> active -> reached
draft/scheduled/active -> cancelled
```

`completed` no es necesario en v1: mezclaría la resolución de configuración
con el claim. Si se necesita cerrar administrativamente un programa completo,
se puede añadir en otra revisión con una definición precisa.

### Award/claim

```text
awarded -> claimed -> verified
awarded/claimed/verified -> void
awarded/claimed -> expired
```

`notified` no se hace estado core hasta tener una política de entrega y
reintento auditable. `paid` queda diferido porque no habrá payout automático.

`void` conserva la fila, el número, las reglas y el motivo. `expired` sólo se
usa cuando una fecha de claim válida lo justifica; no debe ser un alias de
refund.

## 11. Refund, chargeback, fraude y revocación

- Un refund o chargeback nunca borra ni cambia `orders.purchase_number`.
- Antes del claim, el award puede pasar a `void` si la política aprobada lo
  exige.
- Después de `claimed` o `verified`, se conserva el historial y se abre
  revisión; no se paga ni se revierte automáticamente sin política.
- Un Customer suspendido o un PASS `suspended/revoked` bloquea nuevas acciones
  sensibles mientras se revisa, pero no borra el award.
- Una reversa no desplaza automáticamente el premio al número siguiente.
- El siguiente número sólo se asigna a otra Order aprobada independiente.
- El motivo, actor, timestamps y versión de reglas deben quedar auditables.

### Auditoría del código actual

El schema base permite `refunded` y `chargeback`, pero la ruta actual de
webhook no mantiene un historial durable de transiciones para una reversa
posterior. La función `mapMercadoPagoPaymentStatus` mapea `refunded` y
`charged_back` a `cancelled` en el camino actual, por lo que no existe todavía
una evidencia de provider suficientemente específica para liberar efectivo.

Clasificación:

- **SAFE TO DEFER:** integrar la reversa con `purchase_number`; el número
  histórico permanece y no se renumera.
- **BLOCKER BEFORE CASH REWARDS:** payout efectivo antes de tener evento de
  reversa autoritativo, estado de Order auditable, hold/void de award y
  reconciliación de provider.

No se modifica webhook/API/UI en esta fase.

`purchase_number` representa el orden histórico de compra aprobada, no la
vigencia actual del pago ni la elegibilidad actual del Customer.

## 12. Concurrencia e idempotencia

| Riesgo | Control |
| --- | --- |
| Dos webhooks simultáneos | lock de Order y contador global |
| Webhook duplicado | leer y devolver el mismo número/award |
| Asignación doble | `purchase_number IS NULL` + UNIQUE + RPC |
| Hueco por error | contador, Order y award en una misma transacción |
| Rollback | rollback conjunto; no consumir un número parcial |
| Número manipulado | RPC backend-only, RLS/privilegios y checks positivos |
| Milestone duplicado | UNIQUE por `purchase_number` |
| Award duplicado | UNIQUE por `milestone_id` |
| Claim de Customer incorrecto | comparar sesión con snapshot del award |
| Reglas retroactivas | rows versionadas y append-only |

El contador singleton es suficiente para serializar asignaciones globales. No
se necesita una Sequence normal ni `COUNT(*) + 1`.

## 13. Progreso público futuro

El contador público debe derivarse de:

```text
MAX(orders.purchase_number)
```

con `0` cuando no hay números, nunca de `COUNT(*)` de Orders actuales. Así un
refund no hace retroceder el progreso y un número permanente no desaparece.

La respuesta pública sólo debe contener, por ejemplo:

```text
current_max = 384
next_milestone = 1000
reward = configuración pública del milestone
```

No debe incluir email, Customer ID, PASS code, Order ID ni identidad del
ganador. La cifra puede cachearse brevemente, pero la fuente de verdad sigue
siendo el número máximo asignado.

## 14. Rollout seguro

```text
PRE-MIGRATION
  preflight_purchase_milestones_v1.sql
        |
        v
MIGRATION A — Customer Auth Core
        |
        v
MIGRATION B — Road to VI Event System
        |
        v
MIGRATION C — Purchase Milestones schema + RPC controlado
        |
        v
COUNTER = paused/backfill
  backfill histórico transaccional y validación
        |
        v
COUNTER = live
  webhook aprobado -> RPC -> número y award atómicos
```

Organización recomendada:

- **Migration A:** `customer_auth_tokens`, `customer_sessions`,
  `customer_auth_rate_limits`, propósito general `customer_login` y sus
  índices/RLS.
- **Migration B:** campos y reglas de `events`, `event_entries`,
  `event_rules`, integridad Customer/PASS y RLS del dominio de eventos.
- **Migration C:** `orders.purchase_number`, `purchase_counter`,
  `purchase_milestones`, `purchase_milestone_rules` y
  `purchase_milestone_awards`. El RPC es un diseño posterior separado; no se
  crea ni ejecuta en C en esta fase.
- **Operación separada:** backfill y apertura de `live`; no debe ocultarse en
  una migration repetible.

### Secuencia anti-race para Vercel y Mercado Pago

1. Aplicar C de forma aditiva mientras el webhook actual sigue tolerando
   `orders.purchase_number IS NULL`; la migration no asigna números.
2. Desplegar una versión compatible que persista la Order approved aunque el
   contador esté pausado y deje la asignación retryable, sin rechazar la
   compra por falta de número.
3. Tomar el mutex compartido con el futuro RPC y mantener el contador en
   `paused`/`backfill`. El handler viejo no asigna números y el handler
   compatible tampoco los asigna fuera del RPC.
4. Ejecutar el backfill revisado con `approved_at ASC, id ASC`; para las 3
   Orders auditadas produce #1, #2 y #3. Abortar ante approved sin
   `approved_at`, números existentes, duplicados o discontinuidad.
5. Validar bajo la misma barrera que toda approved tenga número, que no haya
   números en estados no aprobados, que no haya duplicados y que el contador
   coincida con `MAX(purchase_number)`.
6. Antes de liberar la barrera, ejecutar catch-up para cada approved que haya
   quedado con número nulo durante la transición, usando el mismo orden. No
   renumerar lo ya asignado; las nuevas Orders quedan durables y se reintentan.
7. Cambiar a `live` sólo después de las comprobaciones. Desde entonces cada
   aprobación elegible llama al RPC backend-only para realizar lock de Order,
   lock de contador, incremento, asignación y award idempotente atómicos.

La barrera compartida evita carreras entre instancias Vercel y webhooks
duplicados o concurrentes de Mercado Pago.

Esto ofrece rollback mental simple: antes de `live` se puede detener el
rollout sin números; después de asignar números no se hace rollback destructivo
ni renumeración, sólo correcciones explícitas de estado.

## 15. Relación con Road to VI

Road to VI conserva su dominio propio: `events`, `event_entries`,
`event_rules`, elegibilidad y participación. Purchase Milestones es global y
usa Orders aprobadas, no `event_entries`.

Customer y SGX PASS siguen siendo identidad y relación de producto. El award
los referencia para reclamar, pero el número global no depende de que el
Customer siga activo en Road to VI. La elegibilidad de eventos y la elegibilidad
de un award son decisiones distintas.

La migration Road to VI propuesta debe retirar conceptualmente Auth Core de su
alcance, aunque las tablas puedan aplicarse físicamente en otra ventana.

## 16. Relación con futura Subscription

Subscription/Membership es una capa de entitlement comercial independiente:

```text
Customer -> SGX PASS -> Orders / Road to VI / Purchase Milestones
Customer -> Memberships / Subscriptions
```

Milestones no debe tener `provider`, `provider_customer_id` ni campos de
Mercado Pago. Orders puede conservar el identificador del payment provider.
Una futura Subscription debe tener sus propios estados, períodos y provider
IDs sin reutilizar `purchase_counter`, awards o `event_entries`.

## 17. Threat model

| Amenaza | Nivel | Mitigación principal |
| --- | --- | --- |
| Dos webhooks simultáneos | HIGH | lock Order + singleton counter |
| Webhook duplicado | HIGH | retorno idempotente por Order |
| Assignment duplicado | HIGH | condición NULL + UNIQUE + RPC |
| Contador saltado | HIGH | no Sequence; incremento atómico con Order |
| Rollback parcial | CRITICAL | Order, counter y award en una transacción |
| Manipulación de `purchase_number` | CRITICAL | backend-only RPC, roles, RLS y checks |
| Milestone duplicado | HIGH | UNIQUE `purchase_number` |
| Award duplicado | HIGH | UNIQUE `milestone_id` |
| Claim por Customer incorrecto | CRITICAL | sesión server-side + FK/snapshot compuesto |
| `public_code` usado como auth | CRITICAL | magic link y sesión generalizada |
| Refund/chargeback fraud | HIGH | revalidación, void auditable y revisión |
| Admin cambia milestone alcanzado | HIGH | append-only/restricción y snapshots del award |
| Cambio retroactivo de reglas | HIGH | `purchase_milestone_rules` inmutable por versión |
| Replay de magic link | HIGH | hash, expiry y single-use atómico |
| Cookie/sesión robada | HIGH | TLS, HttpOnly, Secure, expiry, revoke y revalidación |
| Enumeración/brute force | HIGH | respuesta genérica y rate limit por email/IP |

## 18. Preflight creado

Se creó `supabase/preflight_purchase_milestones_v1.sql`.

Es 100% read-only y devuelve una única tabla de Results con:

```text
section | check_name | value | status | detail
```

Comprueba:

- presencia de Orders, Customer, SGX PASS, Jobs, milestones, awards y counter;
- columnas disponibles para `approved_at`, `created_at`, provider IDs,
  refunds/reversas y `purchase_number`;
- cantidad y status de Orders approved;
- Orders approved sin `approved_at`, `created_at`, Customer, PASS o Job;
- empates de `approved_at`;
- cobertura de `mercadopago_payment_id` y posibles identificadores genéricos;
- status actuales `refunded`, `chargeback`, `cancelled`, `failed` y
  `rejected`;
- números existentes, duplicados, no positivos, máximo y faltantes en Orders;
- duplicados de milestones y awards;
- consistencia de snapshots de awards contra Orders;
- estado del contador y concordancia con `MAX(purchase_number)`.

Si falta una tabla o columna, la fila correspondiente devuelve `SKIP` con
`detail = 'table_or_column_missing'` y no intenta referenciarla estáticamente.
El archivo no fue ejecutado.

## 19. Documentación creada

Este archivo documenta las decisiones de schema, contador, histórico,
milestones, awards, claims, Auth Core, reglas versionadas, estados,
concurrencia, rollout y threat model. No contiene bases legales ni implementa
APIs, UI, webhook, backfill o premios reales.

También se crearon `docs/CUSTOMER_AUTH_CORE_V1.md` y
`docs/PRODUCTION_ROLLOUT_V1.md`. Los postflights separados son:
`postflight_customer_auth_core_v1.sql`, `postflight_road_to_vi_v1.sql` y
`postflight_purchase_milestones_v1.sql`.

## 20. Estado de implementación

- Diseño arquitectónico: completado.
- Preflight específico: creado, read-only, no ejecutado.
- Migrations A/B/C: creadas como propuestas locales, no ejecutadas.
- Migration antigua combinada: reemplazada localmente, no ejecutada.
- Backfill histórico: creado como propuesta separada, no ejecutado.
- RPC: no creado.
- APIs/webhook/UI: no modificados.
- Milestone o premio real: no creado.
- Supabase producción: no consultado ni modificado.
