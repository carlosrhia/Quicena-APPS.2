'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadApp } = require('./harness');

const PORT = 4000 + Math.floor(Math.random() * 3000);
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_USER = 'admin-test', ADMIN_PASS = 'admin-password-for-tests-2026', KEY = 'clave-secreta';
const HTML = path.join(__dirname, '..', 'public', 'index.html');
let proc, dir;

const call = async (p, { method = 'GET', body, token, ip } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) { /* no JSON */ }
  return { status: r.status, data, headers: r.headers };
};
const login = async (role) => (await call('/api/auth', { method: 'POST', body: (role === 'prestamista' || role === 'admin') ? { role: 'admin', username: ADMIN_USER, password: ADMIN_PASS } : { role, code: KEY } })).data.token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// PNG de 1x1 píxel
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quincena-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS, CLIENT_KEY: KEY, TRUST_PROXY: '1' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch (e) { /* aún no */ } await sleep(100); }
  throw new Error('el servidor no arrancó');
});
test.after(() => { proc && proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('salud, autenticación y límite de intentos', async () => {
  assert.equal((await call('/api/health')).data.quincena, true);
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/auth', { method: 'POST', body: { role: 'cliente', code: 'mal' } })).status, 401);
  assert.ok(await login('cliente'));
  assert.ok(await login('prestamista'));
  assert.equal((await call('/api/state', { token: 'x.y' })).status, 401);
  let last;
  const atk = '203.0.113.9'; // IP simulada del atacante (el servidor usa X-Forwarded-For con TRUST_PROXY=1)
  for (let i = 0; i < 6; i++) last = await call('/api/auth', { method: 'POST', body: { role: 'admin', username: ADMIN_USER, password: 'credencial-incorrecta' }, ip: atk });
  assert.equal(last.status, 429);
  assert.equal((await call('/api/auth', { method: 'POST', body: { role: 'admin', username: ADMIN_USER, password: ADMIN_PASS }, ip: atk })).status, 429, 'bloqueada aunque las credenciales sean correctas');
  assert.equal((await call('/api/auth', { method: 'POST', body: { role: 'admin', username: ADMIN_USER, password: ADMIN_PASS }, ip: '198.51.100.7' })).status, 200, 'otra IP no se ve afectada');
  assert.equal((await call('/api/auth', { method: 'POST', body: { role: 'prestamista', pin: '4821' }, ip: '198.51.100.8' })).status, 401, 'el acceso antiguo por PIN queda desactivado');
});


test('panel administrativo separado, credenciales propias y lectura privada de imágenes', async () => {
  const page = await fetch(BASE + '/admin.html');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Acceso de administrador/);
  assert.equal((await call('/api/auth', { method: 'POST', body: { role: 'admin', username: 'mal', password: 'no' } })).status, 401);
  assert.equal((await call('/api/clients')).status, 401, 'el listado no se entrega sin token');
  assert.equal((await call('/api/clients', { token: await login('cliente') })).status, 403, 'un token de cliente no puede enumerar clientes');
});

test('estado por cliente: registrar, leer, versiones y conflictos', async () => {
  const app = loadApp(HTML), S = app.x.fn.seed();
  S.user.name = 'Carlos Pérez'; S.user.fullName = 'Carlos Pérez'; S.user.registered = true; S.user.identityDocs = { front: PNG, back: PNG, selfie: PNG };
  S.user.profile = { phone: '', email: '', ci: 'V-31513004' }; S.user.createdAt = '2026-10-25';
  const generic = await login('cliente'), lender = await login('prestamista');
  assert.equal((await call('/api/state', { token: generic })).status, 409, 'la sesión sin cuenta no recibe el estado global');
  const reg = await call('/api/register', { method: 'POST', token: generic, body: { state: S } });
  assert.equal(reg.status, 201); const client = reg.data.token, id = reg.data.clientId;
  const got = await call('/api/state', { token: client });
  assert.equal(got.data.version, 1); assert.equal(got.data.state.user.name, 'Carlos Pérez');
  assert.equal((await call('/api/state?since=1', { token: client })).data.unchanged, true);
  const stale = await call('/api/state', { method: 'PUT', token: client, body: { version: 0, state: S } });
  assert.equal(stale.status, 409); assert.equal(stale.data.current.version, 1);
  const lenderGot = await call('/api/clients/' + id + '/state', { token: lender });
  assert.equal(lenderGot.status, 200); assert.equal(lenderGot.data.state.user.name, 'Carlos Pérez');
  assert.equal((await call('/api/clients/' + id + '/state', { token: client })).status, 403);
});

test('el cliente no puede aprobar préstamos, validar pagos, cambiar config ni subirse puntos; el prestamista sí', async () => {
  const app = loadApp(HTML), initial = app.x.fn.seed();
  initial.user.name = 'Ana Pérez'; initial.user.fullName = 'Ana Pérez'; initial.user.registered = true; initial.user.identityDocs = { front: PNG, back: PNG, selfie: PNG };
  initial.user.profile = { phone: '', email: '', ci: 'V-1111111' }; initial.user.createdAt = '2026-10-25';
  const generic = await login('cliente'), lender = await login('prestamista');
  const reg = await call('/api/register', { method: 'POST', token: generic, body: { state: initial } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data)); const client = reg.data.token, id = reg.data.clientId;
  const endpoint = '/api/clients/' + id + '/state';
  const cur = (await call(endpoint, { token: lender })).data;
  const mut = (fn) => { const s = JSON.parse(JSON.stringify(cur.state)); fn(s); return s; };
  const attempt = (s, token = client, version = cur.version) => call('/api/state', { method: 'PUT', token, body: { version, state: s } });
  assert.equal((await attempt(mut((s) => { s.user.points += 500; }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.user.creditLineReview = { status: 'approved', limit: 90, requestedAt: '2026-10-25', reviewedAt: '2026-10-25', reason: '' }; }))).status, 403, 'el cliente no puede aprobarse su propia línea');
  assert.equal((await attempt(mut((s) => { s.user.identityDocs.front = 'data:image/png;base64,AAAA'; }))).status, 403, 'el cliente no puede reemplazar la cédula ya enviada');
  assert.equal((await attempt(mut((s) => { s.config.rates['1'] = 0; }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.shift = 99; }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.loans.find((l) => l.id === 3).installments[0].status = 'paid'; }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.loans.find((l) => l.id === 3).amount = 1; }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.loans = s.loans.filter((l) => l.id !== 3); }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.user.streak = 99; }))).status, 403);
  assert.equal((await attempt(mut((s) => { s.loans.find((l) => l.id === 3).desembolso = { proofData: '/uploads/x.png', ref: 'FALSO', amount: 90, date: '2026-10-24' }; }))).status, 403, 'el cliente no puede inventar el comprobante de desembolso');
  assert.equal((await attempt(mut((s) => { s.loans.push({ id: 77, amount: 10, n: 1, rate: 5, total: 10.5, status: 'activo', installments: [] }); }))).status, 403);
  // Lo permitido: pedir un préstamo y enviar un pago a validación.
  const ok = await attempt(mut((s) => {
    s.loans.push({ id: 50, amount: 10, n: 1, rate: 5, total: 10.5, status: 'solicitud', installments: [], createdAt: '2026-10-24' });
    s.loans.find((l) => l.id === 3).installments[0].status = 'validating';
  }));
  assert.equal(ok.status, 200);
  // El prestamista valida usando el expediente seleccionado, no el estado global.
  const v2 = (await call(endpoint, { token: lender })).data;
  const s2 = JSON.parse(JSON.stringify(v2.state)); s2.loans.find((l) => l.id === 50).status = 'activo'; s2.loans.find((l) => l.id === 3).installments[0].status = 'paid';
  assert.equal((await call(endpoint, { method: 'PUT', token: lender, body: { version: v2.version, state: s2 } })).status, 200);
  assert.equal((await call('/api/audit', { token: client })).status, 403);
  const audit = await call('/api/audit', { token: lender }); assert.ok(audit.data.audit.some((r) => r.action === 'state.denied'));
  assert.equal((await call('/api/export', { token: lender })).status, 200);
  // Nombre, cédula y entradas históricas quedan protegidos tras el registro.
  const put = async (fn, expected, msg) => {
    const c = (await call('/api/state', { token: client })).data, state = JSON.parse(JSON.stringify(c.state)); fn(state);
    const r = await call('/api/state', { method: 'PUT', token: client, body: { version: c.version, state } }); assert.equal(r.status, expected, msg + ' → ' + JSON.stringify(r.data));
  };
  await put((s) => { s.user.fullName = 'Otra Persona'; }, 403, 'el cliente no cambia su nombre');
  await put((s) => { s.user.profile.ci = 'V-2222222'; }, 403, 'el cliente no cambia su cédula');
  await put((s) => { s.log = (s.log || []).concat([{ id: 'x1', to: 'prestamista', text: 'Evento', date: '2026-10-25', kind: 'info' }]); }, 200, 'puede añadir al historial');
  await put((s) => { s.log[s.log.length - 1].text = 'Editado'; }, 403, 'no puede editar el historial');
  await put((s) => { s.log = []; }, 403, 'ni borrarlo');
  await put((s) => { s.log.push({ id: 'x2', to: 'prestamista', text: 'Otro', date: '2026-10-25', kind: 'info' }); }, 200, 'añadir más eventos sí');
});

