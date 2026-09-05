# SGODX PURCHASE MILESTONES v1 — arquitectura y auditoría

## Decisión ejecutiva

**GO para implementación y revisión local de Purchase Number Assignment v1.
NO-GO para activar live ahora: falta validar D en PostgreSQL autorizado y
completar rollout/backfill. Cash rewards tienen además su blocker independiente.**

La arquitectura recomendada es un contador transaccional de una sola fila,
un `purchase_number` permanente en `orders`, milestones globales y awards
idempotentes. El número comercial no usa `COUNT(*) + 1` ni nextval. El
hardening de fairness añade una posición INTERNA de admisión distinta del
número comercial; su secuencia puede tener huecos sin consumir compras (§22).

El operador confirmó A/B/C aplicadas manualmente por SQL Editor y sus tres
postflights PASS. Counter id=1, last=0, state=paused; 3 Orders approved sin
número, 0 milestones y 0 awards reales. El preflight previo confirmó fechas
e identidad completas. No se ejecutó backfill. Se propone #1…#N por
`approved_at ASC, id ASC`; N=3 sólo si no hay más aprobadas al corte.

La migration Road to VI antigua fue separada en A/B/C; no debe reaplicarse.
Auth permanece reusable y usa `customer_login` como propósito general.

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

El preflight histórico indicaba blockers=0, sin duplicados ni huérfanos. El
estado posterior comunicado ahora es A/B/C PASS; no se revalidó remotamente.

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

`assignment_state` es la barrera de rollout. El RPC devuelve `deferred`, sin
error de pago, mientras esté en `paused` o `backfill`.

### RPC propuesta

Migration D propone `public.assign_purchase_number_v1(p_order_id uuid)`:

1. Leer Order SIN lock de fila: si ya tiene número, retornar `existing` con
   el mismo número/award incluso tras refund/chargeback o con counter pausado.
   Order ausente devuelve `not_found`; no approved sin número, `not_approved`.
2. Exigir READ COMMITTED para asignaciones nuevas. Bloquear
   `purchase_counter(id=1) FOR UPDATE` PRIMERO. Validar existencia
   y state: paused/backfill devuelve `deferred`; sólo live permite asignar.
3. Tomar barrera de escrituras `LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE`
   DESPUÉS del counter; espera commit/rollback de escritores en vuelo y permite
   leer la cola completa con snapshot fresco. Luego bloquear/releer target:
   existing si otra RPC/backfill la numeró, not_approved si cambió de estado.
4. Si hay approved NULL sin posición de cola, deferred/queue_position_missing.
   Identificar la primera posición pendiente registrada, sin SKIP LOCKED ni
   saltar estados no approved: si no es p_order_id, deferred/prior_pending.
   Si ya se numeró una posición posterior, deferred/queue_order_violation.
   Exigir approved_at y Customer/PASS existentes y coherentes; comprobar
   contador=MAX de números de TODOS los estados y que bigint no se agote.
5. Calcular counter+1, asignar sólo al NULL y actualizar counter.
6. Bloquear milestone del número, y su regla seleccionada si está activo.
7. Si cumple elegibilidad, insertar snapshots del award y marcar reached.
   Cualquier error real revierte número, contador, award y milestone juntos.
8. Devolver una fila estructurada sin PII; PostgREST confirma su transacción.
   La función no ejecuta COMMIT internamente ni invoca servicios externos.

Si falla la asignación, el award o la validación, también se revierten el
contador y el número. Un timeout después del commit se resuelve reintentando:
la Order ya contiene el mismo número. La función debe usar nombres calificados,
`search_path` fijo y ejecución reservada al backend autorizado.

Orden global obligatorio: **counter → Order(s) → milestone → regla/award**.
Elimina el orden inverso del diseño anterior. No llamar la RPC desde una
transacción que ya tenga locks de Orders. La identidad del webhook se
persiste en transacciones separadas antes de numbering.

Retorno TABLE: `outcome text, purchase_number text, milestone_reached boolean,
milestone_id uuid, award_id uuid, reason text`. `purchase_number` es decimal
text para conservar bigint completo en JSON/JavaScript. Outcomes estables:
assigned, existing, deferred, not_approved, not_found. Deferred incluye
counter_paused/counter_backfill/prior_pending/queue_position_missing/
queue_order_violation; no numerados retornan número e IDs NULL.
`milestone_reached` significa que existe award para la Order, no sólo que
coincidió un número configurado. Existing conserva incluso un award void.

