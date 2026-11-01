# Conectar Quincena a Supabase y Vercel (paso a paso)

Tiempo estimado: 15–20 minutos. Todo es gratis (plan Free de Supabase y plan Hobby de Vercel).

Al terminar:

- Los clientes crean su cuenta en la app con **nombre completo, cédula, contraseña, foto de la cédula y foto del rostro**.
- Sus **solicitudes de préstamo** se guardan en Supabase y aparecen en tu panel `/admin.html`.
- En el panel **apruebas la línea de crédito**, **confirmas cada préstamo** (con la referencia del pago móvil) y **validas los pagos**.

---

## Parte 1 · Supabase

### Paso 1. Crear el proyecto
1. Entra en <https://supabase.com> y crea una cuenta (puedes usar GitHub).
2. **New project** → elige un nombre (por ejemplo `quincena`), escribe una **contraseña de base de datos** (guárdala) y una región cercana a tus clientes (por ejemplo *East US* o *São Paulo*).
3. Espera 1–2 minutos a que el proyecto termine de crearse.

### Paso 2. Crear las tablas y las reglas de seguridad
1. Menú izquierdo → **SQL Editor** → **New query**.
2. Abre el archivo [`supabase/schema.sql`](schema.sql) de este repositorio, copia **todo** su contenido y pégalo.
3. Pulsa **Run**. Debe decir *Success. No rows returned*.

Esto crea las tablas, el almacenamiento privado `documentos` para las fotos y las reglas que impiden que un cliente vea a otro o se apruebe a sí mismo.

### Paso 3. Permitir que los clientes entren con cédula y contraseña
La app usa la cédula como usuario (por dentro la convierte en un correo interno como `v12345678@clientes.quincena.app`; no se envía ningún correo). Por eso hay que **desactivar la confirmación por correo**:

1. Menú izquierdo → **Authentication** → **Sign In / Providers** (en algunas versiones: *Providers → Email*).
2. Comprueba que **Allow new users to sign up** está **activado**.
3. En **Email**, **desactiva “Confirm email”** y pulsa **Save**.

> Si no lo desactivas, al crear la cuenta el cliente verá: *“La cuenta quedó esperando confirmación por correo”*.

### Paso 4. Crear tu usuario de administrador
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Escribe tu correo y una contraseña segura, **marca “Auto Confirm User”** y pulsa **Create user**.
3. Vuelve a **SQL Editor** → **New query**, pega esto **cambiando tu correo y tu nombre** y pulsa **Run**:

```sql
insert into public.staff (user_id, email, name, role)
select id, lower(email), 'Tu Nombre', 'admin' from auth.users
where lower(email) = lower('tu-correo@ejemplo.com')
on conflict (user_id) do update set role = 'admin', active = true;
```

El editor responderá *Success. No rows returned*: **es normal**, un `insert` no devuelve filas. Para comprobar que quedó dado de alta, ejecuta en otra consulta:

```sql
select email, name, role, active from public.staff;
```

Debe aparecer tu correo con `role = admin`. Si la tabla sale vacía, el correo no existe en **Authentication → Users** (revisa el paso anterior con `select email, email_confirmed_at from auth.users;`) y repite el `insert`.

### Paso 5. Copiar las dos claves públicas
**Project Settings** (engranaje) → **API Keys** (en versiones antiguas: *Project Settings → API*). Copia:

| Dato | Dónde está | Ejemplo |
|---|---|---|
| **Project URL** | *Project Settings → Data API* (o arriba en *API*) | `https://abcdefghijkl.supabase.co` |
| **Clave pública** | la **Publishable key** (`sb_publishable_…`) o, en la pestaña *Legacy API keys*, la **anon public** (`eyJ…`) | cualquiera de las dos sirve |

> ⚠️ **Nunca** uses la clave **secret** / **service_role**. Esa da acceso total y no debe estar en la web.

---

## Parte 2 · Vercel

