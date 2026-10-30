'use strict';
/* Pruebas de roles: administrador (todo), cobrador (solo sus clientes) y cliente (su expediente).
 * Ejecutar con: node --test tests/roles.test.js   (necesita ADMIN_USERNAME y ADMIN_PASSWORD) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin-quincena';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'clave-de-prueba-larga-123';
const CLIENT_KEY = 'prueba-clientes';

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quincena-roles-'));
  const port = 3600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS, CLIENT_KEY, ALLOWED_ORIGINS: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:' + port;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('el servidor no arrancó')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('escuchando')) { clearTimeout(to); resolve({ base, child, dir }); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (c) => { clearTimeout(to); reject(new Error('el servidor terminó: ' + c)); });
  });
}
async function call(base, method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch (_) { /* sin cuerpo */ }
  return { status: r.status, data };
}
const png = 'data:image/png;base64,' + crypto.randomBytes(600).toString('base64');
function clientState(name, ci) {
  return {
    v: 3, shift: 0, config: { rates: { 2: 10 } }, loans: [], notes: [],
    user: {
      name, fullName: name, registered: true, points: 0, streak: 0, createdAt: '2026-01-01',
      profile: { ci, email: name.split(' ')[0].toLowerCase() + '@ejemplo.com' },
      identityDocs: { front: png, back: png, selfie: png },
      creditLineReview: { status: 'pending', limit: 0 },
    },
  };
}
async function registerClient(base, name, ci) {
  const s = await call(base, 'POST', '/api/auth', { role: 'cliente', code: CLIENT_KEY });
  assert.equal(s.status, 200);
  const r = await call(base, 'POST', '/api/register', { state: clientState(name, ci), password: 'clave-cliente-1' }, s.data.token);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('roles: administrador, cobrador y cliente', async (t) => {
  const { base, child, dir } = await startServer();
  t.after(() => { try { child.kill(); } catch (_) {} });

  // 1. El administrador de arranque entra con usuario y contraseña.
  const bad = await call(base, 'POST', '/api/auth', { role: 'staff', username: ADMIN_USER, password: 'no-es-la-clave' });
  assert.equal(bad.status, 401);
  const adm = await call(base, 'POST', '/api/auth', { role: 'staff', username: ADMIN_USER, password: ADMIN_PASS });
  assert.equal(adm.status, 200, JSON.stringify(adm.data));
  assert.equal(adm.data.role, 'admin');
  const adminTok = adm.data.token;

  // 2. Dos clientes registrados.
  const c1 = await registerClient(base, 'Ana Torres', 'V-12345678');
  const c2 = await registerClient(base, 'Luis Pérez', 'V-87654321');

  // 3. El administrador crea un cobrador y le asigna solo el primer cliente.
  const created = await call(base, 'POST', '/api/users', { username: 'pedro', name: 'Pedro Gil', role: 'cobrador', password: 'clave-cobrador-1', clients: [c1.clientId] }, adminTok);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(created.data.user.clients, [c1.clientId]);
  const cobId = created.data.user.id;

  // Usuario repetido y contraseña corta se rechazan.
  assert.equal((await call(base, 'POST', '/api/users', { username: 'pedro', name: 'Otro Pedro', role: 'cobrador', password: 'clave-larga-1' }, adminTok)).status, 409);
  assert.equal((await call(base, 'POST', '/api/users', { username: 'pepa', name: 'Pepe Aguilar', role: 'cobrador', password: 'corta' }, adminTok)).status, 400);

  // 4. El cobrador entra y solo ve su cliente.
  const cob = await call(base, 'POST', '/api/auth', { role: 'staff', username: 'pedro', password: 'clave-cobrador-1' });
  assert.equal(cob.status, 200, JSON.stringify(cob.data));
  assert.equal(cob.data.role, 'cobrador');
  const cobTok = cob.data.token;
  const list = await call(base, 'GET', '/api/clients', undefined, cobTok);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.clients.map((c) => c.id), [c1.clientId]);

  // Puede abrir y modificar su expediente...
  const open = await call(base, 'GET', '/api/clients/' + c1.clientId + '/state', undefined, cobTok);
  assert.equal(open.status, 200);
  const put = await call(base, 'PUT', '/api/clients/' + c1.clientId + '/state', { version: open.data.version, state: open.data.state }, cobTok);
  assert.equal(put.status, 200);
  // ...pero no el de otro cliente, ni la gestión de usuarios.
  assert.equal((await call(base, 'GET', '/api/clients/' + c2.clientId + '/state', undefined, cobTok)).status, 403);
  assert.equal((await call(base, 'GET', '/api/users', undefined, cobTok)).status, 403);
  assert.equal((await call(base, 'POST', '/api/users', { username: 'x1', name: 'X Uno', role: 'admin', password: 'clave-larga-1' }, cobTok)).status, 403);

  // El administrador sí ve a los dos.
  const all = await call(base, 'GET', '/api/clients', undefined, adminTok);
  assert.equal(all.data.clients.length, 2);

  // 5. Asignar el segundo cliente al cobrador le da acceso; quitarlo se lo retira.
  const add = await call(base, 'PUT', '/api/users/' + cobId + '/clients/' + c2.clientId, {}, adminTok);
  assert.equal(add.status, 200);
  assert.equal((await call(base, 'GET', '/api/clients/' + c2.clientId + '/state', undefined, cobTok)).status, 200);
  await call(base, 'DELETE', '/api/users/' + cobId + '/clients/' + c2.clientId, undefined, adminTok);
  assert.equal((await call(base, 'GET', '/api/clients/' + c2.clientId + '/state', undefined, cobTok)).status, 403);

  // 6. Desactivar la cuenta corta su sesión al instante.
  await call(base, 'PATCH', '/api/users/' + cobId, { active: false }, adminTok);
  assert.equal((await call(base, 'GET', '/api/clients', undefined, cobTok)).status, 401);
  assert.equal((await call(base, 'POST', '/api/auth', { role: 'staff', username: 'pedro', password: 'clave-cobrador-1' })).status, 401);

  // 7. No se puede dejar el sistema sin administradores.
  const self = adm.data.user.id;
  assert.equal((await call(base, 'PATCH', '/api/users/' + self, { role: 'cobrador' }, adminTok)).status, 400);
  assert.equal((await call(base, 'DELETE', '/api/users/' + self, undefined, adminTok)).status, 400);

  // 8. El cliente entra con cédula y contraseña desde cualquier dispositivo y solo ve su expediente.
  assert.equal((await call(base, 'POST', '/api/auth', { role: 'cliente', code: CLIENT_KEY, ci: 'V-12345678', password: 'mala-clave' })).status, 401);
  const cs = await call(base, 'POST', '/api/auth', { role: 'cliente', code: CLIENT_KEY, ci: 'V-12345678', password: 'clave-cliente-1' });
  assert.equal(cs.status, 200, JSON.stringify(cs.data));
  assert.equal(cs.data.clientId, c1.clientId);
  assert.equal(cs.data.state.user.fullName, 'Ana Torres');
  const patch = JSON.parse(JSON.stringify(cs.data.state)); patch.user.passHash = 'scrypt$otro$valor';
  assert.equal((await call(base, 'PUT', '/api/state', { version: cs.data.version, state: patch }, cs.data.token)).status, 403, 'el cliente no puede cambiar su contraseña desde la app');
  assert.equal((await call(base, 'GET', '/api/state', undefined, cs.data.token)).status, 200);
  assert.equal((await call(base, 'GET', '/api/users', undefined, cs.data.token)).status, 403);
  assert.equal((await call(base, 'GET', '/api/clients', undefined, cs.data.token)).status, 403);

  // 9. La auditoría guarda quién hizo qué.
  const aud = await call(base, 'GET', '/api/audit?limit=200', undefined, adminTok);
  const actions = aud.data.audit.map((r) => r.role + ' ' + r.action);
  assert.ok(actions.includes('admin:' + ADMIN_USER.toLowerCase() + ' user.create'), 'falta el alta de usuario en la auditoría');
  assert.ok(actions.includes('cobrador:pedro client.state.put'), 'falta la escritura del cobrador en la auditoría');

  // 10. Cerrar sesión invalida el token.
  await call(base, 'POST', '/api/logout', {}, cobTok);
  assert.equal((await call(base, 'GET', '/api/clients', undefined, cobTok)).status, 401);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* en Windows el archivo de la base puede seguir abierto */ }
});