Seguridad: SECURITY DEFINER, owner postgres, tablas `public.*`,
`search_path=pg_catalog,pg_temp`, sin SQL dinámico. REVOKE a PUBLIC/anon/
authenticated y GRANT EXECUTE sólo a service_role, además del owner implícito.
DDL y ACL se publican en una transacción. No acepta customer_id, sgx_pass_id,
purchase_number, milestone_id ni award_id del cliente; deriva todo desde DB.
El backend conserva sus privilegios administrativos preexistentes: D no
convierte service_role ni postgres en roles sin acceso directo a tablas.

## 3. Histórico existente y backfill

La preferencia de producto es que las compras reales anteriores cuenten desde
el inicio. El preflight aprobado encontró exactamente 3 Orders aprobadas,
sin empates de `approved_at`, todas con `approved_at`, `created_at`, Customer,
SGX PASS, Job y `mercadopago_payment_id`. Por tanto, el orden histórico
propuesto sería #1, #2, #3 y luego #4 si la población sigue siendo tres al
corte; el script calcula N con todas las approved de esa ventana.

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

1. Instalar D y validar postflight D; app compatible desplegada con paused.
2. En READ COMMITTED, tomar counter FOR UPDATE; exigir paused y last=0.
3. Tomar `LOCK TABLE public.orders IN SHARE ROW EXCLUSIVE MODE`: las
   escrituras anteriores terminan antes de concederlo y el siguiente statement
   ve toda la población del corte. Los nuevos inserts/updates esperan commit.
4. Exigir trigger de admisión habilitado. Abortar ante approved sin approved_at,
   cualquier número existente o posición registrada pendiente no approved.
5. Numerar todas las approved sin número por approved_at ASC, id ASC;
   validar cobertura, unicidad y continuidad desde 1.
6. Sin liberar locks, sincronizar counter=MAX, pasar a live y confirmar juntos.
7. Si la RPC no agotó timeout, relee Order y devuelve existing si entró en el
   backfill. En caso de timeout, se reintenta ordenadamente. Escrituras
   posteriores se registran en la cola live y sólo la cabecera obtiene N+1.

No se usa advisory lock ni catch-up desprotegido. La RPC live también usa la
barrera de tabla para no ignorar inserts anteriores aún no confirmados.
Un timeout SQL aborta la transacción afectada;
un error de RPC no detiene fulfillment. Ver tiempos, excepciones y reparación
en `PRODUCTION_ROLLOUT_V1.md`.

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

El guard propuesto de D impide cambiar id o borrar una Order ya registrada en
la cola o numerada. Las filas legacy aún sin posición/número siguen bajo la
barrera y controles del backfill. Si falta la PK o approved_at, es NO-GO;
no se inventa un desempate ni se altera el timestamp histórico.

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

Matching implementado en D: igualdad exacta de purchase_number, status=active
(scheduled no se autoactiva), rules_version no vacía y regla del mismo
milestone/version publicada con published_at <= instante de asignación.
Starts_at/ends_at NULL son límites abiertos; límites presentes son inclusivos
y se evalúan con clock_timestamp DESPUÉS de tomar locks, no con approved_at
histórico ni el inicio de una transacción que pudo esperar. Title/content/hash
deben contener texto no vacío; no se inventa formato de hash ni versión.
Sin coincidencia elegible, se numera normalmente con milestone_reached=false.
Una configuración active sin reglas válidas se detecta además como FAIL en D.

Award copia milestone_name, reward_type, reward_amount, reward_currency,
rules_version y la tupla Order/Customer/PASS/número; claim_status=awarded.
No suprime conflictos UNIQUE/FK con ON CONFLICT: si un award elegible no puede
insertarse, el error revierte TODA la asignación. Existing devuelve el award
ya guardado y no lo reconstruye ni aplica premios retroactivos.

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
- El RPC devuelve el award existente al releer una Order numerada. No oculta
  conflictos de integridad durante una asignación nueva.

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

La integración de numbering modifica sólo el webhook de aprobación; no
implementa reversas, payout ni UI. En el código actual, recordUnapprovedPayment
sólo actualiza Jobs pending_payment con pago no approved. Una reversa posterior
a processing/completed no cambia Jobs ni Orders: puede quedar Order approved
sin reflejar la reversa. La prueba offline específica confirma esa limitación.

`purchase_number` representa el orden histórico de compra aprobada, no la
vigencia actual del pago ni la elegibilidad actual del Customer.

## 12. Concurrencia e idempotencia

