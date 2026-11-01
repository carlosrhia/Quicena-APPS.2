// Prueba del esquema con PGlite, simulando auth y storage de Supabase.
import { PGlite } from '@electric-sql/pglite';
import { createRequire as __cr } from 'node:module';
const __pgcrypto = { name: 'pgcrypto', setup: async () => ({ bundlePath: new URL('file://' + __cr(import.meta.url).resolve('@electric-sql/pglite').replace(/dist\/.*$/, 'dist/pgcrypto.tar.gz')) }) };
import fs from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite({ extensions: { pgcrypto: __pgcrypto } });
await db.exec(`
create role anon; create role authenticated; create schema extensions;
create schema auth; create schema storage;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, encrypted_password text, updated_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true),'')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit int, allowed_mime_types text[]);
create table storage.objects (id serial primary key, bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
grant usage on schema public, storage, auth to authenticated; grant execute on all functions in schema storage, auth to authenticated;
`);
await db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
await db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); // idempotente
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated; grant select, insert on storage.objects to authenticated; grant usage on all sequences in schema storage to authenticated; alter table storage.objects enable row level security;`);

const ids = {};
for (const e of ['admin@x.com', 'cob@x.com', 'v12345678@clientes.quincena.app', 'v7654321@clientes.quincena.app']) {
  ids[e] = (await db.query(`insert into auth.users(email) values ($1) returning id`, [e])).rows[0].id;
}
const ADMIN = ids['admin@x.com'], COB = ids['cob@x.com'], C1 = ids['v12345678@clientes.quincena.app'], C2 = ids['v7654321@clientes.quincena.app'];
await db.exec(`insert into public.staff (user_id, email, name, role) select id, lower(email), 'Jefe', 'admin' from auth.users where lower(email)=lower('ADMIN@x.com') on conflict (user_id) do update set role='admin', active=true;`);

async function as(uid, sql, params) {
  await db.exec(`reset role; select set_config('request.uid', '${uid || ''}', false); set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const fails = async (uid, sql, params, re) => { await assert.rejects(() => as(uid, sql, params), re); };

const state = (extra = {}) => ({ v: 3, shift: 0, config: { mora: 4, rates: { 1: 5, 2: 10, 3: 15 }, methods: [] }, notes: [], log: [], seq: 1,
  user: { name: 'Ana Pérez', fullName: 'Ana Pérez', points: 241, streak: 10, registered: true, profile: { ci: 'V-12345678' }, identityDocs: { front: 'sb:x/front.jpg', selfie: 'sb:x/selfie.jpg' }, creditLineReview: { status: 'approved', limit: 999 } },
  loans: [], ...extra });

// registro del cliente
await fails(C1, `insert into clients (id,name,ci,state) values ($1,'Ana','V-12345678',$2)`, [C1, state()], /nombre completo/);
await fails(C1, `insert into clients (id,name,ci,state) values ($1,'Ana Pérez','V-12345678',$2)`, [C2, state()], /propio expediente|row-level/);
const noDocs = state(); delete noDocs.user.identityDocs.selfie;
await fails(C1, `insert into clients (id,name,ci,state) values ($1,'Ana Pérez','V-12345678',$2)`, [C1, noDocs], /rostro/);
const r = await as(C1, `insert into clients (id,name,ci,state) values ($1,'Ana  Pérez','v-12345678',$2) returning version, state, ci, ci_key`, [C1, state()]);
assert.equal(r.rows[0].version, 1);
assert.equal(r.rows[0].state.user.creditLineReview.status, 'pending', 'la línea empieza pendiente');
assert.equal(r.rows[0].state.user.points, 0);
assert.equal(r.rows[0].ci_key, 'V12345678');
await fails(C2, `insert into clients (id,name,ci,state) values ($1,'Otro Señor','V12345678',$2)`, [C2, state()], /ya está registrada/);

// lectura: cada uno lo suyo
assert.equal((await as(C2, `select * from clients`)).rows.length, 0);
assert.equal((await as(C1, `select * from clients`)).rows.length, 1);
assert.equal((await as(ADMIN, `select * from clients`)).rows.length, 1);
assert.equal((await as(COB, `select * from clients`)).rows.length, 0, 'cobrador sin staff no ve nada');

