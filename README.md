# 🎮 GTA VI Landing Page Clone

Una réplica de la landing page oficial de Grand Theft Auto VI (GTA VI) desarrollada con Astro y React.

## 🔧 Flujo funcional del generador

Este proyecto incluye el flujo real de negocio del generador:

1. subir 1 o 2 imágenes del cliente
2. crear job con validación de email e imágenes
3. redirigir a Mercado Pago
4. confirmar aprobación por webhook
5. generar imagen usando:
   - prompt maestro fijo backend
   - imagen maestra privada de referencia
   - imágenes del cliente
6. guardar la salida
7. mostrar la imagen en la vista de resultado

La UI de la landing no fue alterada en diseño. Los cambios aplicados están en backend y flujo funcional.

## 📁 Archivos de negocio clave

- `src/lib/job-store.ts` — persistencia local de jobs y archivos
- `src/lib/mercadopago.ts` — creación y verificación de pagos
- `src/lib/openai.ts` — generación de imagen con prompt + imagen maestra + fotos del cliente
- `src/pages/api/create-job.ts` — creación del job y redirección al pago
- `src/pages/api/mercadopago-webhook.ts` — webhook de aprobación
- `src/pages/api/generate-image.ts` — trigger de generación solo con pago aprobado
- `src/pages/api/job-status.ts` — consulta de estado del job
- `src/pages/api/image.ts` — entrega de la imagen generada
- `src/pages/resultado.astro` — polling del job y visualización del resultado

## 🔐 Variables de entorno

Copia `.env.example` a `.env` y completa los valores reales:

```env
OPENAI_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_STYLE_PROMPT="..."
MASTER_STYLE_REFERENCE_PATH=/ruta/privada/imagen-maestra.jpg
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_WEBHOOK_SECRET=
RESEND_API_KEY=
RESEND_FROM_EMAIL=no-reply@tu-dominio.com
APP_BASE_URL=http://localhost:4321
JOB_CURRENCY=CLP
JOB_PRICE=2990
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_UPLOADS_BUCKET=customer-uploads
SUPABASE_GENERATED_BUCKET=generated-images
SUPABASE_PRIVATE_BUCKET=system-private
```

## 🖼️ Imagen maestra de referencia

La imagen maestra real no va en `/public` ni en assets públicos. Debe quedar en un path privado del servidor o en un bucket privado de Supabase.

Ejemplo de configuración:

```env
MASTER_STYLE_REFERENCE_PATH=/home/usuario/.private/master-style-reference.jpg
```

Si usas Supabase Storage, guarda esa imagen en un bucket privado y apunta `MASTER_STYLE_REFERENCE_PATH` al archivo local descargado para que el backend la consuma.

## 🧠 Prompt maestro

El prompt maestro queda del lado backend y no se expone al frontend. Se define con `OPENAI_STYLE_PROMPT`.

## 💳 Mercado Pago

- `MERCADOPAGO_ACCESS_TOKEN` habilita la integración real.
- `MERCADOPAGO_WEBHOOK_SECRET` valida la autenticidad del webhook.
- `JOB_CURRENCY=CLP` y `JOB_PRICE=2990` son obligatorios.
- Sin credenciales reales, el pago falla cerrado: no existe autoaprobación mock.
- `/api/generate-image` queda reservado para disparos manuales en desarrollo.
- Resend no forma parte del flujo actual.

## ✅ Flujo confirmado

Usuario sube imágenes
→ crea job
→ paga en Mercado Pago
→ webhook confirma approved
→ backend genera con prompt maestro + imagen maestra + imágenes del cliente
→ guarda resultado
→ muestra resultado en la página interna

## 🚀 Comandos

```bash
npm install
npm run dev
npm run build
```

## 📌 Nota

La imagen `vi.webp` sigue siendo solo el badge visual de estilo; la imagen maestra de referencia es otro archivo distinto y privado, no visible ni público.
