# SGODX — ROAD TO VI / EVENT SYSTEM v1

## Alcance, decisión y evidencia

**GO arquitectónico para continuar con la revisión; NO-GO para implementar o aplicar cambios todavía.**

Los dos preflights reales de producción quedaron aprobados antes de esta
pasada. Road to VI reportó blockers = 0, cero eventos/entries, cero
duplicados y cero huérfanos; la ausencia de Auth y `event_rules` fue `SKIP`
esperado. Esta pasada sólo reorganiza artefactos locales y no revalida
remotamente esos resultados.

Base auditada: `17be33a4e63f56c67a0a6b555369cc239ce42d39`, tag `prod-2026-09-04-stable-v2`, branch `feature/road-to-vi-v1`.

Se revisaron migrations, SQL, TypeScript, helpers, queries, APIs, componentes, páginas, tests y documentación. No se ejecutó SQL contra Supabase, no se ejecutó el preflight y no se consultó el catálogo remoto. Por eso, el schema descrito como “real” es el schema versionado observable en Git; las diferencias manuales de producción deben confirmarse con el preflight antes de cualquier migration.

No se modificaron producción, Legal Center, checkout, Mercado Pago, OpenAI, Sharp, cron, emails ni SGX PASS core.

## 1. Infraestructura existente

| Área | Evidencia | Estado real |
| --- | --- | --- |
| `events` | `20260902000000_add_sgx_vi_pass_identity.sql` | Tabla base, sin código de eventos |
| `event_entries` | misma migration | Tabla base, sin enrollment |
| `customers` | misma migration + `sgx-pass.ts` | Identidad server-side por email normalizado |
| `sgx_passes` | misma migration + `sgx-pass.ts` | Un PASS persistente por Customer |
| `orders` | misma migration + webhook/`sgx-pass.ts` | Fuente de compras y pagos aprobados |
| `jobs` | dependencia de migrations/código | Schema base completo no está versionado en estas migrations |
| `legal_acceptances` | `20260903000000_add_legal_acceptances.sql` | Consentimiento de checkout, no bases de eventos |
| APIs/páginas de eventos | búsqueda completa del repo | No existen |
| Auth de Customer | búsqueda completa del repo | No existe; sólo hay capability por Job |
| Tests de eventos | búsqueda completa del repo | No existen |

Las menciones a eventos actuales son contractuales/documentales: los términos dicen que un PASS no garantiza participación, elegibilidad, premios ni eventos.

## 2. Schema versionado actual

### `public.events`

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | No | `gen_random_uuid()` |
| `slug` | `text` | No | — |
| `name` | `text` | No | — |
| `status` | `text` | No | `'draft'` |
| `starts_at` | `timestamptz` | Sí | — |
| `ends_at` | `timestamptz` | Sí | — |
| `created_at` | `timestamptz` | No | `timezone('utc', now())` |

Constraints:

- PK `id`.
- `events_slug_key UNIQUE(slug)`.
- `events_status_check`: `draft | active | closed | archived`.
- `events_dates_check`: `ends_at >= starts_at` cuando ambos existen.
- No tiene FK salientes.
- Índices explícitos: ninguno; PK y unique crean índices implícitos.
- RLS habilitado por migration.
- Policies declaradas en Git: ninguna.

Faltan `description`, ventana de entrada, `rules_version` y `updated_at`. `name` cubrirá el título visible; no se duplicará como `title`.

### `public.event_entries`

| Columna | Tipo | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | No | `gen_random_uuid()` |
| `event_id` | `uuid` | No | — |
| `sgx_pass_id` | `uuid` | No | — |
| `customer_id` | `uuid` | No | — |
| `status` | `text` | No | `'eligible'` |
| `eligible` | `boolean` | No | `true` |
| `entered_at` | `timestamptz` | Sí | — |
| `metadata` | `jsonb` | No | `'{}'::jsonb` |

Constraints/índices:

- PK `id`.
- FK `event_id → events.id` sin cascada destructiva.
- FK `sgx_pass_id → sgx_passes.id` sin cascada destructiva.
- FK `customer_id → customers.id` sin cascada destructiva.
- `event_entries_event_pass_key UNIQUE(event_id, sgx_pass_id)`.
- Status: `eligible | entered | locked | ineligible | withdrawn`.
- Índice `event_entries_customer_id_idx(customer_id)`.
- RLS habilitado.
- Policies declaradas en Git: ninguna.

No hay `rules_version`, `rules_accepted_at`, `updated_at`, unique directo por Customer ni FK que valide que el PASS pertenece al Customer de esa misma entry.

### `customers`, `sgx_passes`, `orders` y `jobs`

- `customers`: PK `id`; `email`, `normalized_email`, `created_at`, `updated_at`; unique `normalized_email`; índice por email; RLS habilitado.
- `sgx_passes`: PK `id`; FK `customer_id`; unique `customer_id`; unique `public_code`; `status` `active | suspended | revoked`; `first_order_id`; RLS habilitado. **No existe** unique `(id, customer_id)` en el schema versionado.
- `orders`: PK `id`; FKs a `jobs`, `customers` y `sgx_passes`; unique `job_id` y `mercadopago_payment_id`; status `pending | approved | rejected | cancelled | refunded | chargeback | failed`; `approved_at timestamptz NULL`; checks de monto/moneda; RLS habilitado.
- `jobs`: el código consume `id`, email, status/payment, `customer_id`, `sgx_pass_id`, access tokens y fechas; la definición base no está en estas migrations y debe validarse con el preflight.

## 3. Entry no es eligibility

La semántica final es:

- La elegibilidad se calcula dinámicamente server-side.
- No se crea una fila `event_entries` para cachear elegibilidad.
- Una nueva inscripción crea la fila sólo después de requisitos, aceptación de bases y confirmación explícita “Unirme”.
- La inserción debe escribir siempre `status = 'entered'`, `eligible = true`, `entered_at = now()` explícitamente.
- El default histórico `status = 'eligible'` se conserva por compatibilidad; no se usará ni se cambia mediante ALTER destructivo.

### Semántica final de `eligible`

La columna no se elimina ni se usa como fuente de verdad actual. En Road to VI v1 será un snapshot histórico: “esta inscripción cumplía la elegibilidad cuando fue creada”. Se escribe `true` de forma explícita al insertar, no por depender del default.

La elegibilidad actual se vuelve a evaluar en cada operación sensible. Si el PASS luego queda `suspended` o `revoked`, no se hace un backfill masivo ni se reescriben todas las entries: el acceso/beneficio futuro se bloquea server-side. Una acción administrativa que deba retirar una inscripción puede pasar `status` a `ineligible`; `eligible = true` sigue significando que fue elegible al entrar, no que lo sea ahora. Esta semántica evita interpretar ambos campos como estados simultáneos contradictorios.

El contador público ignora `eligible` por completo.

## 4. Integridad Customer ↔ SGX PASS

El schema actual tiene:

- PK `sgx_passes.id`.
- `UNIQUE(sgx_passes.customer_id)`.
- `UNIQUE(sgx_passes.public_code)`.
- Ningún `UNIQUE(id, customer_id)`.

PostgreSQL exige que una FK referencie una PK o una constraint/índice unique con **la misma lista de columnas**. La PK sobre `id` no basta para referenciar `(id, customer_id)`.

La solución mínima y aditiva es añadir `UNIQUE(id, customer_id)` a `sgx_passes` y después:

```sql
FOREIGN KEY (sgx_pass_id, customer_id)
REFERENCES sgx_passes (id, customer_id)
```

Es seguro respecto del schema versionado porque `id` ya es PK: no puede haber dos filas con el mismo `id`. El preflight debe ejecutarse primero para detectar datos manuales incompatibles antes de añadir la FK.

## 5. Idempotencia doble

Se conservan ambas garantías:

- `UNIQUE(event_id, sgx_pass_id)`: protege la identidad PASS y cubre el invariant actual de un PASS por Customer.
- `UNIQUE(event_id, customer_id)`: protege la regla de negocio directamente aunque el modelo de PASS cambie, una importación omita la relación o aparezca otra representación de identidad.