### Paso 6. Variables de entorno
1. Entra en <https://vercel.com> → tu proyecto de Quincena → **Settings** → **Environment Variables**.
2. Añade (marca los entornos *Production*, *Preview* y *Development*):

| Name | Value |
|---|---|
| `SUPABASE_URL` | tu Project URL |
| `SUPABASE_ANON_KEY` | tu clave pública (publishable o anon) |

3. Pulsa **Save**.

### Paso 7. Revisar la configuración del proyecto
**Settings → Build and Deployment** (o *General*):

- **Framework Preset:** `Other`
- **Root Directory:** vacío (la raíz del repositorio). *No* pongas `public`: la función `api/config.js` debe quedar incluida.
- **Build Command / Output Directory:** déjalos por defecto; el archivo `vercel.json` ya indica que la web está en `public/`.

### Paso 8. Volver a desplegar
- Une (*merge*) esta rama a tu rama principal en GitHub y Vercel desplegará solo, **o**
- **Deployments** → los tres puntos del último despliegue → **Redeploy**.

Las variables de entorno solo se aplican en despliegues nuevos.

### Paso 9. Comprobar
1. Abre `https://TU-DOMINIO.vercel.app/api/config`. Debe mostrar algo como
   `window.QUINCENA_CONFIG={"url":"https://….supabase.co","anonKey":"…"};`
   Si sale `window.QUINCENA_CONFIG={};`, faltan las variables o no has vuelto a desplegar.
2. Abre `https://TU-DOMINIO.vercel.app/admin.html` y entra con el correo y la contraseña del **paso 4**.
3. En el móvil, abre `https://TU-DOMINIO.vercel.app/`, pulsa **Crear cuenta**, completa los datos y las dos fotos.
4. En el panel pulsa **Actualizar**: el cliente aparece con la línea **Pendiente**.

> Alternativa sin variables de entorno: edita `public/config.js` en GitHub y pon la URL y la clave pública en `manual`.

---



## Actualizar a la versión 3 (seguridad: código por correo, contraseñas fuertes y límites)

1. **Une el pull request** en GitHub. Vercel publica el panel nuevo.
2. **Dirección de la web (obligatorio para el enlace del correo).** En Supabase ve a **Authentication → URL Configuration**
   (*Configuración de URL*): en **Site URL** escribe `https://quicena-web.vercel.app` y en **Redirect URLs** añade
   `https://quicena-web.vercel.app/**`. Guarda. Así el botón «Sign in» del correo abre tu panel ya verificado.
   *(Sin SMTP propio Supabase no deja editar la plantilla: el correo llega en inglés con el botón «Sign in»; funciona igual.)*
3. **Opcional, plantilla con código** (solo si configuras SMTP propio). En Supabase ve a **Authentication → Emails → Templates → Magic Link**
   (en algunas versiones: *Email Templates*). Cambia el asunto a `Tu código de Quincena` y el contenido por:

   ```html
   <h2>Tu código para entrar a Quincena</h2>
   <p>Escribe este código en el panel:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Si no fuiste tú, cambia tu contraseña de inmediato.</p>
   ```

   Pulsa **Save**.
4. **Ejecuta otra vez `supabase/schema.sql`** completo en **SQL Editor → Run**. No borra datos.
5. **Contraseñas** (recomendado): **Authentication → Sign In / Providers → Email**:
   *Minimum password length* = **8** y *Password requirements* = **letras y números** (*Letters and digits*). **Save**.
6. Entra al panel: tras la contraseña te llegará un correo; pulsa **«Sign in»** (o escribe el código si lo trae).

**Importante sobre el correo:** el servidor de correo que trae Supabase gratis envía **pocos correos por hora** y solo a
direcciones que sean miembros del equipo del proyecto (la cuenta con la que creaste Supabase lo es). Si tu correo de
administrador es otro, o quieres que los cobradores también reciban código, configura un servidor propio en
**Project Settings → Authentication → SMTP Settings** (por ejemplo Gmail con «contraseña de aplicación»).