test('subida de capturas: valida tipo y contenido, sirve el archivo', async () => {
  const client = await login('cliente');
  assert.equal((await call('/api/upload', { method: 'POST', token: client, body: { dataUrl: 'data:text/html;base64,PGI+' } })).status, 400);
  assert.equal((await call('/api/upload', { method: 'POST', token: client, body: { dataUrl: 'data:image/png;base64,AAAA' } })).status, 400, 'extensión png pero contenido falso');
  const up = await call('/api/upload', { method: 'POST', token: client, body: { dataUrl: PNG } });
  assert.equal(up.status, 200); assert.match(up.data.url, /^\/uploads\/[0-9a-f]{32}\.png$/);
  const imgPublic = await fetch(BASE + up.data.url);
  assert.equal(imgPublic.status, 401, 'las rutas antiguas de imagen no son públicas');
  const imgAnon = await fetch(BASE + up.data.url.replace('/uploads/', '/api/uploads/'));
  assert.equal(imgAnon.status, 401, 'la ruta privada requiere un token');
  assert.equal((await fetch(BASE + '/uploads/../server.js')).status, 404);
  assert.equal((await fetch(BASE + '/uploads/' + '0'.repeat(32) + '.png')).status, 401);
  assert.equal((await fetch(BASE + '/')).status, 200);
});

