# Publicar Quincena en internet, gratis y con HTTPS

Dos caminos. El **A** es el recomendado: no necesitas tocar tu ordenador y te da una dirección
`https://…` que abre en cualquier móvil. El **B** es el más rápido si no quieres crear cuentas.

---

## A) Render (gratis, con disco de datos y HTTPS automático)

Render da un servicio web gratis con HTTPS y, además, **1 GB de disco gratuito** para que la base de
datos no se borre. Es lo que hace falta aquí.

1. Crea una cuenta en https://render.com (con GitHub o con correo).
2. Sube esta carpeta (`backend/`) a un repositorio de GitHub, con `Dockerfile`, `render.yaml`, `server.js`,
   `public/`, `scripts/` y `package.json` en la **raíz** del repositorio. No subas la carpeta `data/`.
3. En Render: **New → Blueprint**, elige el repositorio. Detecta `render.yaml` y crea el servicio.
   (Alternativa: **New → Web Service → Docker**, disco con *mount path* `/data` y 1 GB.)
4. En **Environment** rellena:
   - `CLIENT_KEY` → el código que darás a los clientes, por ejemplo `cartera-2026-x7k`
   - `ADMIN_USERNAME` → `admin`
   - `ADMIN_PASSWORD` → una frase de 16 caracteres o más (apúntala)
5. Espera el despliegue. Tu dirección será `https://quincena-xxxx.onrender.com`.

Direcciones que usarás:

- Panel: `https://quincena-xxxx.onrender.com/admin.html` (administrador y cobradores)
- Clientes: `https://quincena-xxxx.onrender.com/?c=TU_CLIENT_KEY` (el enlace guarda el código solo)

**Avisos del plan gratuito:** el servicio se duerme tras ~15 minutos sin visitas y tarda unos 30-60 s en
despertar (el primer acceso del día es lento, los datos no se pierden). No hay copias de seguridad
automáticas: en el panel, **Auditoría** y los respaldos de cada cliente siguen ahí, pero conviene
descargar un respaldo de vez en cuando.

## B) Cloudflare Tunnel (gratis, desde tu propio ordenador)

Ventaja: no hay cuentas de hosting y la base de datos es la de tu PC. Inconveniente: solo funciona
mientras el ordenador esté encendido y el servidor en marcha.

1. Instala `cloudflared` (Windows: `winget install Cloudflare.cloudflared`).
2. Arranca Quincena: `node server.js` (escucha en el puerto 3000).
3. En otra ventana: `cloudflared tunnel --url http://127.0.0.1:3000`
4. Te da una dirección `https://algo-random.trycloudflare.com`. Esa es la que compartes; cambia cada vez
   que reinicias el túnel, salvo que crees un túnel con nombre en el panel de Cloudflare (también gratis).

---

## Después de publicar

- Entra al panel, ve a **Usuarios y roles** y crea a cada cobrador con su usuario, su contraseña y sus clientes.
- Pasa a cada cliente el enlace `…/?c=TU_CLIENT_KEY` y dile que cree su cuenta con cédula, contraseña y sus tres fotos.
- Cambia la contraseña del administrador si la compartiste al principio.
- Con HTTPS ya se puede **instalar como app** en el móvil: en Android, menú del navegador → «Instalar app»;
  en iPhone, Compartir → «Añadir a pantalla de inicio». Se abre a pantalla completa, sin barra del navegador.

## Si más adelante quieres cambiar de hosting

Todo está en `DATA_DIR` (por defecto `/data` en Docker): la base `quincena.db` y la carpeta `uploads/`.
Copia esa carpeta y sigue donde lo dejaste.