| Riesgo | Control |
| --- | --- |
| Dos webhooks simultáneos | counter global primero, Order después |
| Webhook duplicado | leer y devolver el mismo número/award |
| Asignación doble | `purchase_number IS NULL` + UNIQUE + RPC |
| Hueco por error | contador, Order y award en una misma transacción |
| Rollback | rollback conjunto; no consumir un número parcial |
| Número manipulado | RPC backend-only, RLS/privilegios y checks positivos |
| Milestone duplicado | UNIQUE por `purchase_number` |
| Award duplicado | UNIQUE por `milestone_id` |
| Claim de Customer incorrecto | comparar sesión con snapshot del award |
| Reglas retroactivas | rows versionadas y append-only |

El contador singleton serializa asignaciones, pero por sí solo NO impide
overtaking tras una falla. Se añade la cola estable y barrera de escritores
descritas en §22. El número comercial sigue sin usar Sequence ni COUNT+1.

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
MIGRATION C — Purchase Milestones schema (aplicada manualmente)
        |
        v
MIGRATION D — RPC backend-only (propuesta local)
        |
        v
POSTFLIGHT D + APP COMPATIBLE, COUNTER paused
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
  `purchase_milestone_awards`. No crea RPC.
- **Migration D:** `assign_purchase_number_v1(uuid)`, posición interna de cola,
  secuencia privada CACHE 1, índices y guard de admisión/permanencia. Una columna
  nueva justificada, sin tabla de jobs nueva, invocación, semillas ni backfill.
- **Operación separada:** backfill y apertura de `live`; no debe ocultarse en
  una migration repetible.

### Secuencia anti-race para Vercel y Mercado Pago

Secuencia exacta en `PRODUCTION_ROLLOUT_V1.md`: D → postflight D → app
compatible con paused → comprobar fulfillment → backfill counter-first y
barrera de escrituras Orders → #1…#N → validaciones y live en el mismo commit
→ postflight sin approved nulas → nueva compra N+1. No se ejecuta ahora.

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

La separación A/B ya deja Auth Core fuera del dominio Road to VI.

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
| Dos webhooks simultáneos | HIGH | singleton counter primero, Order después |
| Webhook duplicado | HIGH | retorno idempotente por Order |
| Assignment duplicado | HIGH | condición NULL + UNIQUE + RPC |
| Contador saltado | HIGH | número comercial sin Sequence; incremento atómico con Order |
| A falla y B intenta adelantar | CRITICAL | posición durable, barrera de escritores y sólo cabecera |
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
concurrencia, rollout y threat model. La fase Assignment v1 añade código local
de RPC/helper/webhook y actualiza el backfill propuesto; no activa premios.

También se crearon `docs/CUSTOMER_AUTH_CORE_V1.md` y
`docs/PRODUCTION_ROLLOUT_V1.md`. Los postflights separados son:
`postflight_customer_auth_core_v1.sql`, `postflight_road_to_vi_v1.sql` y
`postflight_purchase_milestones_v1.sql`.

## 20. Estado de implementación

- Diseño arquitectónico: completado.
- Preflight específico: creado, read-only, no ejecutado.
- Migrations A/B/C: operador confirmó aplicación manual y postflights PASS;
  no fueron ejecutadas por este trabajo. Reconciliar schema_migrations antes
  de cualquier futuro supabase db push; no hacer repair ahora.
- Migration antigua combinada: reemplazada localmente, no ejecutada.
- Backfill histórico: creado como propuesta separada, no ejecutado.
- RPC D: creada como propuesta local, no ejecutada.
- Webhook: helper después de identidad/flujo legal y antes del claim.
  Deferred/errores no impiden generar; duplicados reintentan numbering incluso
  si el job está completed. Cada espera de lock DB tiene límite 2s; timeout
  de transporte=3s. No se promete esperar hasta commit de backfill. Un timeout
  de transporte no demuestra rollback remoto: retry devuelve existing si hubo
  commit, o conserva prioridad de cola si no lo hubo.
- Logs: evento estructurado, Order ID interno, outcome y código seguro;
  no imprime mensajes del provider, PII, tokens ni credenciales.
- Reparación: postflight D alerta live+approved NULL y counter!=MAX. Corregir
  causa y reintentar SÓLO la cabecera con la misma RPC desde backend autorizado;
  no hay cron ni garantía
  de nueva reentrega tras responder 200 al webhook. No repetir el backfill.
- UI y flujos ajenos: sin cambios.
- Milestone o premio real: no creado.
- Supabase producción: no consultado ni modificado.

## 21. Validación local y límite de evidencia