test('la página v17 registra cuentas nuevas en el backend y el historial las muestra', async () => {
  const makeDevice = async (name, ci) => {
    const d = loadApp(HTML, { href: BASE + '/', fetchImpl: (u, o) => fetch(u, o) });
    d.x.Backend.url = BASE; d.x.Backend.code = KEY; d.x.Backend.enabled = true;
    assert.equal(await d.x.Backend.connect(), true, 'conexión al servidor');
    const email = ci.toLowerCase().replace(/[^a-z0-9]/g, '') + '@example.test';
    d.x.ui.signupEmailVerified = email;
    d.x.ui.emailAuth = { purpose: 'signup', email, verified: true, code: '123456', expiresAt: Date.now() + 600000, attempts: 0 };
    d.ctx.document.querySelector('#suName').value = name;
    d.ctx.document.querySelector('#suCI').value = ci;
    for (const id of ['#suFront','#suBack','#suSelfie']) d.ctx.document.querySelector(id).files = [{ type: 'image/png', size: 100, name: id.slice(1)+'.png' }];
    await d.x.A.signupSave();
    assert.ok(d.x.Backend.clientId, 'el alta obtiene un identificador persistente del servidor');
    await sleep(500);
    return d;
  };
  const ana = await makeDevice('Ana María Torres', 'V-44556677');
  const luis = await makeDevice('Luis Alberto Rojas', 'V-55667788');
  assert.notEqual(ana.x.Backend.clientId, luis.x.Backend.clientId);
  assert.equal(ana.x.getS().loans.length, 0, 'la cuenta nueva no hereda préstamos de demostración');
  assert.equal(luis.x.getS().loans.length, 0);

  const adminToken = await login('admin');
  const clientsResponse = await call('/api/clients', { token: adminToken });
  const clients = clientsResponse.data.clients;
  assert.ok(clients.some(c => c.id === ana.x.Backend.clientId && c.name === 'Ana María Torres'));
  assert.ok(clients.some(c => c.id === luis.x.Backend.clientId && c.name === 'Luis Alberto Rojas'));
  const adminA = await call('/api/clients/' + ana.x.Backend.clientId + '/state', { token: adminToken });
  assert.equal(adminA.data.state.user.fullName, 'Ana María Torres');
  assert.equal(adminA.data.state.loans.length, 0);
  const publicPage = await fetch(BASE + '/');
  const publicHTML = await publicPage.text();
  assert.doesNotMatch(publicHTML, /data-v="prestamista"|aria-label="Vista"/);
  assert.equal((await fetch(BASE + '/admin.html')).status, 200);
  ana.x.Backend.stop(); luis.x.Backend.stop();
});