**Si te quedas sin acceso** porque no llega el código, en **SQL Editor** ejecuta:

```sql
update public.app_settings set data = jsonb_set(data, '{staff2fa}', 'false') where id = 1;
```

Entra, revisa el correo/SMTP y vuelve a activarlo cambiando `'false'` por `'true'`.

Lo que añade esta versión:

| Protección | Dónde |
|---|---|
| Código por correo al entrar al panel (administrador; cobradores opcional en **Ajustes**) | Base de datos: solo la sesión que pasó contraseña **y** código ve expedientes |
| Contraseñas de 8+ caracteres con letras y números, con indicador de seguridad | App del cliente, panel y base de datos |
| Una sola solicitud de préstamo pendiente por cliente | Base de datos |
| Máximo 20 fotos subidas por cliente cada 24 h | Almacenamiento |

## Actualizar a la versión 2 del panel (ajustes del negocio, bloqueo, notas…)

Si ya tenías Quincena funcionando, solo hay que hacer **una cosa** en Supabase:

1. **SQL Editor → New query**, pega otra vez **todo** el archivo [`supabase/schema.sql`](schema.sql) (versión 2) y pulsa **Run**.
   Es seguro: no borra clientes ni préstamos, solo añade lo nuevo.
2. Entra al panel → **Ajustes** y revisa las comisiones (vienen en 30 % / 35 % / 40 %), los límites de cada nivel,
   el recargo por mora, el pago móvil para cobrar y el **capital disponible**. Pulsa **Guardar cambios**.

Lo que guardes en **Ajustes** lo usa la app de los clientes al entrar (y cada 2 minutos): comisiones, límites,
cuotas máximas, recargo por mora, usos de Pipo y el pago móvil donde te pagan.

## Uso diario en el panel `/admin.html`

| Qué | Dónde |
|---|---|
| Ver quién espera revisión | Contadores de arriba: *Líneas por revisar*, *Préstamos por aprobar*, *Pagos por validar*. La lista se actualiza sola cada 30 s. |
| Aprobar la línea de crédito | Abre el cliente → compara **cédula** y **rostro** → elige el límite → **Aprobar línea**. |
| Confirmar un préstamo | En la solicitud: envía el dinero por pago móvil, escribe la **referencia**, adjunta la captura (opcional) → **Confirmar préstamo y desembolso**. Se generan las cuotas y el cliente lo ve en su app. |
| Validar pagos y abonos | **Validar pago** / **Rechazar pago** en cada cuota. |
| Cobradores | **Usuarios y roles → Nuevo usuario**: correo, contraseña, rol *Cobrador* y sus clientes. Solo ve esos clientes. |
| Quién hizo qué | Pestaña **Auditoría**. |
| Cambiar la contraseña de otra persona | Supabase → **Authentication → Users** → el usuario → *Reset password* / *Update user*. |
| Cliente que olvidó su contraseña | Panel → **Buscar cliente** → su ficha → **Restablecer contraseña**. |

## Avisos del plan gratuito de Supabase

- **Pausa por inactividad:** si el proyecto pasa unos 7 días sin uso, Supabase lo pausa. Se reactiva desde el panel de Supabase (*Restore project*). Con uso diario no ocurre.
- **Límites:** 500 MB de base de datos y 1 GB de archivos. Las fotos se reducen antes de subirlas (≈100–200 KB cada una), así que caben miles de clientes.
- **Copias de seguridad:** el plan gratuito no las descarga por ti. La tabla `client_history` guarda las últimas 60 versiones de cada expediente.

## Pruebas (opcional, para desarrolladores)

```bash
cd supabase/pruebas && npm install && npm test
```

`esquema.test.mjs` ejecuta `schema.sql` en un Postgres embebido (PGlite) y comprueba las reglas de seguridad.
`e2e.test.mjs` abre la app y el panel en Chromium y recorre: registro → aprobación de línea → solicitud → confirmación → pago → validación → cobrador.