La FK compuesta evita que un atacante o bug combine Customer A con PASS B. El preflight debe reportar cero duplicados y cero cruces antes de crear el segundo unique.

## 6. Magic link y sesión

### `customer_auth_tokens`

La tabla propuesta contiene:

- `id uuid` PK.
- `customer_id uuid` FK.
- `token_hash text UNIQUE`.
- `purpose = 'customer_login'` como default general de Customer Auth; Road to
  VI no es propietario del mecanismo de autenticación.
- `expires_at timestamptz`.
- `used_at timestamptz NULL`.
- `created_at timestamptz`.

El token se genera con `crypto.randomBytes(32)`, se entrega una sola vez por email y sólo se persiste su hash. Expiración inicial recomendada: 15 minutos. El consumo será atómico mediante update condicionado a `used_at IS NULL` y `expires_at > now()`; sólo una solicitud puede reclamarlo.

La respuesta es siempre genérica: “Si existe una membresía asociada, te enviaremos un enlace.” No se distingue Customer existente, inexistente, PASS inexistente o email inválido fuera de la validación sintáctica mínima.

### `customer_sessions`

La migration propuesta añade:

- `id uuid` PK.
- `customer_id uuid` FK.
- `session_token_hash text UNIQUE`.
- `expires_at timestamptz`.
- `revoked_at timestamptz NULL`.
- `created_at timestamptz`.
- `last_seen_at timestamptz NULL`.

El browser recibe sólo el token opaco aleatorio en cookie:

```text
HttpOnly; Secure; SameSite=Lax; Path=/
```

No se necesita `CUSTOMER_SESSION_SECRET`: un token aleatorio de 32 bytes, TLS, cookie protegida y hash en DB son suficientes para el modelo mínimo. La sesión no contiene autorización de PASS ni de evento; cada operación vuelve a cargar Customer, PASS, evento, fechas, reglas y compra approved.

Session fixation: consumir magic link siempre crea una sesión nueva y aleatoria; se ignora/rota cualquier cookie previa. Logout revoca `revoked_at` y limpia la cookie. Se recomienda expiración absoluta corta, inicialmente 30 minutos; `last_seen_at` es auditoría y no extiende automáticamente la sesión.

Cookie robada: HTTPS, HttpOnly, no logging, expiración y revocación reducen la ventana, pero no sustituyen revalidar PASS y evento. Customer eliminado o sesión revocada/expirada produce rechazo genérico. El replay del magic link falla porque `used_at` ya no es NULL.

## 7. Rate limit serverless

No se usará `Map` en memoria: no es consistente entre instancias serverless.

La propuesta incluye `customer_auth_rate_limits` con `scope` (`email`/`ip`), `key_hash`, ventana, contador y `blocked_until`. El hash debe ser HMAC server-side de email normalizado o IP; nunca se almacena email/IP plaintext. Se recomienda una clave dedicada de rate limit, no una capability de Job.

Política inicial sugerida:

- máximo 3 solicitudes por hash de email en 15 minutos;
- máximo 10 solicitudes por hash de IP en 15 minutos;
- backoff y bloqueo temporal tras exceder;
- upsert/incremento atómico en DB para carreras;
- cleanup posterior de filas expiradas en operación de mantenimiento aprobada.

El mensaje y el tiempo de respuesta deben mantenerse equivalentes para evitar enumeración. La tabla es preferible a infraestructura externa nueva para v1; un rate limiter de edge existente puede ser una capa adicional, no una dependencia única.

La variable conceptual para el HMAC puede llamarse `CUSTOMER_AUTH_RATE_LIMIT_SECRET`; esta documentación no contiene su valor. Las filas de `customer_auth_rate_limits` no deben crecer indefinidamente: se requiere una retención limitada y un cleanup/expiry futuro de ventanas expiradas. No se añade cron en esta fase; esa operación queda pendiente de aprobación y mantenimiento posterior.

## 8. Historial real de bases

### `event_rules`: sí