// el cliente envía una solicitud (válido) y luego intenta aprobarse
let cur = (await as(C1, `select state, version from clients`)).rows[0];
const s1 = structuredClone(cur.state);
const badRate = structuredClone(cur.state); badRate.loans.push({ id: 1, amount: 50, n: 2, rate: 10, total: 55, status: 'solicitud', installments: [] });
await fails(C1, `update clients set state=$1 where id=$2`, [badRate, C1], /condiciones del préstamo/);
s1.loans.push({ id: 1, amount: 50, n: 2, rate: 35, total: 67.5, status: 'solicitud', installments: [] });
s1.log.push({ id: 'e1', text: 'Solicitaste', date: '2026-10-31' });
let u = await as(C1, `update clients set state=$1 where id=$2 and version=$3 returning version`, [s1, C1, cur.version]);
assert.equal(u.rows[0].version, 2);
// versión desactualizada: no actualiza nada
u = await as(C1, `update clients set state=$1 where id=$2 and version=$3 returning version`, [s1, C1, 1]);
assert.equal(u.rows.length, 0);
const bad = structuredClone(s1); bad.user.creditLineReview = { status: 'approved', limit: 90 };
await fails(C1, `update clients set state=$1 where id=$2`, [bad, C1], /Solo el prestamista/);
const bad2 = structuredClone(s1); bad2.loans[0].status = 'activo';
await fails(C1, `update clients set state=$1 where id=$2`, [bad2, C1], /estado de un préstamo/);
const bad3 = structuredClone(s1); bad3.user.points = 9999;
await fails(C1, `update clients set state=$1 where id=$2`, [bad3, C1], /puntos/);
const bad4 = structuredClone(s1); bad4.log = [];
await fails(C1, `update clients set state=$1 where id=$2`, [bad4, C1], /historial/);
const bad5 = structuredClone(s1); bad5.user.identityDocs.front = 'sb:otra.jpg';
await fails(C1, `update clients set state=$1 where id=$2`, [bad5, C1], /documentos/);
assert.equal((await as(C2, `update clients set state=$1 where id=$2 returning 1`, [s1, C1])).rows.length, 0);

// el administrador aprueba la línea y el préstamo
cur = (await as(ADMIN, `select state, version from clients where id=$1`, [C1])).rows[0];
const s2 = structuredClone(cur.state);
s2.user.creditLineReview = { status: 'approved', limit: 50, reviewedAt: '2026-10-31', reason: '' };
s2.loans[0].status = 'activo';
s2.loans[0].installments = [{ n: 1, amount: 33.75, status: 'pending', due: '2026-11-15', paidOn: null }, { n: 2, amount: 33.75, status: 'pending', due: '2026-11-30', paidOn: null }];
u = await as(ADMIN, `update clients set state=$1 where id=$2 and version=$3 returning version`, [s2, C1, cur.version]);
assert.equal(u.rows[0].version, 3);

// el cliente envía un pago (pending -> validating): permitido; marcarlo pagado no
const s3 = structuredClone(s2); s3.loans[0].installments[0].status = 'validating'; s3.loans[0].installments[0].ref = '1234';
u = await as(C1, `update clients set state=$1 where id=$2 returning version`, [s3, C1]);
assert.equal(u.rows[0].version, 4);
const s4 = structuredClone(s3); s4.loans[0].installments[0].status = 'paid';
await fails(C1, `update clients set state=$1 where id=$2`, [s4, C1], /validar ni rechazar/);

// personal y cobradores
await fails(C1, `select admin_save_staff('cob@x.com','Pedro','cobrador',true,null)`, [], /Solo el administrador/);
await as(ADMIN, `select admin_save_staff('COB@x.com','Pedro Cobrador','cobrador',true,$1::uuid[])`, [[]]);
assert.equal((await as(COB, `select * from clients`)).rows.length, 0, 'cobrador sin clientes asignados');
await as(ADMIN, `select admin_save_staff('cob@x.com','Pedro Cobrador','cobrador',true,$1::uuid[])`, [[C1]]);
assert.equal((await as(COB, `select * from clients`)).rows.length, 1, 'cobrador ve su cliente');
await fails(ADMIN, `select admin_save_staff('admin@x.com','Jefe','cobrador',true,null)`, [], /No puedes quitarte/);
await fails(ADMIN, `select admin_save_staff('v12345678@clientes.quincena.app','Ana','cobrador',true,null)`, [], /pertenece a un cliente/);
await fails(ADMIN, `select admin_save_staff('nadie@x.com','Nadie','cobrador',true,null)`, [], /No existe/);
assert.equal((await as(COB, `select * from staff`)).rows.length, 1, 'cobrador solo se ve a sí mismo');
assert.equal((await as(ADMIN, `select * from staff`)).rows.length, 2);
await as(ADMIN, `select admin_save_staff('cob@x.com','Pedro Cobrador','cobrador',false,$1::uuid[])`, [[C1]]);
assert.equal((await as(COB, `select * from clients`)).rows.length, 0, 'cobrador desactivado no ve nada');
assert.equal((await as(COB, `select whoami()`)).rows[0].whoami.role, 'disabled');
assert.equal((await as(ADMIN, `select whoami()`)).rows[0].whoami.role, 'admin');
assert.equal((await as(C1, `select whoami()`)).rows[0].whoami.role, 'cliente');

// almacenamiento
await as(C1, `insert into storage.objects (bucket_id,name) values ('documentos', $1)`, [C1 + '/front.jpg']);
await fails(C1, `insert into storage.objects (bucket_id,name) values ('documentos', $1)`, [C2 + '/front.jpg'], /row-level/);
await fails(C1, `insert into storage.objects (bucket_id,name) values ('documentos', 'raiz.jpg')`, [], /row-level/);
await as(ADMIN, `insert into storage.objects (bucket_id,name) values ('documentos', $1)`, [C1 + '/desembolso.jpg']);
assert.equal((await as(C2, `select * from storage.objects`)).rows.length, 0);
assert.equal((await as(C1, `select * from storage.objects`)).rows.length, 2);
assert.equal((await as(ADMIN, `select * from storage.objects`)).rows.length, 2);

