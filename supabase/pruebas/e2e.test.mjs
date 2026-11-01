// Prueba de extremo a extremo: Chromium real + app + panel + esquema SQL real (PGlite) tras un Supabase simulado.
import { PGlite } from '@electric-sql/pglite';
import { createRequire as __cr } from 'node:module';
const __pgcrypto = { name: 'pgcrypto', setup: async () => ({ bundlePath: new URL('file://' + __cr(import.meta.url).resolve('@electric-sql/pglite').replace(/dist\/.*$/, 'dist/pgcrypto.tar.gz')) }) };
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const db = new PGlite({ extensions: { pgcrypto: __pgcrypto } });
await db.exec(`
create role anon; create role authenticated; create schema extensions;
create schema auth; create schema storage;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, pass text, encrypted_password text, updated_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit int, allowed_mime_types text[]);
create table storage.objects (id serial primary key, bucket_id text, name text unique, data text, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
grant usage on schema public, storage, auth to authenticated; grant execute on all functions in schema storage, auth to authenticated;
`);
await db.exec(fs.readFileSync(ROOT + '/supabase/schema.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated; grant select, insert on storage.objects to authenticated; grant usage on all sequences in schema storage to authenticated; alter table storage.objects enable row level security;`);

let lock = Promise.resolve();
const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
async function as(uid, sql, params, claims) {
  await db.exec('reset role');
  await db.query(`select set_config('request.uid', $1, false), set_config('request.jwt.claims', $2, false)`, [uid || '', JSON.stringify(claims || {})]);
  await db.exec('set role authenticated');
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const ident = (s) => { if (!/^[a-z0-9_]+$/.test(s)) throw new Error('ident ' + s); return s; };
const colList = (c) => (c === '*' ? '*' : c.split(',').map((x) => ident(x.trim())).join(','));
const sess = (u, method = 'password') => ({ access_token: u.id, user: { id: u.id, email: u.email }, session_id: randomUUID(), amr: [{ method, timestamp: 1 }] });
const otpCodes = new Map();
const err = (e) => ({ data: null, error: { message: e.message || String(e) } });

async function handle(m) {
  try {
    if (m.kind === 'signUp') {
      const ex = await db.query('select id from auth.users where email=$1', [m.email.toLowerCase()]);
      if (ex.rows.length) return { data: { user: null, session: null }, error: { message: 'User already registered' } };
      const u = (await db.query('insert into auth.users(email,pass) values ($1,$2) returning id,email', [m.email.toLowerCase(), m.password])).rows[0];
      return { data: { user: { id: u.id }, session: sess(u) }, error: null };
    }
    if (m.kind === 'signIn') {
      const u = (await db.query('select id,email from auth.users where email=$1 and (case when encrypted_password is not null then encrypted_password = extensions.crypt($2, encrypted_password) else pass=$2 end)', [m.email.toLowerCase(), m.password])).rows[0];
      return u ? { data: { user: { id: u.id }, session: sess(u) }, error: null } : { data: null, error: { message: 'Invalid login credentials' } };
    }
    if (m.kind === 'otpSend') {
      let u = (await db.query('select id from auth.users where email=$1', [m.email.toLowerCase()])).rows[0];
      if (!u && !m.create) return { data: null, error: { message: 'Signups not allowed for otp' } };
      if (!u) u = (await db.query('insert into auth.users(email) values ($1) returning id', [m.email.toLowerCase()])).rows[0];
      const code = String(100000 + Math.floor(Math.random() * 900000)); otpCodes.set(m.email.toLowerCase(), code);
      return { data: {}, error: null };
    }
    if (m.kind === 'otpVerify') {
      const code = otpCodes.get(m.email.toLowerCase());
      if (!code || code !== m.token) return { data: null, error: { message: 'Token has expired or is invalid' } };
      otpCodes.delete(m.email.toLowerCase());
      const u = (await db.query('select id,email from auth.users where email=$1', [m.email.toLowerCase()])).rows[0];
      return { data: { user: { id: u.id }, session: sess(u, 'otp') }, error: null };
    }
    if (m.kind === 'updateUser') { await db.query('update auth.users set pass=$1 where id=$2', [m.password, m.uid]); return { data: {}, error: null }; }
    if (m.kind === 'upload') { await as(m.uid, 'insert into storage.objects(bucket_id,name,data) values ($1,$2,$3)', [m.bucket, m.path, m.data], m.claims); return { data: { path: m.path }, error: null }; }
    if (m.kind === 'signed') {
      const r = await as(m.uid, 'select data from storage.objects where bucket_id=$1 and name=$2', [m.bucket, m.path], m.claims);
      return r.rows.length ? { data: { signedUrl: r.rows[0].data }, error: null } : { data: null, error: { message: 'Object not found' } };
    }
    if (m.kind === 'rpc') {
      const keys = Object.keys(m.args);
      const vals = keys.map((k) => m.args[k]);
      const sql = `select public.${ident(m.name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}${Array.isArray(m.args[k]) ? '::uuid[]' : (m.args[k] && typeof m.args[k] === 'object') ? '::jsonb' : ''}`).join(',')}) as r`;
      const r = await as(m.uid, sql, vals, m.claims);
      return { data: r.rows[0].r, error: null };
    }
    if (m.kind === 'query') {
      const params = []; const p = (v) => { params.push(v); return '$' + params.length; };
      const where = m.f.length ? ' where ' + m.f.map(([c, op, v]) => `${ident(c)} ${op} ${p(v)}`).join(' and ') : '';
      let sql;
      if (m.op === 'select') sql = `select ${colList(m.cols)} from public.${ident(m.t)}${where}${m.ord.length ? ' order by ' + m.ord.map(([c, d]) => ident(c) + ' ' + d).join(',') : ''}${m.lim ? ' limit ' + Number(m.lim) : ''}`;
      if (m.op === 'update') { const sets = Object.entries(m.payload).map(([k, v]) => `${ident(k)} = ${p(v)}`); sql = `update public.${ident(m.t)} set ${sets.join(',')}${where} returning ${colList(m.ret || '*')}`; }
      if (m.op === 'upsert') { const ks = Object.keys(m.payload); sql = `insert into public.${ident(m.t)} (${ks.map(ident).join(',')}) values (${ks.map((k) => p(m.payload[k])).join(',')}) on conflict (${ident(ks[0])}) do update set ${ks.slice(1).map((k) => ident(k) + ' = excluded.' + ident(k)).join(',')} returning ${colList(m.ret || '*')}`; }
      if (m.op === 'insert') { const ks = Object.keys(m.payload); sql = `insert into public.${ident(m.t)} (${ks.map(ident).join(',')}) values (${ks.map((k) => p(m.payload[k])).join(',')}) returning ${colList(m.ret || '*')}`; }
      const rows = (await as(m.uid, sql, params, m.claims)).rows;
      if (m.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
      if (m.mode === 'maybe') return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    throw new Error('kind ' + m.kind);
  } catch (e) { return err(e); }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/config') { res.setHeader('Content-Type', 'application/javascript'); return res.end('window.QUINCENA_CONFIG={"url":"http://fake.supabase","anonKey":"anon"};'); }
  const f = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(ROOT + '/public') || !fs.existsSync(f)) { res.statusCode = 404; return res.end('no'); }
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.webmanifest': 'application/json' }[path.extname(f)] || 'application/octet-stream';
  res.setHeader('Content-Type', type); fs.createReadStream(f).pipe(res);
});
await new Promise((ok) => server.listen(0, ok));
const BASE = 'http://127.0.0.1:' + server.address().port;
const fake = fs.readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');

const browser = await chromium.launch();
const newCtx = async (vp) => {
  const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
  await ctx.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'application/javascript', body: fake }));
  await ctx.exposeFunction('__sb', (s) => serial(() => handle(JSON.parse(s))).then((r) => JSON.stringify(r)));
  return ctx;
};
const pageErrors = [];
const watch = (pg, name) => { pg.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message)); pg.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (globalThis.__answer ?? 'Documentos ilegibles') : undefined)); };
const png = { name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };
const SHOT = new URL('./', import.meta.url).pathname; // capturas: admin-expediente.png y cliente-prestamo.png

// ---------- 1. el cliente crea su cuenta ----------
const cctx = await newCtx({ width: 390, height: 844 });
const cp = await cctx.newPage(); watch(cp, 'cliente');
await cp.goto(BASE + '/');
await cp.waitForSelector('[data-a=authCreate]');
assert.equal(await cp.locator('text=Seguir sin cuenta').count(), 0, 'sin modo invitado con Supabase');
await cp.click('[data-a=authCreate]');
await cp.fill('#suName', 'Ana María Pérez');
await cp.fill('#suCI', 'V-12345678');
await cp.fill('#suPass', 'clave-segura-1');
await cp.fill('#suPass2', 'clave-segura-1');
assert.equal(await cp.locator('#suBack').count(), 0, 'ya no se pide el reverso de la cédula');
assert.equal(await cp.locator('#suFront:not([capture])').count(), 1, 'un solo campo: el teléfono ofrece cámara o archivo');
await cp.click('[data-a=authBack] >> nth=0');
await cp.waitForSelector('[data-a=clientLogin]');
await cp.click('[data-a=authCreate]');
await cp.fill('#suName', 'Ana María Pérez'); await cp.fill('#suCI', 'V-12345678');
await cp.fill('#suPass', 'clave-segura-1'); await cp.fill('#suPass2', 'clave-segura-1');
await cp.fill('#suEmail', 'ana@correo.com');
await cp.setInputFiles('#suFront', png);
await cp.setInputFiles('#suSelfie', png);
await cp.click('[data-a=signupSave]');
await cp.waitForSelector('#dvCode', { timeout: 15000 });
assert.equal((await db.query('select count(*)::int n from public.clients')).rows[0].n, 0, 'sin confirmar el correo no se crea el expediente');
await cp.fill('#dvCode', '000000'); await cp.click('[data-a=deviceVerify]');
await cp.waitForFunction(() => /no es válido/.test(document.querySelector('#dvErr').textContent));
await cp.fill('#dvCode', otpCodes.get('ana@correo.com')); await cp.click('[data-a=deviceVerify]');
await cp.waitForFunction(() => document.querySelector('#toast') && /Cuenta creada/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
let row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.name, 'Ana María Pérez'); assert.equal(row.ci, 'V-12345678');
assert.match(row.state.user.identityDocs.front, /^sb:[0-9a-f-]{36}\/front-/); assert.match(row.state.user.identityDocs.selfie, /^sb:/);
assert.equal(row.state.user.creditLineReview.status, 'pending');
assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n, 2);
assert.equal((await db.query(`select email from auth.users`)).rows[0].email, 'v12345678@clientes.quincena.app');
console.log('✓ registro del cliente: cuenta, 2 fotos privadas y expediente con línea pendiente');

// ---------- 2. el administrador entra al panel ----------
await db.query(`insert into auth.users(email,pass) values ('jefe@quincena.app','admin-clave-1')`);
await db.query(`insert into public.staff (user_id, email, name, role) select id, lower(email), 'Carlos Jefe', 'admin' from auth.users where lower(email) = lower('JEFE@quincena.app') on conflict (user_id) do update set role = 'admin', active = true`);
const actx = await newCtx({ width: 1300, height: 900 });
const ap = await actx.newPage(); watch(ap, 'admin');
const toastIs = (pg, re) => pg.waitForFunction((src) => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, { timeout: 15000 });
await ap.goto(BASE + '/admin.html');
await ap.fill('#email', 'jefe@quincena.app'); await ap.fill('#password', 'mala-clave');
await ap.click('#loginForm button[type=submit]');
await ap.waitForFunction(() => /incorrectos/.test(document.querySelector('#loginErr').textContent));
await ap.fill('#email', 'v12345678@clientes.quincena.app'); await ap.fill('#password', 'clave-segura-1');
await ap.click('#loginForm button[type=submit]');
await ap.waitForFunction(() => /cuenta de cliente/.test(document.querySelector('#loginErr').textContent));
await ap.fill('#email', 'jefe@quincena.app'); await ap.fill('#password', 'admin-clave-1');
await ap.click('#loginForm button[type=submit]');
await ap.waitForSelector('#otpForm:not(.hidden)');
assert.equal(await ap.isVisible('#appView'), false, 'sin el código no se abre el panel');
await ap.fill('#otp', '000000'); await ap.click('#otpForm button[type=submit]');
await ap.waitForFunction(() => /no es válido/.test(document.querySelector('#otpErr').textContent));
await ap.fill('#otp', otpCodes.get('jefe@quincena.app')); await ap.click('#otpForm button[type=submit]');
await ap.waitForSelector('#appView:not(.hidden)');
console.log('✓ verificación en dos pasos: contraseña + código del correo (un código erróneo se rechaza)');
await ap.waitForSelector('h1.big');
assert.match(await ap.textContent('#nav'), /Verificación1/);
await ap.screenshot({ path: SHOT + 'panel-hoy.png' });
console.log('✓ login del administrador; «Tu día» con contadores reales');

// ---------- 3. verificación de identidad: pedir fotos nuevas, el cliente las reenvía y se aprueba ----------
await ap.click('[data-go=verificacion]');
await ap.waitForSelector('#main img[data-sb][src^="data:"]');
assert.equal(await ap.locator('#main img[data-sb][src^="data:"]').count(), 2, 'cédula y rostro visibles');
assert.equal(await ap.isDisabled('[data-act=vApprove]'), true, 'no se aprueba sin confirmar las casillas');
globalThis.__answer = 'Foto borrosa';
await ap.click('[data-act=vDocs]');
await toastIs(ap, /fotos nuevas/);
await cp.reload();
await cp.waitForSelector('[data-a=profileDocs]', { timeout: 15000 });
if (await cp.locator('[data-a=tutorialNext]').count()) { for (let i = 0; i < 8 && await cp.locator('[data-a=tutorialNext]').count(); i++) await cp.click('[data-a=tutorialNext]'); }
await cp.click('[data-a=profileDocs]');
await cp.setInputFiles('#docFront', png); await cp.setInputFiles('#docSelfie', png);
await cp.click('[data-a=identityDocsSave]');
await toastIs(cp, /Documentos enviados/);
await cp.waitForTimeout(1200);
row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.state.user.creditLineReview.status, 'pending', 'el cliente reenvió las fotos');
console.log('✓ «Pedir fotos nuevas» llega al cliente, que las reenvía desde su app');
await ap.click('[data-act=refresh]');
await ap.click('[data-go=verificacion]');
await ap.waitForSelector('[data-act=vCheck][data-k=name]');
await ap.click('[data-act=vCheck][data-k=name]'); await ap.click('[data-act=vCheck][data-k=face]');
await ap.selectOption('#vLevel', '1');
await ap.screenshot({ path: SHOT + 'panel-verificacion.png' });
await ap.click('[data-act=vApprove]');
await toastIs(ap, /Línea de crédito aprobada/);
row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.state.user.creditLineReview.status, 'approved'); assert.equal(row.state.user.creditLineReview.limit, 70); assert.equal(row.state.user.levelOverride, 2);
console.log('✓ línea aprobada con nivel inicial 2 ($70)');

// ---------- 4. ajustes del negocio se aplican en la app del cliente ----------
await ap.click('[data-go=ajustes]');
await ap.fill('#rate2', '25'); await ap.fill('#setCap', '500'); await ap.fill('#setPay', 'Banco 0102 · 0414-0000000 · V-1');
await ap.click('[data-act=saveSettings]');
await toastIs(ap, /Ajustes guardados/);
await cp.reload();
await cp.waitForFunction(() => typeof GS !== 'undefined' && GS.rates && Number(GS.rates[2]) === 25, null, { timeout: 15000 });
assert.equal(await cp.evaluate(() => level().limit), 70, 'el cliente ve su nivel 2');
assert.match(await cp.evaluate(() => method('pm').detail), /0102/, 'el pago móvil de cobro viene de Ajustes');
console.log('✓ Ajustes (comisión, capital, pago móvil) sincronizados con la app del cliente');

// ---------- 5. solicitud con la comisión nueva y confirmación del préstamo ----------
if (await cp.locator('[data-a=tutorialNext]').count()) { for (let i = 0; i < 8 && await cp.locator('[data-a=tutorialNext]').count(); i++) await cp.click('[data-a=tutorialNext]'); }
await cp.evaluate(() => { A.tab('inicio'); });
await cp.waitForSelector('[data-a=request]');
await cp.evaluate(() => { const d = draft(); d.amount = 20; d.n = 2; });
await cp.click('[data-a=request]');
await cp.fill('#pmBank', 'Banesco'); await cp.fill('#pmPhone', '0414-1234567'); await cp.fill('#pmCI', 'V-12345678');
await cp.click('[data-a=rnext]'); await cp.click('[data-a=rsend]');
await toastIs(cp, /Solicitud enviada/);
await cp.waitForTimeout(1200);
row = (await db.query('select * from public.clients')).rows[0];
const req = row.state.loans.find((l) => l.status === 'solicitud');
assert.ok(req, 'solicitud guardada'); assert.equal(req.rate, 25); assert.equal(req.total, 25);
await ap.click('[data-act=refresh]');
await ap.click('[data-go=solicitudes]');
await ap.click('[data-act=approveOpen]');
await ap.fill('#apRef', '00123456'); await ap.setInputFiles('#apFile', png);
await ap.screenshot({ path: SHOT + 'panel-solicitudes.png' });
await ap.click('[data-act=approveLoan]');
await toastIs(ap, /Préstamo confirmado/);
row = (await db.query('select * from public.clients')).rows[0];
let loan = row.state.loans.find((l) => l.id === req.id);
assert.equal(loan.status, 'activo'); assert.equal(loan.installments.length, 2); assert.match(loan.desembolso.proofData, /^sb:/);
assert.equal(Number((await db.query('select data from app_settings')).rows[0].data.capital), 480, 'el capital baja con el desembolso');
await cp.waitForFunction(() => S.loans.some((l) => l.status === 'activo'), null, { timeout: 25000 });
console.log('✓ solicitud con comisión de Ajustes (25 %) → confirmada → cuotas en la app del cliente; capital 500 → 480');

// ---------- 6. pago y validación en lote ----------
await cp.evaluate(() => A.tab('prestamos'));
await cp.click('[data-a=payOptions]'); await cp.click('[data-a=payFull]');
await cp.fill('#ref', '778899'); await cp.setInputFiles('#proof', png);
await cp.click('[data-a=psend]');
await cp.waitForTimeout(1500);
await ap.click('[data-act=refresh]');
await ap.click('[data-go=pagos]');
await ap.waitForSelector('[data-act=paySel]:not([disabled])');
assert.match(await ap.textContent('#main'), /Monto coincide/);
await ap.click('[data-act=paySel]');
await toastIs(ap, /Pagos validados/);
row = (await db.query('select * from public.clients')).rows[0];
loan = row.state.loans.find((l) => l.id === req.id);
assert.equal(loan.installments[0].status, 'paid'); assert.equal(row.state.user.points, 10);
assert.equal(Number((await db.query('select data from app_settings')).rows[0].data.capital), 492.5, 'el capital sube al cobrar');
console.log('✓ pago validado en lote; +10 puntos; capital 480 → 492,5');

// ---------- 7. ficha: nota interna, bloqueo, nivel y contraseña ----------
await ap.fill('#topSearch', 'ana');
await ap.waitForSelector('[data-act=pick]');
await ap.click('[data-act=pick]');
await ap.waitForSelector('#noteText');
await ap.fill('#noteText', 'Cliente puntual'); await ap.click('[data-act=saveNote]');
await toastIs(ap, /Nota guardada/);
await ap.screenshot({ path: SHOT + 'panel-ficha.png', fullPage: true });
await ap.click('[data-act=block]');
await toastIs(ap, /Cuenta bloqueada/);
await cp.waitForFunction(() => S.user.accountBlocked === true, null, { timeout: 25000 });
assert.equal(await cp.evaluate(() => available()), 0, 'bloqueado: sin disponible');
globalThis.__answer = 'clave-nueva-99';
await ap.click('[data-act=resetPass]');
await toastIs(ap, /Contraseña restablecida/);
assert.equal((await db.query(`select note from client_notes`)).rows[0].note, 'Cliente puntual');
assert.match((await db.query(`select encrypted_password from auth.users where email like 'v12345678%'`)).rows[0].encrypted_password, /^\$2a\$/);
console.log('✓ nota interna privada, bloqueo sincronizado con el cliente y contraseña restablecida');

// ---------- 8. secciones restantes y cobrador ----------
for (const sec of ['cobros', 'mensajes', 'reportes', 'hoy']) { await ap.click('[data-go=' + sec + ']'); await ap.waitForTimeout(200); }
await ap.click('[data-go=reportes]');
await ap.click('[data-act=closePeriod]');
await toastIs(ap, /Quincena cerrada/);
await ap.click('[data-act=theme]');
await ap.click('[data-go=hoy]');
await ap.waitForTimeout(700); await ap.screenshot({ path: SHOT + 'panel-claro.png' });
await ap.click('[data-act=theme]');
await ap.click('[data-go=equipo]');
await ap.waitForSelector('#uName');
await ap.fill('#uName', 'Pedro Cobrador'); await ap.fill('#uEmail', 'pedro@quincena.app'); await ap.fill('#uPass', 'cobrador-1');
await ap.selectOption('#uRole', 'cobrador');
await ap.click('input[name=uClient]');
await ap.click('[data-act=staffSave]');
await toastIs(ap, /Usuario creado/);
await ap.click('[data-go=auditoria]');
await ap.waitForFunction(() => /staff\.auth\.ok/.test(document.querySelector('#main').textContent));
const kctx = await newCtx({ width: 390, height: 844 });
const kp = await kctx.newPage(); watch(kp, 'cobrador');
await kp.goto(BASE + '/admin.html');
await kp.fill('#email', 'pedro@quincena.app'); await kp.fill('#password', 'cobrador-1');
await kp.click('#loginForm button[type=submit]');
await kp.waitForSelector('h1.big');
assert.equal(await kp.locator('[data-go=ajustes]').count(), 0, 'el cobrador no ve Ajustes');
await kp.screenshot({ path: SHOT + 'panel-movil.png' });
console.log('✓ calendario, mensajes, reportes, cierre de quincena, modo claro, equipo, auditoría y cobrador (móvil)');

// ---------- 8b. soporte, color del nivel 1 y notificaciones ----------
await cctx.grantPermissions(['notifications'], { origin: BASE });
await cp.evaluate(() => { A.profile(); });
assert.match(await cp.getAttribute('a.profile-support-row', 'href'), /wa\.me\/584220018255/);
assert.doesNotMatch(await cp.textContent('.profile-page'), /0422|0018255|8411730/, 'el número no se muestra');
await cp.evaluate(() => { A.profileClose(); A.bell(); });
await cp.waitForSelector('.nt-perm');
assert.match(await cp.textContent('.sheet'), /Notificaciones activadas|Notificaciones bloqueadas|Activa las notificaciones/); assert.match(await cp.textContent('.sheet'), /Hoy/); await cp.screenshot({ path: SHOT + 'cliente-notificaciones.png' });
await cp.evaluate(() => A.close());
assert.equal(await cp.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), 'none');
console.log('✓ soporte por WhatsApp sin número visible, notificaciones activables y sin rebote al deslizar');

// ---------- 8c. teléfono nuevo: hace falta el código del correo ----------
const nctx = await newCtx({ width: 390, height: 844 });
const np = await nctx.newPage(); watch(np, 'telefono-nuevo');
await np.goto(BASE + '/');
await np.waitForSelector('[data-a=clientLogin]');
await np.fill('#clCI', 'V-12345678'); await np.fill('#clPass', 'clave-nueva-99');
await np.click('[data-a=clientLogin]');
await np.waitForSelector('#dvCode', { timeout: 15000 });
assert.match(await np.textContent('.sheet'), /an•••@correo\.com/, 'muestra el correo enmascarado');
await np.fill('#dvCode', otpCodes.get('ana@correo.com')); await np.click('[data-a=deviceVerify]');
await toastIs(np, /Teléfono verificado/);
await np.waitForFunction(() => S.user.registered && S.loans.length > 0, null, { timeout: 15000 });
await nctx.close();
console.log('✓ teléfono nuevo: tras la contraseña pide el código del correo; el mismo teléfono entra sin código');

// ---------- 9. el cliente entra con la contraseña nueva ----------
const cp2 = await cctx.newPage(); watch(cp2, 'cliente2');
await cp2.goto(BASE + '/');
await cp2.waitForSelector('[data-a=profile]');
await cp2.evaluate(() => A.authLogout());
await cp2.waitForSelector('[data-a=clientLogin]');
await cp2.fill('#clCI', 'v12345678'); await cp2.fill('#clPass', 'clave-nueva-99');
await cp2.click('[data-a=clientLogin]');
await toastIs(cp2, /Sesión iniciada/);
console.log('✓ el cliente entra con la contraseña restablecida');

assert.deepEqual(pageErrors, [], 'sin errores de JavaScript en las páginas');
console.log('\nE2E OK');
await browser.close(); server.close();