Se recomienda una tabla `event_rules` porque almacenar sólo `events.rules_version` y reemplazar el documento no permite demostrar su contenido histórico. Versionar únicamente en código es simple, pero una base/archivo puede desaparecer de un deploy o quedar separado del row aceptado.

Schema propuesto:

- `id uuid` PK.
- `event_id uuid` FK a `events`.
- `version text`.
- `title text`.
- `content text`.
- `content_hash text`.
- `published_at timestamptz NULL`.
- `created_at timestamptz`.
- `UNIQUE(event_id, version)`.

`events.rules_version` y `event_entries.rules_version` referencian `(event_id, version)`. `event_entries.rules_accepted_at` prueba cuándo se aceptó. No se inserta contenido legal en esta pasada.

La regla operativa es append-only: una versión publicada no se actualiza ni elimina; se publica otra versión. Si el nivel de cumplimiento futuro exige una garantía contra el propio service role, se añadirá audit log/trigger en una etapa posterior.

La FK de `events` es exactamente `FOREIGN KEY (id, rules_version) REFERENCES event_rules(event_id, version)` y la de `event_entries` es exactamente `FOREIGN KEY (event_id, rules_version) REFERENCES event_rules(event_id, version)`. La unicidad `(event_id, version)` satisface ambas referencias. La dependencia no crea un ciclo de inserción imposible porque `events.rules_version` es nullable: se crea el evento con el puntero NULL, se inserta y publica la regla, y sólo después se actualiza el evento al número de versión publicado. Una entry sólo puede guardar una versión existente y perteneciente a su evento.

## 9. Participant count exacto

“X miembros en Road to VI” será:

```sql
SELECT COUNT(*)
FROM event_entries AS ee
JOIN sgx_passes AS sp ON sp.id = ee.sgx_pass_id
WHERE ee.status IN ('entered', 'locked')
  AND sp.status = 'active'
```

La entry histórica permanece, pero deja de contar desde que el PASS deja de estar `active`.

No cuenta `eligible`, `ineligible` ni `withdrawn`. La propuesta v1 no agrega `moderation_status`, por lo que aún no existe `disqualified`; cuando exista un estado equivalente deberá excluirse explícitamente. El agregado se ejecuta server-side, resolviendo el evento por slug fijo y sin devolver rows, emails, Customer IDs, PASS codes ni UUIDs.

## Future SGX Membership / Subscription Layer

Esta capa queda fuera de Road to VI v1 y no se añade ninguna tabla de suscripciones a la migration propuesta. La separación conceptual es obligatoria:

- SGX PASS = identidad permanente del cliente.
- Road to VI = participación en un programa/evento.
- Subscription = entitlement comercial independiente.

Una cancelación futura nunca debe borrar `customers`, PASS, historial de compras ni `event_entries`. La evolución conceptual es `customer -> sgx_pass -> memberships/subscriptions -> subscription entitlements`.

Si se implementa, los campos futuros mínimos deben contemplar `provider`, `provider_customer_id`, `provider_subscription_id`, `plan`, `status`, `started_at`, `current_period_start`, `current_period_end`, `cancel_at_period_end` y `cancelled_at`. No debe acoplarse a Mercado Pago: el proveedor puede ser Mercado Pago, Stripe u otro sin rediseñar las tablas core de Customer, PASS, compras o participación.

## 10. Moderation y outcome

**No se agregan ahora `moderation_status` ni `outcome_status`.** Road to VI v1 no tiene premios, sorteos ni ganadores. Añadirlos ahora crearía una segunda máquina de estados prematura.

Para v1 se conserva `status`; `ineligible` y `withdrawn` quedan fuera del contador. Una futura competición puede añadir una dimensión de moderation/outcome con migration propia, historial y controles administrativos. No se añade `winner` todavía.

## 11. Estados y algoritmo de fase

Se conservan los estados de DB:

```text
draft | active | closed | archived
```

La UI deriva `draft | upcoming | open | closed | archived` sin una columna `phase` duplicada:

