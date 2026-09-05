# SGODX Production Rollout v1

Estado comunicado por el operador: Migrations A/B/C aplicadas manualmente
mediante Supabase Production SQL Editor; sus tres postflights dieron PASS.
Customer Auth Core, Road to VI y Purchase Milestones están aprobados. Es
evidencia aportada por el usuario, no una consulta remota de esta fase.

El contador tiene `id=1`, `last_purchase_number=0`, `assignment_state=paused`.
Hay 3 Orders approved, 0 numeradas y 3 sin número; milestones reales=0,
awards reales=0. No se ejecutó backfill. La población puede crecer antes de la
ventana: #1–#3 sólo es exacto si siguen siendo tres al corte.

Esta fase implementa y prueba archivos locales: Migration D, helper/webhook,
backfill revisado y postflight/monitoreo D. El siguiente procedimiento requiere
una ventana autorizada; no se aplica, despliega ni abre live ahora.

**NO-GO para activar live ahora.** Además de aplicar D y completar el corte,
hay que validar fairness real en PostgreSQL con dos sesiones. El contrato
recomendado es orden de admisión de aprobaciones en el registro de SGODX,
no hora de aprobación del proveedor ni primera RPC exitosa. El análisis de
fuentes, alternativas y la necesidad de una posición interna está en
`PURCHASE_MILESTONES_V1_AUDIT.md`, sección 22.

## Migration history: antes de cualquier db push

A/B/C se aplicaron por SQL Editor; eso no acredita que estén registradas en
`supabase_migrations.schema_migrations`. Antes de utilizar `supabase db push`,
verificar/reconciliar el historial con los objetos instalados y estas versiones:

- A: `20260904010000_customer_auth_core_v1.sql`.
- B: `20260904020000_road_to_vi_event_system_v1.sql`.
- C: `20260904030000_purchase_milestones_v1.sql`.

No volver a aplicar A/B/C a ciegas. No se ejecuta CLI remoto, migration repair
ni reconciliación en esta fase. Si D se aplica manualmente, también deberá
reconciliarse antes de usar el CLI en el futuro. La migration antigua combinada
`20260904000000_road_to_vi_event_system_v1.sql` no se aplica.

## Secuencia futura anti-race

1. Revisar y aprobar `20260904040000_purchase_number_assignment_v1.sql`.
   Antes de la ventana de producción, validar D en PostgreSQL autorizado:
   trigger, CACHE 1, permisos, A pendiente/B posterior, writer sin commit,
   timeout, rollback de award y backfill concurrente. Aplicar D con owner
   postgres: añade posición de cola, secuencia privada, guard e índices y
   define la RPC; reserva internamente la zona de tickets del corte, pero no
   numera históricos, invoca assignment ni cambia counter.
2. Ejecutar `postflight_purchase_number_assignment_v1.sql`. Exigir PASS en
   firma/owner/security/ACL/trigger/secuencia/índices/integridad, contador
   paused, último=0 y cero
   milestones/awards reales. `approved_without_purchase_number` puede ser
   INFO antes del backfill; se espera 3 según la evidencia inicial.
3. Desplegar la app compatible con D mientras el contador sigue paused.
   Verificar que las instancias activas usan el helper nuevo. El webhook
   persiste identidad y Order, conserva el flujo legal y llama la RPC antes
   del claim de generación, incluso en notificaciones repetidas.
4. Verificar pagos/generación existentes y logs: `deferred/counter_paused`
   permite completar el producto y deja la Order durable sin número.
   Confirmar que no hay errores de firma, ACL ni identidad. No activar premios.
5. En una ventana administrativa breve, ejecutar una sola vez el backfill
   revisado. Inicia READ COMMITTED, toma `purchase_counter(id=1) FOR UPDATE`
   primero y exige paused, último=0. Después toma
   `LOCK TABLE public.orders IN SHARE ROW EXCLUSIVE MODE`.
6. Al concederse la barrera de Orders, los escritores anteriores ya terminaron;
   el siguiente statement ve TODAS las approved existentes en ese corte.
   Se impiden nuevos inserts/cambios de estado hasta commit. Abortar si falta
   approved_at, ya existe algún número, el contador no está inicial, falta
   el guard de admisión o hay una posición pendiente que ya no está approved.
