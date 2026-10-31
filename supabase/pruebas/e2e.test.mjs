// Prueba de extremo a extremo: Chromium real + app + panel + esquema SQL real (PGlite) tras un Supabase simulado.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated;
create schema auth; create schema storage;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, pass text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true),'')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit int, allowed_mime_types text[]);
create table storage.objects (id serial primary key, bucket_id text, name text unique, data text);
create function storage.foldername(name text) returns text[] language sql as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
grant usage on schema public, storage, auth to authenticated; grant execute on all functions in schema storage, auth to authenticated;
`);
await db.exec(fs.readFileSync(ROOT + '/supabase/schema.sql', 'utf8'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated; grant select, insert on storage.objects to authenticated; grant usage on all sequences in schema storage to authenticated; alter table storage.objects enable row level security;`);

let lock = Promise.resolve();
const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
async function as(uid, sql, params) {
  await db.exec(`reset role; select set_config('request.uid', '${uid || ''}', false); set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const ident = (s) => { if (!/^[a-z_]+$/.test(s)) throw new Error('ident ' + s); return s; };
const colList = (c) => (c === '*' ? '*' : c.split(',').map((x) => ident(x.trim())).join(','));
const sess = (u) => ({ access_token: u.id, user: { id: u.id, email: u.email } });
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
      const u = (await db.query('select id,email from auth.users where email=$1 and pass=$2', [m.email.toLowerCase(), m.password])).rows[0];
      return u ? { data: { user: { id: u.id }, session: sess(u) }, error: null } : { data: null, error: { message: 'Invalid login credentials' } };
    }
    if (m.kind === 'updateUser') { await db.query('update auth.users set pass=$1 where id=$2', [m.password, m.uid]); return { data: {}, error: null }; }
    if (m.kind === 'upload') { await as(m.uid, 'insert into storage.objects(bucket_id,name,data) values ($1,$2,$3)', [m.bucket, m.path, m.data]); return { data: { path: m.path }, error: null }; }
    if (m.kind === 'signed') {
      const r = await as(m.uid, 'select data from storage.objects where bucket_id=$1 and name=$2', [m.bucket, m.path]);
      return r.rows.length ? { data: { signedUrl: r.rows[0].data }, error: null } : { data: null, error: { message: 'Object not found' } };
    }
    if (m.kind === 'rpc') {
      const keys = Object.keys(m.args);
      const vals = keys.map((k) => m.args[k]);
      const sql = `select public.${ident(m.name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}${Array.isArray(m.args[k]) ? '::uuid[]' : ''}`).join(',')}) as r`;
      const r = await as(m.uid, sql, vals);
      return { data: r.rows[0].r, error: null };
    }
    if (m.kind === 'query') {
      const params = []; const p = (v) => { params.push(v); return '$' + params.length; };
      const where = m.f.length ? ' where ' + m.f.map(([c, op, v]) => `${ident(c)} ${op} ${p(v)}`).join(' and ') : '';
      let sql;
      if (m.op === 'select') sql = `select ${colList(m.cols)} from public.${ident(m.t)}${where}${m.ord.length ? ' order by ' + m.ord.map(([c, d]) => ident(c) + ' ' + d).join(',') : ''}${m.lim ? ' limit ' + Number(m.lim) : ''}`;
      if (m.op === 'update') { const sets = Object.entries(m.payload).map(([k, v]) => `${ident(k)} = ${p(v)}`); sql = `update public.${ident(m.t)} set ${sets.join(',')}${where} returning ${colList(m.ret || '*')}`; }
      if (m.op === 'insert') { const ks = Object.keys(m.payload); sql = `insert into public.${ident(m.t)} (${ks.map(ident).join(',')}) values (${ks.map((k) => p(m.payload[k])).join(',')}) returning ${colList(m.ret || '*')}`; }
      const rows = (await as(m.uid, sql, params)).rows;
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
const watch = (pg, name) => { pg.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message)); pg.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Documentos ilegibles' : undefined)); };
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
await cp.setInputFiles('#suFront', png);
await cp.setInputFiles('#suSelfie', png);
await cp.click('[data-a=signupSave]');
await cp.waitForFunction(() => document.querySelector('#toast') && /Cuenta creada/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
let row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.name, 'Ana María Pérez'); assert.equal(row.ci, 'V-12345678');
assert.match(row.state.user.identityDocs.front, /^sb:[0-9a-f-]{36}\/front-/); assert.match(row.state.user.identityDocs.selfie, /^sb:/);
assert.equal(row.state.user.creditLineReview.status, 'pending');
assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n, 2);
assert.equal((await db.query(`select email from auth.users`)).rows[0].email, 'v12345678@clientes.quincena.app');
console.log('✓ registro del cliente: cuenta, 2 fotos privadas y expediente con línea pendiente');

// ---------- 2. el administrador entra al panel ----------
const admin = (await db.query(`insert into auth.users(email,pass) values ('jefe@quincena.app','admin-clave-1') returning id`)).rows[0].id;
await db.query(`insert into public.staff (user_id, email, name, role) select id, lower(email), 'Carlos Jefe', 'admin' from auth.users where lower(email) = lower('JEFE@quincena.app') on conflict (user_id) do update set role = 'admin', active = true`);
const actx = await newCtx({ width: 1300, height: 900 });
const ap = await actx.newPage(); watch(ap, 'admin');
await ap.goto(BASE + '/admin.html');
await ap.fill('#email', 'jefe@quincena.app'); await ap.fill('#password', 'mala-clave');
await ap.click('#loginForm button[type=submit]');
await ap.waitForFunction(() => /incorrectos/.test(document.querySelector('#loginErr').textContent));
// el cliente no puede entrar al panel
await ap.fill('#email', 'v12345678@clientes.quincena.app'); await ap.fill('#password', 'clave-segura-1');
await ap.click('#loginForm button[type=submit]');
await ap.waitForFunction(() => /cuenta de cliente/.test(document.querySelector('#loginErr').textContent));
await ap.fill('#email', 'jefe@quincena.app'); await ap.fill('#password', 'admin-clave-1');
await ap.click('#loginForm button[type=submit]');
await ap.waitForSelector('#adminView:not(.hidden)');
await ap.waitForSelector('[data-client]');
assert.match(await ap.textContent('#clientList'), /Ana María Pérez/);
await ap.waitForSelector('#detailPane img[data-loaded="1"]');
assert.equal(await ap.locator('#detailPane img[data-loaded="1"]').count(), 2, 'cédula y rostro visibles');
await ap.screenshot({ path: SHOT + 'admin-expediente.png', fullPage: false });
console.log('✓ login del administrador (y rechazo de credenciales malas y de cuentas de cliente)');

// ---------- 3. aprueba la línea ----------
await ap.fill('#creditLimit', '50');
await ap.click('[data-act=approve-credit]');
await ap.waitForFunction(() => /Línea de crédito aprobada/.test(document.querySelector('#toast').textContent));
row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.state.user.creditLineReview.status, 'approved'); assert.equal(row.state.user.creditLineReview.limit, 50);
console.log('✓ línea de crédito aprobada desde el panel');