```text
if status = 'draft'    => draft
if status = 'archived' => archived
if status = 'closed'   => closed
if status = 'active':
  start = entry_starts_at ?? starts_at
  end   = entry_ends_at   ?? ends_at
  if start exists and now < start => upcoming
  if end exists and now >= end    => closed
  otherwise                       => open
```

Los intervalos son `[start, end)`, en UTC. `active` con ambas fechas NULL se considera `open`. `closed` siempre gana a las fechas.

La definición exacta de fase usa UTC e intervalos semiabiertos `[start, end)`: `start = entry_starts_at ?? starts_at` y `end = entry_ends_at ?? ends_at`. Si `start` es NULL, el lado inicial es ilimitado; si `end` es NULL, el lado final es ilimitado. Para un evento `active`, `now < start` produce `upcoming`, `now >= end` produce `closed` y cualquier otro caso produce `open`. `draft`, `archived` y `closed` tienen precedencia sobre las fechas.

### Ventana de inscripción

La semántica será:

- ambas columnas `entry_starts_at` y `entry_ends_at` NULL, o ambas definidas;
- `entry_starts_at <= entry_ends_at`;
- si `starts_at` existe, `entry_starts_at >= starts_at`;
- si `ends_at` existe, `entry_ends_at <= ends_at`.

Así la ventana nunca queda fuera del evento general. Si las fechas generales son NULL, la ventana de entries define el periodo operativo. La migration añade un check aditivo y tolerante para no afectar filas legacy sin ventana.

## 12. Early member / early buyer

El timestamp correcto es `orders.approved_at`, no `created_at` ni `jobs.updated_at`:

```text
MIN(approved_at)
WHERE status = 'approved' AND approved_at IS NOT NULL
```

La migration de Orders demuestra que `approved_at timestamptz` existe. `sgx-pass.ts` lo recibe desde el webhook verificado al asociar el pago aprobado. El preflight reportará Orders approved sin `approved_at` como anomalía. No se añade una columna redundante.

## 13. Enrollment transaction

La operación “Unirme” debe ejecutarse server-side, idealmente en una transacción/RPC única:

1. Validar sesión activa, no expirada ni revocada.
2. Cargar Customer por `session.customer_id`.
3. Cargar su único PASS por `customer_id` y exigir `status = 'active'`.
4. Cargar el evento por slug allowlisted o ID derivado server-side.
5. Comprobar `status = active` y ventana `[entry_starts_at, entry_ends_at)`.
6. Cargar `events.rules_version` y la fila publicada correspondiente de `event_rules`.
7. Comprobar al menos un `orders.status = approved` del mismo Customer/PASS y `approved_at` válido.
8. Exigir aceptación explícita de bases; el cliente no elige libremente la versión.
9. Insertar `event_entries` con `status='entered'`, `eligible=true`, `entered_at`, `rules_version` server-side y `rules_accepted_at`.
10. Si el unique produce `23505`, devolver una respuesta idempotente segura de “ya estás inscrito”, sin crear otra fila.

El cliente no puede elegir libremente `event_id`, `customer_id`, `sgx_pass_id` ni `rules_version`. Si el evento se cierra entre evaluación e insert, la transacción debe rechazarlo; los uniques sólo resuelven duplicidad, no sustituyen el check de fechas/status.

## 14. Threat model actualizado