test('varios clientes: registro por cédula, expedientes aislados y listado solo para el prestamista', async () => {
  const clientSeed = (name, ci) => {
    const x = loadApp(HTML).x, s = x.fn.seed();
    s.user.name = name; s.user.fullName = name; s.user.registered = true; s.user.identityDocs = { front: PNG, back: PNG, selfie: PNG };
    s.user.profile = { phone: '', email: '', ci }; s.user.createdAt = '2026-10-25';
    s.user.points = 0; s.user.streak = 0; s.user.tutorialDone = true;
    s.user.petBonusCredit = 0; s.user.petMoraDiscount = 0; s.user.pipo = { m: '', c: 0 };
    s.loans = []; s.log = []; s.notes = []; s.seq = 1;
    return s;
  };
  const genericA = await login('cliente'), genericB = await login('cliente');
  const a = await call('/api/register', { method: 'POST', token: genericA, body: { state: clientSeed('María Gómez Rojas', 'V-9876543') } });
  const b = await call('/api/register', { method: 'POST', token: genericB, body: { state: clientSeed('Pedro Antonio Díaz', 'V-12345678') } });
  assert.equal(a.status, 201, JSON.stringify(a.data)); assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.notEqual(a.data.clientId, b.data.clientId, 'cada cliente recibe un identificador distinto');
  assert.equal((await call('/api/register', { method: 'POST', token: await login('cliente'), body: { state: clientSeed('Otra Persona', 'V-9876543') } })).status, 409, 'no se puede registrar dos veces la misma cédula');

  const gotA = await call('/api/state', { token: a.data.token }), gotB = await call('/api/state', { token: b.data.token });
  assert.equal(gotA.data.state.user.fullName, 'María Gómez Rojas');
  assert.equal(gotB.data.state.user.fullName, 'Pedro Antonio Díaz');
  assert.equal(gotA.data.state.loans.length, 0); assert.equal(gotB.data.state.loans.length, 0);

  const changedA = JSON.parse(JSON.stringify(gotA.data.state));
  changedA.loans.push({ id: 12, amount: 20, n: 1, rate: 5, total: 21, status: 'solicitud', method: 'pm', createdAt: '2026-10-25', installments: [] });
  const saved = await call('/api/state', { method: 'PUT', token: a.data.token, body: { version: gotA.data.version, state: changedA } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const freshA = await call('/api/state', { token: a.data.token }), freshB = await call('/api/state', { token: b.data.token });
  assert.equal(freshA.data.state.loans.length, 1, 'el préstamo se guarda en el expediente A');
  assert.equal(freshB.data.state.loans.length, 0, 'el expediente B no recibe el préstamo del cliente A');

  const lender = await login('prestamista');
  const listing = await call('/api/clients', { token: lender });
  assert.equal(listing.status, 200); assert.ok(listing.data.clients.length >= 2);
  assert.ok(listing.data.clients.some(c => c.id === a.data.clientId && c.ci === 'V-9876543'));
  assert.ok(listing.data.clients.some(c => c.id === b.data.clientId && c.ci === 'V-12345678'));
  assert.equal((await call('/api/clients', { token: a.data.token })).status, 403, 'el listado de clientes solo es para el prestamista');
  const lenderA = await call('/api/clients/' + a.data.clientId + '/state', { token: lender });
  const lenderB = await call('/api/clients/' + b.data.clientId + '/state', { token: lender });
  assert.equal(lenderA.data.state.loans.length, 1); assert.equal(lenderB.data.state.loans.length, 0);
});