// ---------- 4. el cliente recibe la aprobación y solicita un préstamo ----------
await cp.reload();
await cp.waitForFunction(() => window.document.querySelector('[data-a=request]'), null, { timeout: 15000 });
if (await cp.locator('[data-a=tutorialNext]').count()) { for (let i = 0; i < 8 && await cp.locator('[data-a=tutorialNext]').count(); i++) await cp.click('[data-a=tutorialNext]'); }
await cp.click('[data-a=request]');
await cp.fill('#pmBank', 'Banesco'); await cp.fill('#pmPhone', '0414-1234567'); await cp.fill('#pmCI', 'V-12345678');
await cp.click('[data-a=rnext]');
await cp.click('[data-a=rsend]');
await cp.waitForFunction(() => /Solicitud enviada/.test(document.querySelector('#toast').textContent));
await cp.waitForTimeout(1200);
row = (await db.query('select * from public.clients')).rows[0];
const req = row.state.loans.find((l) => l.status === 'solicitud');
assert.ok(req, 'la solicitud quedó guardada en Supabase');
console.log('✓ solicitud de préstamo guardada en Supabase: $' + req.amount + ' en ' + req.n + ' cuota(s)');

// ---------- 5. el administrador la ve y la confirma ----------
await ap.click('#refreshBtn');
await ap.waitForSelector('[data-act=approve-loan]');
assert.match(await ap.textContent('#summary'), /Préstamos por aprobar\s*1/);
await ap.fill('[data-ref-loan]', '00123456');
await ap.setInputFiles('[data-file-loan]', png);
await ap.click('[data-act=approve-loan]');
await ap.waitForFunction(() => /Préstamo confirmado/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
row = (await db.query('select * from public.clients')).rows[0];
const loan = row.state.loans.find((l) => l.id === req.id);
assert.equal(loan.status, 'activo'); assert.equal(loan.installments.length, req.n); assert.match(loan.desembolso.proofData, /^sb:/);
console.log('✓ préstamo confirmado: cuotas generadas y comprobante de desembolso privado');

// ---------- 6. el cliente ve el préstamo activo (sondeo cada 8 s) ----------
await cp.waitForFunction(() => S.loans.some((l) => l.status === 'activo') && !/En revisión/.test(document.querySelector('#app').innerText), null, { timeout: 25000 });
await cp.screenshot({ path: SHOT + 'cliente-prestamo.png' });
console.log('✓ el cliente recibe el préstamo aprobado sin recargar');

// ---------- 6b. el cliente paga la cuota 1 y el administrador la valida ----------
await cp.click('[data-a=payOptions]');
await cp.click('[data-a=payFull]');
await cp.fill('#ref', '778899');
await cp.setInputFiles('#proof', png);
await cp.click('[data-a=psend]');
await cp.waitForFunction(() => S.loans.some((l) => (l.installments || []).some((i) => i.status === 'validating')), null, { timeout: 10000 });
await cp.waitForTimeout(1200);
row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.state.loans.find((l) => l.id === req.id).installments[0].status, 'validating', 'pago enviado a Supabase');
assert.match(row.state.loans.find((l) => l.id === req.id).installments[0].proofData, /^sb:/);
await ap.click('#refreshBtn');
await ap.waitForSelector('[data-act=approve-payment]');
assert.match(await ap.textContent('#summary'), /Pagos por validar\s*1/);
await ap.click('[data-act=approve-payment]');
await ap.waitForFunction(() => /Pago validado/.test(document.querySelector('#toast').textContent));
row = (await db.query('select * from public.clients')).rows[0];
assert.equal(row.state.loans.find((l) => l.id === req.id).installments[0].status, 'paid');
assert.equal(row.state.user.points, 10);
await cp.waitForFunction(() => S.loans.some((l) => (l.installments || []).some((i) => i.status === 'paid')), null, { timeout: 25000 });
console.log('✓ pago con captura privada → validado en el panel → el cliente lo ve pagado (+10 puntos)');