| Amenaza | Nivel | Mitigación |
| --- | --- | --- |
| Exposición de service role/tokens | CRITICAL | Sólo server-side/env; nunca bundle, logs, respuestas o URLs persistentes |
| Usar `public_code` como login | CRITICAL | Prohibirlo; magic link + sesión verificada |
| Session fixation | HIGH | Sesión nueva aleatoria después del magic link; rotar cookie |
| Cookie de sesión robada | HIGH | HTTPS, HttpOnly, Secure, expiry, revoke y revalidación por operación |
| Replay de magic link | HIGH | `used_at`, expiración y update atómico |
| Enumeración de email/PASS | HIGH | Mensajes genéricos, timing similar y rate limit |
| Brute force | HIGH | 32 bytes aleatorios, hash, expiración, rate limit DB |
| Entry duplicada/race | HIGH | Unique `(event_id, customer_id)` y `(event_id, sgx_pass_id)` |
| Customer/PASS cruzados | HIGH | Unique `(id, customer_id)` + FK compuesta |
| Inscripción fuera de fechas | HIGH | Validación server-side dentro de transacción |
| PASS suspended/revoked | HIGH | Revisión del status en cada operación sensible |
| `event_id`/rules manipulados | HIGH | Derivación server-side; FK a `event_rules` |
| Exposición de participantes | HIGH | Agregado único server-side, RLS ON, sin filas públicas |
| Bots de enrollment | MEDIUM | Rate limit por email/IP, backoff y controles adaptativos |
| Links antiguos | MEDIUM | `purpose`, expiry, single-use y redirect sin query |
| Customer eliminado/cambiado | MEDIUM | FK restrict, lookup por ID y rechazo si no existe |
| Admin sin audit log | MEDIUM | Operación manual documentada; audit log antes de dashboard |
| Errores de fase/cache | LOW | UTC, intervalos definidos y cache corto |

## 15. Schema gap analysis

| Requisito | Clasificación | Decisión |
| --- | --- | --- |
| Evento persistente | ALREADY SUPPORTED | Reutilizar `events` |
| Slug único | ALREADY SUPPORTED | Reutilizar `slug` |
| Título | ALREADY SUPPORTED | Usar `name` |
| Descripción | MINOR EXTENSION | `events.description` |
| Estado | ALREADY SUPPORTED | `draft/active/closed/archived` |
| Inicio/fin general | ALREADY SUPPORTED | `starts_at/ends_at` |
| Ventana de entries | MINOR EXTENSION | `entry_starts_at/entry_ends_at` |
| Fase pública | ALREADY SUPPORTED | Derivada, no columna nueva |
| Bases históricas | NEW TABLE/COLUMN REQUIRED | `event_rules` + FK/versiones |
| Aceptación de bases | NEW TABLE/COLUMN REQUIRED | `rules_version` + `rules_accepted_at` |
| Entry real | ALREADY SUPPORTED | Insert explícito `status='entered'` |
| Elegibilidad actual | MINOR EXTENSION | Evaluación server-side; no cache en entry |
| Snapshot de elegibilidad | ALREADY SUPPORTED | `eligible`, sólo histórico |
| Idempotencia por PASS | ALREADY SUPPORTED | Unique existente |
| Idempotencia por Customer | MINOR EXTENSION | Unique nuevo |
| Integridad Customer/PASS | MINOR EXTENSION | Unique compuesto + FK compuesta |
| Ganador | NOT RECOMMENDED now | Añadir en evento competitivo posterior |
| Moderación | NOT RECOMMENDED now | Usar status actual hasta necesidad real |
| Magic link | NEW TABLE/COLUMN REQUIRED | `customer_auth_tokens` |
| Sesión | NEW TABLE/COLUMN REQUIRED | `customer_sessions` |
| Rate limit serverless | NEW TABLE/COLUMN REQUIRED | `customer_auth_rate_limits` |
| Compra approved | ALREADY SUPPORTED | `orders.status` + `approved_at` |
| Early buyer | ALREADY SUPPORTED | Derivar desde `approved_at` |
| Conteo público | ALREADY SUPPORTED | Agregado server-side |
| Admin manual | ALREADY SUPPORTED | Supabase Table Editor/SQL con control |
| Dashboard admin | NOT RECOMMENDED now | Requiere roles/audit/CSRF |
| SGX Points | NOT RECOMMENDED now | Sistema separado |

## 16. Migration final propuesta

Archivos separados, propuestos y no ejecutados:

- Migration A: `supabase/migrations/20260904010000_customer_auth_core_v1.sql`
  posee tokens, sesiones y rate limits reutilizables.
- Migration B: `supabase/migrations/20260904020000_road_to_vi_event_system_v1.sql`
  posee sólo extensiones de eventos, reglas, entries e integridad
  Customer/PASS.