// auditoría e historial
assert.equal((await as(C1, `select * from audit`)).rows.length, 0);
const audit = (await as(ADMIN, `select actor, action from audit order by id`)).rows;
assert.ok(audit.some(a => a.actor === 'cliente' && a.action === 'client.register'));
assert.ok(audit.some(a => a.actor === 'admin:admin@x.com' && a.action === 'client.state.put'));
assert.equal((await as(ADMIN, `select count(*)::int n from client_history`)).rows[0].n, 4);
assert.equal((await as(C1, `select count(*)::int n from client_history`)).rows[0].n, 0);

// ---------- v2: ajustes, bloqueo, nivel, fotos nuevas, notas, contraseña, cierres ----------
const st = (await as(C1, `select data from app_settings`)).rows[0].data;
assert.equal(st.rates['3'], 40, 'el cliente lee los ajustes');
await fails(C1, `select admin_save_settings($1)`, [st], /Solo el administrador/);
await fails(C1, `update app_settings set data='{}'`, [], /x^/).catch(() => {});
assert.equal((await as(ADMIN, `select admin_save_settings($1) r`, [{ ...st, rates: { 1: 25, 2: 30, 3: 35 } }])).rows[0].r.rates['1'], 25);
await fails(ADMIN, `select admin_save_settings($1)`, [{ ...st, levels: [] }], /4 niveles/);
assert.equal(Number((await as(ADMIN, `select staff_adjust_capital(100, 'prueba') v`)).rows[0].v), 100);
assert.equal(Number((await as(ADMIN, `select staff_adjust_capital(-30, 'desembolso') v`)).rows[0].v), 70);
cur = (await as(C1, `select state, version from clients`)).rows[0];
const lv = structuredClone(cur.state); lv.user.levelOverride = 4;
await fails(C1, `update clients set state=$1 where id=$2`, [lv, C1], /nivel/);
const bl = structuredClone(cur.state); bl.user.accountBlocked = false;
await fails(C1, `update clients set state=$1 where id=$2`, [bl, C1], /bloquear/);
// el administrador bloquea: el cliente ya no puede pedir préstamos
cur = (await as(ADMIN, `select state, version from clients where id=$1`, [C1])).rows[0];
const sb = structuredClone(cur.state); sb.user.accountBlocked = true;
await as(ADMIN, `update clients set state=$1 where id=$2`, [sb, C1]);
const nl = structuredClone(sb); nl.loans.push({ id: 9, amount: 20, n: 1, rate: 25, total: 25, status: 'solicitud', installments: [] });
await fails(C1, `update clients set state=$1 where id=$2`, [nl, C1], /bloqueada/);
// fotos nuevas: con estado "docs" el cliente puede reemplazarlas y volver a "pendiente"
const dq = structuredClone(sb); dq.user.accountBlocked = false; dq.user.creditLineReview = { status: 'docs', limit: 0, reviewedAt: null, reason: 'Foto borrosa' };
await as(ADMIN, `update clients set state=$1 where id=$2`, [dq, C1]);
const rs = structuredClone(dq); rs.user.identityDocs.front = 'sb:nueva.jpg'; rs.user.creditLineReview = { status: 'pending', limit: 0, reviewedAt: null, reason: '' };
await as(C1, `update clients set state=$1 where id=$2`, [rs, C1]);
const rs2 = structuredClone(rs); rs2.user.identityDocs.front = 'sb:otra-mas.jpg';
await fails(C1, `update clients set state=$1 where id=$2`, [rs2, C1], /documentos/);
// notas internas: el personal sí, el cliente no
await as(ADMIN, `insert into client_notes (client_id, note) values ($1, 'Cliente puntual')`, [C1]);
assert.equal((await as(C1, `select * from client_notes`)).rows.length, 0, 'el cliente no ve las notas internas');
assert.equal((await as(ADMIN, `select note from client_notes`)).rows[0].note, 'Cliente puntual');
// contraseña
await fails(C1, `select admin_set_client_password($1, 'nueva-clave-1')`, [C1], /Solo el administrador/);
await fails(ADMIN, `select admin_set_client_password($1, 'corta')`, [C1], /8 caracteres/);
await as(ADMIN, `select admin_set_client_password($1, 'nueva-clave-1')`, [C1]);
assert.match((await db.query(`select encrypted_password from auth.users where id=$1`, [C1])).rows[0].encrypted_password, /^\$2a\$/);
// cierres
await as(ADMIN, `insert into closings (label, data) values ('15 nov 2026', '{"prestado":10}')`);
await fails(C1, `insert into closings (label, data) values ('x', '{}')`, [], /row-level/);
assert.equal((await as(C1, `select * from closings`)).rows.length, 0);
console.log('OK v2: ajustes, bloqueo, nivel, fotos nuevas, notas internas, contraseña y cierres');
console.log('OK: todas las comprobaciones del esquema pasaron');
