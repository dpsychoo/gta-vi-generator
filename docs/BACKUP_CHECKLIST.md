# Production Backup Checklist

Checklist para preservar la baseline productiva y recuperar el servicio sin almacenar secretos en el repositorio.

## A. BACKUP EN GIT

- [ ] Código fuente de la baseline estable.
- [ ] Migraciones SQL versionadas.
- [ ] Configuración no secreta (`vercel.json`, `.env.example` y documentación).
- [ ] Tag local `prod-2026-09-04-stable` apuntando al commit estable.
- [ ] Rama documental `docs/production-baseline-2026-09-04` preservada cuando corresponda.
- [ ] Confirmar SHA del commit estable antes de archivar.

## B. BACKUP FUERA DE GIT

Guardar en un gestor seguro, con acceso restringido y rotación documentada:

- [ ] Valores de Vercel Environment Variables.
- [ ] Credenciales/API de Supabase, incluida service role.
- [ ] `OPENAI_API_KEY`.
- [ ] Credenciales de Mercado Pago.
- [ ] Credenciales de Resend.
- [ ] `CRON_SECRET`.
- [ ] `JOB_ACCESS_TOKEN_ENCRYPTION_KEY`.
- [ ] Cualquier otro secreto detectado durante una auditoría.

## C. DNS

- [ ] Exportar la zona DNS de Cloudflare.
- [ ] Respaldar las reglas de Email Routing.
- [ ] Registrar el dominio productivo y los destinos públicos sin incluir credenciales.
- [ ] Verificar que el backup sea recuperable y esté fuera del repositorio.

## D. PROVEEDORES

Verificar acceso administrativo y un método de recuperación para:

- [ ] Vercel.
- [ ] Supabase.
- [ ] Mercado Pago.
- [ ] OpenAI.
- [ ] Resend.
- [ ] Cloudflare.
- [ ] GitHub.

## Regla de seguridad

**NO guardar secretos en:**

- GitHub;
- README;
- docs del repositorio;
- screenshots públicos;
- texto plano dentro del proyecto.

No incluir en backups compartidos emails de clientes, payment IDs, access tokens, API keys, fotografías ni otros datos personales.