// ---------- 7. cobrador ----------
await ap.click('[data-tab=users]');
await ap.waitForSelector('#userForm');
await ap.fill('#uName', 'Pedro Cobrador'); await ap.fill('#uEmail', 'pedro@quincena.app'); await ap.fill('#uPass', 'cobrador-1');
await ap.selectOption('#uRole', 'cobrador');
await ap.click('#uClients input[type=checkbox]');
await ap.click('#userForm button[type=submit]');
await ap.waitForFunction(() => /Usuario creado/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
assert.match(await ap.textContent('#tabUsers'), /pedro@quincena.app/);
await ap.click('[data-tab=audit]');
await ap.waitForFunction(() => /staff\.auth\.ok/.test(document.querySelector('#tabAudit').textContent));
const kctx = await newCtx({ width: 1300, height: 900 });
const kp = await kctx.newPage(); watch(kp, 'cobrador');
await kp.goto(BASE + '/admin.html');
await kp.fill('#email', 'pedro@quincena.app'); await kp.fill('#password', 'cobrador-1');
await kp.click('#loginForm button[type=submit]');
await kp.waitForSelector('[data-client]');
assert.equal(await kp.locator('#btnUsers').isHidden(), true, 'el cobrador no ve la gestión de usuarios');
console.log('✓ alta de cobrador desde el panel; entra y solo ve su cliente; auditoría visible');

// ---------- 8. sesión persistente del cliente y cierre de sesión ----------
const cp2 = await cctx.newPage(); watch(cp2, 'cliente2');
await cp2.goto(BASE + '/');
await cp2.waitForSelector('[data-a=profile]');
await cp2.waitForTimeout(800);
assert.equal(await cp2.locator('[data-a=clientLogin]').count(), 0, 'con sesión guardada no se vuelve a pedir la contraseña');
await cp2.evaluate(() => A.authLogout());
await cp2.waitForSelector('[data-a=clientLogin]');
await cp2.fill('#clCI', 'v12345678'); await cp2.fill('#clPass', 'clave-segura-1');
await cp2.click('[data-a=clientLogin]');
await cp2.waitForFunction(() => /Sesión iniciada/.test(document.querySelector('#toast').textContent));
console.log('✓ cierre de sesión e inicio con cédula + contraseña');

assert.deepEqual(pageErrors, [], 'sin errores de JavaScript en las páginas');
console.log('\nE2E OK');
await browser.close(); server.close();