`node scripts/purchase-number-assignment-check.mjs` prueba webhook real,
verificación/mapper Mercado Pago, identidad SGX, asociación legal, claim y
helper. Los adapters de DB/provider/imagen/email son dobles en memoria; no
leen secretos ni conectan servicios. Cubre estados no approved, pago inválido,
aprobación, deferred, duplicados secuenciales/concurrentes, fallos y timeout
de numbering, reparación de completed, precisión bigint y flujo legal legacy/v1.
Incluye A falla/timeout/deferred, B no adelanta, retry A=N, B=N+1, duplicados,
webhook tardío, timestamp anterior, writer sin commit, huecos internos de cola,
respuesta perdida tras commit, anomalías de cola y prefijo histórico #1–#3.

El test SQL es estático: orden de locks, hardening, atomicidad estructural,
backfill y read-only del postflight. NO ejecuta PostgreSQL ni demuestra locks,
rollback de award o ACL reales. Antes de aplicar D se requiere una validación
autorizada en PostgreSQL con dos sesiones y casos de award/FK/rollback; esta
fase prohíbe esa ejecución. C no impone por sí sola append-only de reglas o
inmutabilidad de snapshots frente a administradores; no activar cash rewards.

## 22. Fairness y fuente oficial del orden

### Fuente real auditada en el código existente

- `src/pages/api/mercadopago-webhook.ts`, llamada a
  `ensureSgxPassForApprovedOrder`: pasa `approvedAt: new Date().toISOString()`.
  Es **B: reloj del backend al procesar el webhook**, capturado ANTES de
  esperar creación/consulta de Customer y PASS. No es la hora del commit.
- `src/lib/sgx-pass.ts`, `ensureSgxPassForApprovedOrder` →
  `associateOrderWithCustomerAndPass`: copia approvedAt a `approved_at` y
  ejecuta `.from('orders').insert(payload).select('*').single()`. No es upsert.
- El payload no envía created_at. El schema base
  `20260902000000_add_sgx_vi_pass_identity.sql` define
  `created_at timestamptz not null default timezone('utc', now())`: reloj DB
  al inicio de la transacción, no timestamp de commit ni del proveedor.
  Se audita la definición local; no se inspeccionaron defaults reales remotos.
- mercadopago_payment_id viene del ID de notificación firmado/consistente;
  `getMercadoPagoPayment` consulta `/v1/payments/{id}` y exige returnedId=id,
  status y coincidencia de referencia/preferencia/moneda/importe. Lo guarda
  como texto; no interpreta el ID como cronología.
- Ante UNIQUE 23505, busca por job_id y luego mercadopago_payment_id; exige
  coincidencia de job/pago/Customer/PASS/importe/moneda y reutiliza la Order.
  No cambia approved_at ni created_at en el retry. Los dos IDs son UNIQUE.
- El mapper de Mercado Pago no expone date_approved. El ts de la firma valida
  autenticidad y no se usa como approved_at ni como fuente de orden.

### Alternativas y definición recomendada

| Alternativa live | Evaluación |
| --- | --- |
| approved_at ASC, id ASC | El timestamp precede a I/O; una Order demorada puede aparecer después con fecha anterior. No garantiza una cola estable. |
| created_at ASC, id ASC / supuesto orden de commit | now() es inicio de transacción. El orden de commits no queda representado por esos campos. |
| Primera llamada exitosa de numbering | Permite que una falla de A cambie el ganador a B. Rechazado. |
| Posición de admisión DB + sólo cabecera pendiente | Orden durable independiente de reloj, reintentos y latencia de numbering. Elegido. |

Definición operacional recomendada, pendiente de su futura redacción en bases:
«Tras el corte histórico inicial, SGODX asigna los números de compra respetando
el orden de admisión de las transacciones aprobadas en su registro interno.
Una compra registrada conserva su prioridad aunque la numeración deba
reintentarse. No se utiliza la hora de aprobación del proveedor ni la hora
de llegada de la notificación como orden global de compra.»

Admisión significa la posición asignada por DB en la escritura que registra
por primera vez status approved. Sólo las escrituras confirmadas participan;
la posición de una transacción que aborta se descarta sin consumir número
comercial. No se afirma orden de commit: una admisión anterior puede confirmar
después y la barrera debe esperar a ese writer. Tampoco se promete orden de
inicio del checkout, timestamp del proveedor ni entrega de la imagen.

### Ampliación mínima necesaria y garantía

Una sola columna nueva: `orders.purchase_queue_position bigint`, positiva,
única e inmutable una vez asignada, más la secuencia interna que emite sus
posiciones. Orders sigue siendo la cola durable;
no hay nueva tabla de jobs, worker, cron ni RPC de registro adicional.
El trigger `guard_purchase_queue_v1` asigna la posición al insertar approved
o al pasar por primera vez a approved, en la misma transacción de la Order.
No toma el counter. Rechaza posiciones suministradas, cambios de posición,
borrado de Orders registradas/numeradas y renumeración de purchase_number.

