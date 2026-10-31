# Quincena Préstamos

App de préstamos para clientes (`/`) y panel de administración (`/admin.html`), publicada en **Vercel** y conectada a **Supabase** (plan gratuito).

👉 **Instalación paso a paso:** [`supabase/LEEME.md`](supabase/LEEME.md)

## Cómo funciona

```
Cliente (móvil)                Supabase                         Panel /admin.html
───────────────                ────────                         ─────────────────
Crear cuenta: nombre,   ──►  Auth (cédula + contraseña)   ◄──  Login con correo + contraseña
cédula, contraseña,          Tabla clients (expediente)        (administrador o cobrador)
foto cédula + rostro   ──►  Storage privado "documentos"  ◄──  Ve fotos con enlaces temporales
Solicita préstamo      ──►  Reglas RLS + trigger que       ◄──  Aprueba línea, confirma préstamo,
Envía pagos                  impide autoaprobarse               valida pagos
```

- **Cuentas de cliente:** la cédula es el usuario (internamente `v12345678@clientes.quincena.app`) y la contraseña la elige el cliente. Se puede entrar desde cualquier teléfono.
- **Fotos:** la de la cédula y la del rostro son obligatorias (el reverso de la cédula es opcional). Se guardan en un bucket **privado**; solo las ven el propio cliente y el personal autorizado.
- **Seguridad en la base de datos:** el cliente solo puede leer y modificar su expediente, y un trigger (`quincena_guard`) rechaza cualquier intento de aprobarse la línea, cambiar puntos, marcar pagos como validados o borrar historial.
- **Roles del panel:** *administrador* (todo, gestión de usuarios y auditoría) y *cobrador* (solo los clientes asignados).
- **Sin Supabase configurado** la app funciona en modo demostración, solo en el dispositivo.

## Estructura

```
public/index.html        App del cliente
public/admin.html        Panel del personal
public/vendor/           Cliente oficial de Supabase (copia local, MIT)
public/config.js         Configuración manual opcional (si no usas variables de Vercel)
api/config.js            Función de Vercel: entrega SUPABASE_URL y SUPABASE_ANON_KEY a la web
supabase/schema.sql      Tablas, reglas de seguridad, almacenamiento y funciones
supabase/LEEME.md        Guía de instalación (Supabase + Vercel)
supabase/pruebas/        Pruebas del esquema (PGlite) y de extremo a extremo (Chromium)
tests/                   Pruebas de la lógica de la app (npm test)
vercel.json              Carpeta publicada y cabeceras de seguridad
```

## Pruebas

```bash
npm test                                         # lógica de la app (sin dependencias)
cd supabase/pruebas && npm install && npm test   # esquema SQL + recorrido completo en navegador
```

## Pendiente para producción

Revisión legal (protección de datos personales y límites de interés), política de conservación de documentos y copias de seguridad periódicas de Supabase.