7. Asignar las posiciones históricas `1..N` por `approved_at ASC, id ASC`.
   Después asignar #1…#N por `purchase_queue_position ASC`. Validar cobertura,
   unicidad, continuidad y ausencia de números en estados no aprobados EN ESTE
   backfill inicial. No crear awards históricos ni reiniciar la secuencia
   interna: D ya reservó los tickets posteriores al prefijo.
8. En la MISMA transacción y antes de liberar ambas barreras, sincronizar
   `last_purchase_number = MAX(orders.purchase_number)` y pasar a live. La
   secuencia interna no se resetea: sus huecos son admisión interna y no
   números comerciales.
   COMMIT publica número/contador/state juntos. La fila Results del script
   sólo acredita éxito si también terminó el COMMIT. Ante error o timeout,
   hacer rollback de la transacción fallida antes de otra operación; no
   continuar manualmente con statements parciales.
9. Ejecutar postflight D tras finalizar las peticiones en vuelo: exigir
   `approved_without_purchase_number=0`, contador=MAX, continuidad y cero
   blockers. Repetir la observación si una compra acaba de persistirse:
   entre el commit de la Order y su RPC existe un intervalo breve sin número.
10. Verificar que la primera admisión pending tras el corte recibe N+1 y que
     un target posterior devuelve prior_pending mientras la cabecera no tenga
     número. Tras reparar cabecera, reintentar el siguiente. Una notificación
     repetida de una Order numerada debe devolver existing, sin otro award.

## Procedimiento manual futuro en SQL Editor

1. Ejecutar primero el preflight D read-only y detenerse si `blockers` no es
   `PASS`. Confirmar además que cada objeto propuesto aparece como
   `EXPECTED_ABSENT` y que el estado observado sigue siendo `paused`,
   counter=0, approved sin número y milestones/awards=0.
2. Abrir una única sesión autorizada como owner `postgres`, pegar el archivo
   completo `20260904040000_purchase_number_assignment_v1.sql` y ejecutarlo
   una sola vez. El archivo contiene explícitamente `BEGIN` y `COMMIT`; no
   dividirlo en statements separados ni ejecutar partes manualmente.
3. Ante cualquier error, no continuar con otra sentencia: verificar que la
   transacción fallida se revirtió y repetir el diagnóstico read-only. No
   ejecutar backfill ni cambiar a `live` desde el editor en ese estado.
4. Tras el commit exitoso, ejecutar el postflight D. Debe mostrar la columna,
   secuencia, trigger, ACL/RPC e índices; counter=0/paused y los approved sin
   número pueden seguir siendo INFO (3 es el valor esperado del corte).
5. Sólo después de revisar ese postflight y una ventana administrativa
   separada se ejecuta el backfill completo, también sin dividir su transacción.
   El backfill asigna primero la cola histórica y sólo al final publica
   counter=MAX/live con su propio `COMMIT`.

El backfill tiene lock_timeout=5s y statement_timeout=30s por statement.
Está pensado para una población pequeña: revisar duración/carga si crece.
Son límites por statement, no un SLA total. No dejar la transacción abierta
ni aumentar los límites sin revisar el impacto en las escrituras de Orders.

## Una compra durante el backfill

| Momento de la Order | Qué sucede |
| --- | --- |
| Persistida antes de concederse la barrera de Orders | El backfill la incluye en #1…#N, aunque su RPC haya devuelto deferred antes. |
| Persistida y su RPC espera el counter | Sólo si no agota timeout llega a releerla y devolver existing si el backfill la numeró. Si expira, se reintenta después. |
| Insert/aprobación empieza después de la barrera | Espera el lock de tabla; cuando persiste obtiene posición de admisión. Su RPC sólo puede asignar si es cabecera; puede expirar o devolver prior_pending. |
| RPC agota espera o pierde respuesta | El helper registra error y permite generación. Si hubo commit, retry devuelve existing; si no, la Order conserva prioridad y bloquea el adelantamiento de targets posteriores. |

