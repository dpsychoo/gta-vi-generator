# SGODX Customer Auth Core v1

## Decisión

Customer Auth Core es una capa reutilizable e independiente de Road to VI y
Purchase Milestones. El diseño queda en revisión local: no se ha aplicado
Migration A ni se ha creado ningún token, sesión, secreto o dato de negocio.

La propuesta es **GO para diseño y preflight** y **NO-GO para aplicación en
producción** hasta aprobar la migration y el rollout correspondiente.

## Migration A

Archivo: `supabase/migrations/20260904010000_customer_auth_core_v1.sql`.

Sólo es propietaria de:

- `customer_auth_tokens`: `token_hash`, `purpose`, expiración, uso único y
  referencia al Customer.
- `customer_sessions`: hash de sesión opaca, expiración, revocación y última
  actividad.
- `customer_auth_rate_limits`: scope `email`/`ip`, HMAC `key_hash`, ventana,
  contador y bloqueo temporal.

El propósito por defecto es `customer_login`, con formato general para poder
añadir otros propósitos de Customer Auth sin acoplarlos a un evento. La
aplicación debe mantener un allowlist explícito de propósitos aceptados.

No se almacenan secretos, tokens en claro, emails/IP en claro ni capabilities
de Job. El backend genera valores aleatorios, guarda sólo hashes y entrega el
token una sola vez. Las sesiones se transportan en cookie `HttpOnly`, `Secure`
y con política `SameSite` revisada por el backend.

## Límites de seguridad

- RLS queda habilitado en las tres tablas.
- El acceso de lectura/escritura debe ser backend-only mediante privilegios
  explícitos; no se propone una policy pública.
- El rate limit usa HMAC server-side con una clave dedicada. El valor de esa
  clave no pertenece al repositorio.
- Expiración y uso se validan en la misma operación de consumo; el consumo es
  de un solo uso e idempotencia debe resolverse en el endpoint.
- Auth no concede acceso a PASS, Order, evento, premio ni Job por sí solo.

## Preflight y postflight

Antes de aplicar A: `supabase/preflight_customer_auth_core_v1.sql`.

Después de aplicar A: `supabase/postflight_customer_auth_core_v1.sql`.

Ambos devuelven una sola tabla final con:

```text
section | check_name | value | status | detail
```

Las comprobaciones dinámicas de tokens expirados, sesiones expiradas y
estado de rate limit no exponen hashes ni valores sensibles. Si falta una
tabla o columna, la fila correspondiente devuelve `SKIP` y
`table_or_column_missing`.

## Fuera de alcance

No se modifica el webhook de Mercado Pago, la UI, los endpoints actuales, el
modelo de Job, Road to VI, Purchase Milestones ni ninguna sesión existente.
La limpieza de ventanas expiradas y la política de recuperación de cuenta
requieren una decisión posterior y no se añaden como cron ni como migration.