- Migration C: `supabase/migrations/20260904030000_purchase_milestones_v1.sql`
  posee sólo Purchase Milestones y no forma parte del dominio Road.

El antiguo `20260904000000_road_to_vi_event_system_v1.sql` fue reemplazado
localmente y no debe aplicarse.

Incluye sólo:

- campos de descripción, ventana, reglas y timestamps en `events`;
- check aditivo de ventana;
- tabla `event_rules` y sus referencias versionadas;
- `rules_version`/`rules_accepted_at` en entries;
- unique `(event_id, customer_id)`;
- unique `(id, customer_id)` en `sgx_passes` y FK compuesta;
- No incluye tablas de Customer Auth ni de Purchase Milestones; esas
  responsabilidades pertenecen a A y C.
- índices y RLS.

No cambia el default legacy `status='eligible'`, no agrega `moderation_status`, no agrega `outcome_status`, no agrega winner, no inserta evento/entries, no hace backfill, no contiene `DROP`, `DELETE` ni `TRUNCATE` como operaciones DML. Las FKs usan el comportamiento por defecto sin cascada y sólo protegen referencias.

## 17. Preflight final

Archivo: `supabase/preflight_road_to_vi_v1.sql`.

Comprueba sin escribir:

- presencia/ausencia de `events`, `event_entries`, `customers`, `sgx_passes`, `orders`, `jobs`, `legal_acceptances` y `event_rules`;
- columnas, PK, UNIQUE, FK, checks, índices;
- RLS y policies reales del catálogo;
- existencia del unique compuesto requerido en `sgx_passes`;
- duplicados `(event_id, customer_id)` y `(event_id, sgx_pass_id)`;
- Customer/PASS cruzados y huérfanos;
- counts por status de events y entries;
- pointers de `rules_version`, rows de `event_rules` y publicaciones faltantes;
- Orders approved sin Customer, PASS, Job o `approved_at`;
- estado Road de soporte, reglas y publicaciones faltantes. Auth se revisa en
  `supabase/preflight_customer_auth_core_v1.sql`.

Usa sólo `SELECT` y consultas dinámicas de lectura; su salida consolidada
usa las columnas `section`, `check_name`, `value`, `status`, `detail` para
ser visible en Results. Si falta una tabla o columna, devuelve `SKIP` con
`table_or_column_missing`. No fue ejecutado.

## 18. Plan posterior

1. Preflight real y revisión manual de resultados.
2. Aprobación/aplicación de migration aditiva.
3. Tests de constraints, FK compuesta, doble idempotencia y `rules_version`.
4. Magic link, rate limit DB, sesión y logout.
5. Evaluación server-side y enrollment transaccional.
6. Página pública `/road-to-vi` con contador agregado.
7. Bases `/legal/road-to-vi` y versionado histórico.
8. Operación manual y observabilidad.
9. Validación de producción en ventana aprobada.

## 19. Artefactos separados y salida visible

- Auth: `preflight_customer_auth_core_v1.sql` y
  `postflight_customer_auth_core_v1.sql`.
- Road: `preflight_road_to_vi_v1.sql` y
  `postflight_road_to_vi_v1.sql`.
- Purchase Milestones: `preflight_purchase_milestones_v1.sql` y
  `postflight_purchase_milestones_v1.sql`.
- Backfill separado, administrativo y no ejecutado:
  `supabase/backfill_purchase_numbers_v1.sql`.

Las comprobaciones que antes dependían de `RAISE NOTICE` están representadas
como filas del SELECT final del preflight Road. No se requiere una pestaña
Messages para leerlas.

## Estado de esta pasada

- GO arquitectónico: sí, para preflight/revisión.
- Implementación productiva: no.
- SQL contra Supabase: no ejecutado.
- Preflights reales de producción: aprobados antes de esta pasada; los nuevos
  archivos locales: no ejecutados.
- Migration A/B/C: no ejecutadas.
- Backfill: no ejecutado.
- Evento creado: no.
- Entries creadas: no.
- Emails enviados: no.
- Push: no realizado.
- Deploy: no realizado.
- Producción y worktrees existentes: intactos.
