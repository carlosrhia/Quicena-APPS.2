# Quincena Préstamos — backend con cuentas y roles

Servidor Node.js (sin dependencias) para la app de clientes `public/index.html` y el panel `public/admin.html`.
Todo vive en un mismo sitio: la app del cliente en `/`, el panel del personal en `/admin.html`.

## Qué hay en esta versión

- **Tres tipos de cuenta**
  - **Administrador**: todo. Ve todos los clientes, crea y edita usuarios, asigna clientes a los cobradores, consulta la auditoría.
  - **Cobrador**: entra con su propio usuario y contraseña y **solo ve y cobra los clientes que tenga asignados**. No puede crear usuarios ni ver los de otros.
  - **Cliente**: se registra desde la app con su cédula y sus tres fotos, y solo accede a su propio expediente.
- Contraseñas cifradas con **scrypt** y sesiones guardadas en la base: al desactivar una cuenta, cambiarle la contraseña o el rol, sus sesiones abiertas se cortan al instante.
- Asignación cobrador ↔ cliente (`assignments`), cambiando cuando quieras desde el panel.
- Auditoría con el autor real de cada acción (`admin:ana`, `cobrador:pedro`, `cliente`): accesos, escrituras de expedientes, lecturas de imágenes y gestión de usuarios.
- Los expedientes y las capturas siguen siendo privados: las imágenes se sirven solo por `/api/uploads/:nombre` con token, y el cobrador únicamente ve las de sus clientes.

## Requisitos

- Node.js `>=22.13` (usa `node:sqlite`, `http` y `crypto` integrados). No hay que instalar nada más.
- Un disco persistente para `DATA_DIR`.
- HTTPS delante del servicio en producción.

## Instalar y arrancar

```bash
cd backend
npm test                 # pruebas: front, servidor y roles
node scripts/create-admin.js admin "Tu Nombre"   # crea el administrador (pide la contraseña)
node server.js
```

- Panel del personal: `/admin.html` (administrador y cobradores).
- App del cliente: `/`.
- `CLIENT_KEY` es el código de acceso que se pide a los clientes para entrar a la app. Cámbialo por un secreto largo.

### Variables de entorno

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `DATA_DIR` | Carpeta de la base de datos y las imágenes (por defecto `./data`) |
| `CLIENT_KEY` | Código que se pide al cliente para entrar |
| `ALLOWED_ORIGINS` | Dominios permitidos; en producción, el tuyo |
| `TRUST_PROXY` | `1` si hay un proxy de confianza delante (para la IP real) |
| `TOKEN_SECRET` | Opcional; si falta se genera y se guarda en `DATA_DIR/secret.key` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Opcional: crea el primer administrador al arrancar (contraseña de 16+ caracteres). Solo se usa la primera vez. |

## Uso diario

1. Entra en `/admin.html` como administrador.
2. **Usuarios y roles → Nuevo usuario**: nombre, usuario, contraseña y rol *Cobrador*; marca los clientes que atiende.
3. El cobrador entra en `/admin.html` con su usuario y contraseña: solo verá esos clientes y podrá aprobar líneas, préstamos, validar pagos y abonos, con todo registrado a su nombre.
4. En **Auditoría** revisas quién hizo qué y cuándo.

## Estructura

```
server.js                  Servidor HTTP, autenticación, roles, rutas /api/*
public/index.html          App del cliente
public/admin.html          Panel del personal (clientes, usuarios y roles, auditoría)
scripts/create-admin.js    Crear administrador o restablecer su contraseña
tests/                     Pruebas (front, servidor, roles)
data/                      Base de datos SQLite e imágenes (no se sube al repositorio)
```

## Pendiente para producción

Revisa profesionalmente autenticación y recuperación de cuenta, HTTPS y proxy, gestión de secretos, respaldos cifrados, retención de documentos y cumplimiento legal (datos personales y límites de interés). Esta base ya separa por roles, pero no es una auditoría de seguridad.