Backfill es un estado intermedio no confirmado: una RPC que alcance el mutex
después de commit ve live; una que agote su espera falla antes. No se promete
espera ilimitada. También devuelve deferred si el operador hubiera dejado
un estado backfill confirmado por otro procedimiento.

Una escritura de identidad bloqueada puede agotar el timeout de su petición
antes de llegar a numbering. Se conserva el flujo de error/reentrega existente:
confirmar con el provider y reintentar controladamente la misma notificación.
El backfill no garantiza entrega inmediata mientras detiene escrituras; la
ventana debe ser breve. Un error de numbering no aborta la generación.

No hay catch-up desprotegido que pierda inserts al final: la población no
cambia bajo el lock de tabla. Las Orders posteriores usan la cola live.
N+1 corresponde a la primera admisión registrada pending tras el corte,
aunque necesite reparación; un segundo comprador no la adelanta porque su
llamada RPC tenga éxito antes. No equivale a primera aprobación en Mercado
Pago, primer webhook recibido ni primer commit: la admisión se serializa
en DB dentro de la escritura y sólo cuentan las escrituras confirmadas.

La app persiste identidad en transacciones HTTP separadas antes de la RPC.
Todo camino futuro que use ambas barreras debe adquirir **counter → Orders**;
nunca llamar a la RPC desde una transacción que ya bloquee Orders. La RPC live
también usa la barrera de tabla y READ COMMITTED para no ignorar admisiones
anteriores aún sin commit. Su lectura idempotente inicial no toma lock de fila.
El trigger de admisión nunca toma el counter; usa una secuencia interna
CACHE 1 y no hace depender la creación de Order del avance de numbering.
Migration D inicializa esa secuencia por encima de la población approved que
existía al instalarse; el backfill ocupa el prefijo histórico `1..N` y asigna
los números comerciales siguiendo esas posiciones. No se ejecuta `setval` ni
se reinicia la secuencia durante el backfill.
La compatibilidad y el orden común
siguen las reglas de
[locks de PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Timeout: resultado desconocido y reparación ordenada

Se conservan 2s por espera de lock DB y 3s de timeout de transporte para
numbering complementario. No son una garantía de duración total DB: hay varios
locks, y cancelar HTTP no prueba si hubo commit. Un timeout SQL que llega a
abortar la función revierte número/award/contador; una respuesta perdida tras
commit se recupera con existing. En ambos casos la prioridad persistida queda.

La conducta elegida es **espera acotada → error registrado → cola de reparación**,
no «esperar el backfill y obtener N+1» garantizado. Paused/backfill devuelven
deferred cuando la RPC puede leer esos estados. Prior_pending es deferred por
orden, sin incrementar. Errores de numeración y cualquiera de esos deferred
permiten continuar el claim/generación existente.

Una cabecera con error de integridad/award bloquea progresión aunque B sea
válida. No aplicar SKIP LOCKED, elevar timeouts automáticamente, liberar
premios a otro número ni drenar compras ajenas desde el webhook de B. La
barrera live también puede añadir espera a escrituras de Orders; se acepta
ese coste para v1 de bajo volumen y se debe medir antes de activar. No hay
promesa de cero latencia o ausencia de fallos de persistencia DB.

## Monitoreo y reparación

Reutilizar `supabase/postflight_purchase_number_assignment_v1.sql`; no hay
servicio externo, cron, endpoint nuevo ni reparaciones automáticas.

- `approved_without_purchase_number`: FAIL/alerta cuando live y count>0;
  INFO mientras paused/backfill; PASS cuando cero. Investigar si persiste
  tras finalizar las peticiones en curso.
- `numbering_health`: HEALTHY sin pendientes; DEGRADED con pendientes,
  incluyendo una cabecera registrada que dejó de estar approved. DEGRADED
  en live es alerta; no cambia Jobs ni bloquea generación por lógica de negocio.
- `purchase_queue_head`: ID interno, posición y status de la cabecera para
  reparación. `approved_missing_queue_position`, `queue_overtaking_detected`,
  `queue_head_lifecycle_blockers`, `queue_position_integrity` detectan errores
  que no se deben resolver saltando una compra o inventando un orden.
- `counter_vs_max_purchase_number`: PASS sólo con contador=MAX (o cero sin
  números), contando TODOS los estados; cualquier divergencia es FAIL.
- `purchase_number_duplicates` y `purchase_number_continuity`: cero
  duplicados y rango permanente #1…#MAX, incluyendo refunds/chargebacks.
- `award_snapshot_integrity`, `award_milestone_duplicates`,
  `milestone_award_state_integrity`, `active_milestone_published_rules`:
  integridad futura; no invocan la RPC.
- `blockers`: cuenta FAIL y SKIP. No aprobar con prerrequisitos ausentes.
  Salida completa: section/check_name/value/status/detail.

Reparación futura autorizada, sin script nuevo ni DML manual:

1. Ejecutar el postflight read-only. Confirmar live, counter=MAX y revisar
   primero alertas de integridad, posición faltante y lifecycle.
2. Tomar únicamente el Order ID de purchase_queue_head. Corregir la causa
   operativa y llamar `assign_purchase_number_v1(p_order_id)` desde backend
   autorizado con ese ID, nunca con un purchase_number elegido manualmente.
3. Si devuelve assigned/existing, volver a leer el postflight para obtener la
   nueva cabecera; repetir hasta HEALTHY. Si otro backend se adelantó con la
   misma cabecera, existing hace el paso idempotente.
4. Ante prior_pending, releer cabecera. Ante timeout, releer estado/reintentar
   la misma Order; ante integridad, queue_position_missing, queue_order_violation
   o cabecera no approved, detener reparación automática y revisar evidencia.
   Nunca borrar/renumerar, reubicar la cola o modificar su secuencia para avanzar.

No se crea un drain automático ni un servicio: la RPC target más el postflight
ya proporcionan el mecanismo mínimo. No reconstruir Customer/PASS/Order ni
reiniciar generación para reparar un número. No repetir el backfill tras live.
Un HTTP 200 del webhook evita perder el producto, pero **no garantiza otra
reentrega del provider**: monitoreo y reparación administrativa son necesarios
si el fallo no se recupera con un duplicado natural.

## Cash rewards y reversas

**BLOCKER BEFORE CASH REWARDS.** El mapper transforma refunded y charged_back
en cancelled; recordUnapprovedPayment sólo actualiza Jobs pending_payment
con payment no approved. Para un job processing/completed, no modifica el
job. Esa rama no actualiza Orders, PASS ni awards, no conserva el evento
autoritativo de reversa y responde 200 sin numerar ni generar. Una Order
puede seguir approved después de una reversa real. Se reaudita y prueba con
dobles offline; no se corrige en esta fase.

No activar premios en dinero hasta implementar evidencia durable del provider,
transiciones auditables de Order, reconciliación y política hold/void antes de
claim/payout. C no impone inmutabilidad de reglas publicadas ni de snapshots
por triggers: los administradores deben respetarla y cualquier editor futuro
requiere controles propios. D no añade payout, notificación ni estado paid.
Purchase_number nunca se borra, reasigna ni desplaza al siguiente comprador.
Una reversa de una Order ya numerada conserva número y posición; si una
Order registrada pero aún sin número deja de estar approved, queda bloqueada
para revisión de lifecycle. No existe todavía una política que autorice
saltarla. Fairness de infraestructura puede avanzar independientemente de
ese desarrollo; cash rewards no se habilitan por aprobar sólo numbering.

## Límites de esta validación

Los tests ejecutan el código real de webhook, verificación/mapper, identidad,
asociación legal, claim y helper con servicios simulados en memoria.
SQL D/backfill/postflight sólo se revisa estáticamente. Antes de producción,
queda validar en PostgreSQL autorizado compilación, ACL efectiva, rollback de
award, snapshots y concurrencia real en dos sesiones, especialmente un INSERT
anterior abierto al numerar B y la barrera live con tráfico de escrituras.
Los tests offline no
demuestran ejecución SQL, RLS ni ausencia universal de deadlocks frente a
escritores administrativos que incumplan el orden.