La secuencia privada `purchase_queue_position_v1_seq` usa CACHE 1 y NO CYCLE.
Sólo el guard con owner postgres accede a ella; API roles no reciben acceso
directo. Los huecos por rollback/INSERT duplicado son posiciones internas
no comerciales. No se reutiliza, reinicia ni sincroniza con purchase_counter.
Al instalar D se reserva la zona de tickets correspondiente a las approved
existentes; el backfill asigna después las posiciones históricas `1..N` por
approved_at ASC,id ASC y no ejecuta `setval` ni reinicia la secuencia. Así una
admisión posterior queda por encima del prefijo, incluso si la numeración
histórica todavía no se ha aplicado.
**purchase_number sigue saliendo exclusivamente de counter+1 transaccional**:
un rollback de assignment/award no consume ese número. PostgreSQL documenta
la distinción entre secuencias con huecos y contadores transaccionales, y por
qué CACHE 1 importa para orden entre sesiones en
[CREATE SEQUENCE](https://www.postgresql.org/docs/current/sql-createsequence.html).

Sólo añadir un filtro sobre la cola visible aún sería insuficiente: A puede
tener ticket 1 dentro de un INSERT sin commit y B ticket 2 ya confirmado.
Por eso la RPC exige READ COMMITTED y toma counter → barrera SHARE ROW
EXCLUSIVE de Orders → target. La barrera espera a writers que ya obtuvieron
ticket; nuevos writers no pueden obtenerlo hasta liberarla. Sus lecturas
VOLATILE posteriores usan snapshot fresco. Nunca SKIP LOCKED ni un trigger
que tome counter después de bloquear Orders. Fundamentación:
[locks](https://www.postgresql.org/docs/current/explicit-locking.html) y
[snapshots de funciones](https://www.postgresql.org/docs/current/xfunc-volatility.html).

La RPC opción A sólo numera p_order_id si es cabecera; un target posterior
recibe deferred/prior_pending y no incrementa counter. Se descarta el drain
automático B para v1: ampliaría el trabajo de un webhook a compras ajenas y
complicaría timeout, fallo de award y límites de lote. Reparación manual
ordenada con la misma RPC es suficiente y queda operativa en el rollout.

Si A queda pendiente por error, timeout o award fallido, B no puede tomar su
número/hito. Un hueco sólo se cierra reparando la cabecera. Si falta posición
o ya existe evidencia de overtaking, se difiere toda progresión afectada;
no se inventa orden retrospectivo. Un head registrado no approved también
detiene la cola: no se lo salta o reubica por una reversa sin política auditada.
Eso prioriza fairness sobre disponibilidad de numbering, sin usarla como
condición de entrega de imágenes.

La garantía se limita a orden y permanencia del número, con guard/ACL activos,
secuencia sin manipular y todas las asignaciones usando la RPC. No garantiza
por sí sola elegibilidad de un premio: la ventana y configuración de reglas
siguen evaluándose al asignar. Una demora que cruce ends_at necesita una
política promocional explícita; no se promete un award retroactivo. Ninguna
Order posterior recibe por ese motivo el número reservado a la cabecera.

### Webhook tardío e histórico

Un pago aprobado antes por Mercado Pago pero registrado después en SGODX
recibe posición posterior. En el código actual date_approved no se importa;
aun así approved_at de backend puede ser anterior por demora antes del INSERT
o desfase de relojes. Ninguno altera prioridad live. Si en el futuro se guarda
date_approved, seguirá siendo evidencia de pago, no una inserción retroactiva
en la cola. Nunca se renumeran números entregados.

El backfill inicial tiene semántica distinta y explícita: todas las approved
del corte protegido reciben posiciones `1..N` por approved_at ASC,id ASC y,
siguiendo ese orden, #1…#N. Si siguen siendo tres: #1,#2,#3 y counter=3/live
atómicos. Toda nueva admisión posterior tiene posición mayor que el prefijo;
no se resetea ni se renumera la secuencia y sólo la nueva cabecera puede
recibir N+1.

### Decisión de activación

**NO-GO live ahora.** D es propuesta local y se requieren pruebas PostgreSQL
reales autorizadas: dos sesiones, A sin commit/B presente, timeout/rollback,
award fallido, trigger/ACL, no renumeración y backfill concurrente. Los tests
offline prueban el contrato y código backend, no locks reales. Una vez
validados esos requisitos, la infraestructura de números puede avanzar.
**CASH REWARDS siguen bloqueados separadamente** por el lifecycle incompleto
de refund/reversal/chargeback y la política de elegibilidad/claim/payout.
