'use strict';
/*
 * Quincena — servidor base
 * - Sin dependencias: solo Node >= 22.13 (usa node:sqlite, http y crypto integrados)
 * - Guarda el estado de la app (con versiones), las capturas de pago como archivos y un registro de auditoría
 * - Sirve la propia app en "/" para que todo viva en un mismo sitio
 * - Cuentas con roles: administrador (todo), cobrador (solo sus clientes) y cliente (su expediente)
 *
 *   ADMIN_USERNAME=... ADMIN_PASSWORD=... CLIENT_KEY=... node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------- configuración ---------- */
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Cuenta de arranque: solo se usa para crear el primer administrador en la base de datos.
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const CLIENT_KEY = String(process.env.CLIENT_KEY || 'cartera-2026-x7k');
const ORIGINS = String(process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_STATE = 8 * 1024 * 1024;
const MAX_IMG = 4 * 1024 * 1024;
const CLIENT_TTL = 30 * 24 * 3600; // 30 días
const LENDER_TTL = 12 * 3600;      // 12 horas (administrador y cobrador)
const MIN_PASS = 8;                // contraseña mínima de las cuentas creadas desde el panel
const ROLES = ['admin', 'cobrador'];

if (ADMIN_USERNAME && ADMIN_USERNAME.length < 3) {
  console.error('ADMIN_USERNAME debe tener al menos 3 caracteres.');
  process.exit(1);
}
if (ADMIN_USERNAME && ADMIN_PASSWORD.length < 16) {
  console.error('ADMIN_PASSWORD (contraseña de arranque) debe tener al menos 16 caracteres.');
  process.exit(1);
}
if (!CLIENT_KEY) console.warn('Aviso: CLIENT_KEY está vacío; cualquiera que conozca la dirección podrá entrar como cliente. Define CLIENT_KEY en producción.');

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true, mode: 0o700 });
let SECRET = process.env.TOKEN_SECRET || '';
if (!SECRET) {
  const f = path.join(DATA_DIR, 'secret.key');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

/* ---------- base de datos ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'quincena.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS state_history (
    version INTEGER PRIMARY KEY,
    json TEXT NOT NULL,
    role TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ci TEXT NOT NULL,
    ci_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_state_history (
    client_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    role TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (client_id, version)
  );
  CREATE TABLE IF NOT EXISTS uploads (
    name TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    mime TEXT NOT NULL,
    role TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    role TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','cobrador')),
    pass_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assignments (
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS assignments_client ON assignments (client_id);
`);
const q = {
  getState: db.prepare('SELECT version, json, updated_at FROM app_state WHERE id = 1'),
  getClient: db.prepare('SELECT id, name, ci, ci_key, created_at, version, json, updated_at FROM clients WHERE id = ?'),
  getClientByCi: db.prepare('SELECT id, name, ci, ci_key, created_at, version, json, updated_at FROM clients WHERE ci_key = ?'),
  listClients: db.prepare('SELECT id, name, ci, created_at, version, json, updated_at FROM clients ORDER BY created_at DESC'),
  insertClient: db.prepare('INSERT INTO clients (id,name,ci,ci_key,created_at,version,json,updated_at) VALUES (?,?,?,?,?,?,?,?)'),
  updateClient: db.prepare('UPDATE clients SET name=?, ci=?, version=?, json=?, updated_at=? WHERE id=?'),
  addClientHistory: db.prepare('INSERT OR REPLACE INTO client_state_history (client_id,version,json,role,created_at) VALUES (?,?,?,?,?)'),
  upsertState: db.prepare(`INSERT INTO app_state (id, version, json, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  addHistory: db.prepare('INSERT INTO state_history (version, json, role, created_at) VALUES (?, ?, ?, ?)'),
  pruneHistory: db.prepare('DELETE FROM state_history WHERE version <= ?'),
  addUpload: db.prepare('INSERT INTO uploads (name, bytes, mime, role, created_at) VALUES (?, ?, ?, ?, ?)'),
  getUpload: db.prepare('SELECT mime FROM uploads WHERE name = ?'),
  addAudit: db.prepare('INSERT INTO audit (ts, role, ip, action, detail) VALUES (?, ?, ?, ?, ?)'),
  listAudit: db.prepare('SELECT id, ts, role, ip, action, detail FROM audit ORDER BY id DESC LIMIT ?'),
  // cuentas con rol (administrador y cobrador)
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT id, username, name, role, active, created_at, updated_at, last_login FROM users ORDER BY role, name'),
  insertUser: db.prepare('INSERT INTO users (id,username,name,role,pass_hash,active,created_at,updated_at,last_login) VALUES (?,?,?,?,?,1,?,?,NULL)'),
  updateUser: db.prepare('UPDATE users SET name=?, role=?, active=?, updated_at=? WHERE id=?'),
  setPass: db.prepare('UPDATE users SET pass_hash=?, updated_at=? WHERE id=?'),
  touchLogin: db.prepare('UPDATE users SET last_login=? WHERE id=?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id=?'),
  addSession: db.prepare('INSERT INTO sessions (jti,user_id,created_at,expires_at) VALUES (?,?,?,?)'),
  getSession: db.prepare('SELECT jti, user_id, expires_at FROM sessions WHERE jti = ?'),
  dropSession: db.prepare('DELETE FROM sessions WHERE jti = ?'),
  dropUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  dropUserSessionsBut: db.prepare('DELETE FROM sessions WHERE user_id = ? AND jti <> ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  listAssignments: db.prepare('SELECT client_id FROM assignments WHERE user_id = ?'),
  addAssignment: db.prepare('INSERT OR IGNORE INTO assignments (user_id, client_id, created_at) VALUES (?,?,?)'),
  dropAssignment: db.prepare('DELETE FROM assignments WHERE user_id = ? AND client_id = ?'),
  dropAssignmentsOf: db.prepare('DELETE FROM assignments WHERE user_id = ?'),
  isAssigned: db.prepare('SELECT 1 AS ok FROM assignments WHERE user_id = ? AND client_id = ?'),
  cobradorsOf: db.prepare('SELECT user_id FROM assignments WHERE client_id = ?'),
};
const nowIso = () => new Date().toISOString();
const audit = (role, ip, action, detail) => { try { q.addAudit.run(nowIso(), role || null, ip || null, action, detail ? String(detail).slice(0, 300) : null); } catch (e) { /* la auditoría nunca debe tumbar una petición */ } };
/* La auditoría guarda quién hizo cada cosa: "admin:ana", "cobrador:pedro", "cliente". */
const actor = (claims) => (!claims ? null : claims.r === 'cliente' ? 'cliente' : claims.r + ':' + (claims.n || claims.u || ''));
const actorAudit = (claims, ip, action, detail) => audit(actor(claims), ip, action, detail);

/* ---------- cuentas con rol: contraseñas con scrypt y sesiones revocables ---------- */
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}
function checkPass(pass, stored) {
  try {
    const [kind, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const got = crypto.scryptSync(String(pass), salt, 64);
    const want = Buffer.from(hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}
function publicUser(row) {
  return { id: row.id, username: row.username, name: row.name, role: row.role, active: !!row.active, createdAt: row.created_at, updatedAt: row.updated_at, lastLogin: row.last_login || null, clients: q.listAssignments.all(row.id).map((r) => r.client_id) };
}
const normUser = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
function findUser(username) {
  const u = normUser(username);
  if (!u) return null;
  return q.userByName.get(u) || q.userByName.get(String(username || '').trim()) || null;
}
/* Crea el administrador de arranque una sola vez, a partir de las variables de entorno. */
(function seedAdmin() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    if (q.listUsers.all().filter((u) => u.role === 'admin').length === 0) console.warn('Aviso: no hay ningún administrador. Define ADMIN_USERNAME y ADMIN_PASSWORD (mín. 16 caracteres) o usa scripts/create-admin.js.');
    return;
  }
  if (findUser(ADMIN_USERNAME)) return;
  const ts = nowIso();
  q.insertUser.run(crypto.randomUUID(), normUser(ADMIN_USERNAME), 'Administrador', 'admin', hashPass(ADMIN_PASSWORD), ts, ts);
  console.log('Administrador inicial creado: ' + normUser(ADMIN_USERNAME));
})();
q.pruneSessions.run(Math.floor(Date.now() / 1000));

/* ---------- tokens firmados (HMAC) ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
function sign(role, ttl, clientId = null, userId = null, username = null) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const jti = crypto.randomBytes(9).toString('hex');
  const p = Buffer.from(JSON.stringify({ r: role, e: exp, jti, ...(clientId ? { cid: clientId } : {}), ...(userId ? { u: userId } : {}), ...(username ? { n: username } : {}) })).toString('base64url');
  if (role === 'admin' || role === 'cobrador') q.addSession.run(jti, userId, nowIso(), exp);
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function verify(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [p, s] = tok.split('.');
  if (!p || !s) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!d || d.e < Math.floor(Date.now() / 1000)) return null;
    if (!(d.r === 'cliente' || d.r === 'admin' || d.r === 'cobrador')) return null;
    // Las sesiones del personal se pueden revocar al instante (baja, cambio de contraseña o de rol).
    if (d.r === 'admin' || d.r === 'cobrador') {
      const s = d.jti && q.getSession.get(d.jti);
      if (!s || s.user_id !== d.u) return null;
    }
    return d;
  } catch (e) { return null; }
}

/* ---------- límite de intentos fallidos (por IP) ---------- */
const fails = new Map();
const WINDOW = 15 * 60e3, MAX_FAILS = 5;
const blockedIp = (ip) => { const f = fails.get(ip); return !!f && f.n >= MAX_FAILS && Date.now() - f.t < WINDOW; };
const failIp = (ip) => { const f = fails.get(ip); if (!f || Date.now() - f.t >= WINDOW) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; };
setInterval(() => { for (const [ip, f] of fails) if (Date.now() - f.t >= WINDOW) fails.delete(ip); }, 60e3).unref();
const uploadsByIp = new Map();
function uploadAllowed(ip) { // 60 capturas por hora y por IP
  const now = Date.now(), a = (uploadsByIp.get(ip) || []).filter((t) => now - t < 3600e3);
  if (a.length >= 60) { uploadsByIp.set(ip, a); return false; }
  a.push(now); uploadsByIp.set(ip, a); return true;
}

/* ---------- utilidades HTTP ---------- */
const ipOf = (req) => (TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
function send(res, code, obj, extra) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}
function setCors(req, res) {
  const o = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}
const authClaims = (req) => {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? verify(h.slice(7)) : null;
};
const authRole = (req) => { const c = authClaims(req); return c ? c.r : null; };
const authClientId = (req) => { const c = authClaims(req); return c && c.r === 'cliente' ? (c.cid || null) : null; };
/* El personal es administrador o cobrador; el cobrador solo ve los expedientes que tiene asignados. */
const isStaff = (c) => !!c && (c.r === 'admin' || c.r === 'cobrador');
function canSeeClient(claims, clientId) {
  if (!isStaff(claims) || !clientId) return false;
  if (claims.r === 'admin') return true;
  return !!q.isAssigned.get(claims.u, clientId);
}
const ciKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function clientSummary(row) {
  let state = {}; try { state = JSON.parse(row.json || '{}'); } catch (_) {}
  const u = state.user || {}, profile = u.profile || {}, pm = u.pm || {};
  const docs = u.identityDocs || {}, review = u.creditLineReview || { status: 'pending', limit: 0 };
  const name = row.name || u.fullName || u.name || 'Sin nombre';
  return { id: row.id, name, ci: row.ci || profile.ci || pm.ci || '', createdAt: row.created_at || u.createdAt || null, version: row.version, points: Number(u.points) || 0, streak: Number(u.streak) || 0, loansCount: Array.isArray(state.loans) ? state.loans.length : 0, activeLoans: Array.isArray(state.loans) ? state.loans.filter(l => l.status === 'activo').length : 0, creditLineStatus: review.status || 'pending', creditLineLimit: Number(review.limit) || 0, identityDocsReady: !!(docs.front && docs.back && docs.selfie), collectors: q.cobradorsOf.all(row.id).map((r) => r.user_id), user: { name, fullName: u.fullName || row.name || '', profile: { ci: row.ci || profile.ci || pm.ci || '' }, points: Number(u.points) || 0, streak: Number(u.streak) || 0, createdAt: u.createdAt || row.created_at || null } };
}

/* ---------- reglas mínimas: lo que el cliente NO puede cambiar ----------
 * Es una primera capa de defensa sobre el estado compartido. La solución definitiva es mover las reglas
 * (mora, puntos, rachas, niveles) al servidor y exponer endpoints por acción; ver README, "Fase 2". */
function guardClient(o, n) {
  if (!n || n.v !== 3 || !Array.isArray(n.loans) || !n.user || !n.config || !Array.isArray(n.notes)) return 'Estado inválido.';
  if (!o) return null; // primera escritura: el dispositivo siembra los datos
  // La contraseña de la cuenta no la cambia el cliente desde la app; la restablece el personal.
  if (String((o.user || {}).passHash || '') !== String((n.user || {}).passHash || '')) return 'La contraseña solo la puede cambiar el prestamista.';
  if (JSON.stringify(o.config) !== JSON.stringify(n.config)) return 'El cliente no puede cambiar la configuración.';
  if ((o.shift || 0) !== (n.shift || 0)) return 'El cliente no puede cambiar la fecha de la app.';
  if (n.user.points !== o.user.points) return 'El cliente no puede cambiar sus puntos.';
  if ((n.user.streak || 0) > (o.user.streak || 0)) return 'El cliente no puede aumentar su racha.';
  const ob = Number(o.user.petBonusCredit) || 0, nb = Number(n.user.petBonusCredit) || 0;
  if (nb > ob && (nb - ob > 10 || (o.user.streak || 0) - (n.user.streak || 0) < 5)) return 'Bono de mascota no válido.';
  if (o.user.registered && ((n.user.fullName || null) !== (o.user.fullName || null) || ((n.user.profile || {}).ci || null) !== ((o.user.profile || {}).ci || null))) return 'El cliente no puede cambiar su nombre ni su cédula.';
  const oldDocs = o.user.identityDocs || {}, newDocs = n.user.identityDocs || {};
  for (const k of ['front','back','selfie']) if (oldDocs[k] && oldDocs[k] !== newDocs[k]) return 'Los documentos de identidad ya enviados no se pueden sustituir desde esta cuenta; contacta al prestamista.';
  const oldReview = o.user.creditLineReview || null, newReview = n.user.creditLineReview || null;
  if (oldReview && (!newReview || oldReview.status !== newReview.status || Number(oldReview.limit || 0) !== Number(newReview.limit || 0) || (oldReview.reviewedAt || null) !== (newReview.reviewedAt || null) || (oldReview.reason || '') !== (newReview.reason || ''))) return 'Solo el prestamista puede aprobar o rechazar una línea de crédito.';
  if (!oldReview && newReview && newReview.status !== 'pending') return 'La línea debe esperar la revisión del prestamista.';
  const oldLog = Array.isArray(o.log) ? o.log : [], newLog = new Map((Array.isArray(n.log) ? n.log : []).map((e) => [e.id, JSON.stringify(e)]));
  for (const e of oldLog) {
    const v = newLog.get(e.id);
    if (v === undefined) { if (oldLog.length < 500) return 'El historial no se puede borrar.'; }
    else if (v !== JSON.stringify(e)) return 'El historial no se puede modificar.';
  }
  const oldById = new Map(o.loans.map((l) => [l.id, l]));
  for (const l of o.loans) if (!n.loans.some((x) => x.id === l.id)) return 'No se pueden borrar préstamos.';
  for (const l of n.loans) {
    const p = oldById.get(l.id);
    if (!p) { if (l.status !== 'solicitud' || (l.installments || []).length || l.desembolso) return 'Un préstamo nuevo debe ser una solicitud.'; continue; }
    if (p.status !== l.status) return 'El cliente no puede cambiar el estado de un préstamo.';
    for (const k of ['amount', 'n', 'rate', 'total']) if (p[k] !== l[k]) return 'Los datos del préstamo no se pueden modificar.';
    if (JSON.stringify(p.desembolso || null) !== JSON.stringify(l.desembolso || null)) return 'Solo el prestamista puede registrar el comprobante de desembolso.';
    const pi = p.installments || [], li = l.installments || [];
    if (pi.length !== li.length) return 'Las cuotas no se pueden agregar ni quitar.';
    const byN = new Map(pi.map((i) => [i.n, i]));
    for (const i of li) {
      const o2 = byN.get(i.n);
      if (!o2) return 'Cuota inválida.';
      if (o2.status !== i.status && !(o2.status === 'pending' && i.status === 'validating')) return 'El cliente no puede validar ni rechazar pagos.';
      if (o2.amount !== i.amount) return 'El monto de una cuota no se puede modificar.';
      if ((o2.paidOn || null) !== (i.paidOn || null)) return 'El cliente no puede marcar pagos como validados.';
      const oa = new Map((o2.abonos || []).map((a) => [a.id, a]));
      for (const a of i.abonos || []) {
        const pa = oa.get(a.id);
        if (!pa) { if (a.status !== 'validating') return 'Un abono nuevo debe quedar en validación.'; }
        else if (pa.status !== a.status || pa.amount !== a.amount) return 'El cliente no puede modificar abonos ya enviados.';
      }
      for (const a of o2.abonos || []) if (!(i.abonos || []).some((x) => x.id === a.id)) return 'No se pueden borrar abonos.';
    }
  }
  return null;
}

/* ---------- rutas ---------- */
const IMG = {
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', ok: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', ok: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
};
const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function handle(req, res) {
  setCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, ip = ipOf(req);

  if (p === '/api/health' && req.method === 'GET') return send(res, 200, { quincena: true, ok: true, version: '2.1.0', admins: q.listUsers.all().filter((u) => u.role === 'admin' && u.active).length, time: nowIso() });

  if (p === '/api/auth' && req.method === 'POST') {
    if (blockedIp(ip)) return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const b = await readJson(req, 4096);
    if (b.role === 'admin' || b.role === 'cobrador' || b.role === 'staff') {
      // Inicio de sesión del personal: cuentas de la base de datos (administrador y cobrador).
      const row = findUser(b.username);
      const ok = !!row && !!row.active && typeof b.password === 'string' && checkPass(b.password, row.pass_hash);
      if (!ok) {
        failIp(ip); audit(null, ip, 'staff.auth.fail', 'usuario=' + String(b.username || '').slice(0, 40));
        return send(res, 401, { error: 'Usuario o contraseña incorrectos.' });
      }
      const claims = { r: row.role, u: row.id, n: row.username };
      const token = sign(row.role, LENDER_TTL, null, row.id, row.username);
      q.touchLogin.run(nowIso(), row.id);
      actorAudit(claims, ip, 'staff.auth.ok');
      return send(res, 200, { token, role: row.role, user: publicUser(row), expiresIn: LENDER_TTL });
    }
    if (b.role === 'prestamista') {
      failIp(ip); audit(null, ip, 'admin.auth.legacy_denied', 'método antiguo desactivado');
      return send(res, 401, { error: 'El acceso antiguo fue desactivado. Usa el inicio de sesión de /admin.html.' });
    }
    if (b.role === 'cliente') {
      if (CLIENT_KEY && !(typeof b.code === 'string' && safeEq(b.code, CLIENT_KEY))) { failIp(ip); audit(null, ip, 'auth.fail', 'cliente'); return send(res, 401, { error: 'Código de acceso incorrecto.' }); }
      const cid = typeof b.clientId === 'string' ? b.clientId : '';
      const ci = ciKey(b.ci);
      if (ci) {
        // Entrada con cédula y contraseña de la cuenta (funciona desde cualquier teléfono o navegador).
        const row = q.getClientByCi.get(ci);
        const passOk = !!row && typeof b.password === 'string' && row.json.includes('"passHash"') && checkPass(b.password, JSON.parse(row.json).user.passHash);
        if (!passOk) { failIp(ip); audit('cliente', ip, 'client.auth.fail', ci); return send(res, 401, { error: 'Cédula o contraseña incorrectas.' }); }
        audit('cliente', ip, 'client.auth.ok', row.id);
        return send(res, 200, { token: sign('cliente', CLIENT_TTL, row.id), role: 'cliente', clientId: row.id, version: row.version, state: JSON.parse(row.json), expiresIn: CLIENT_TTL });
      }
      if (cid && !q.getClient.get(cid)) return send(res, 404, { error: 'No se encontró esa cuenta. Regístrala de nuevo o contacta al prestamista.' });
      return send(res, 200, { token: sign('cliente', CLIENT_TTL, cid || null), role: 'cliente', clientId: cid || null, expiresIn: CLIENT_TTL });
    }
    return send(res, 400, { error: 'Rol inválido.' });
  }

  if (p.startsWith('/api/')) {
    const claims = authClaims(req);
    if (!claims) return send(res, 401, { error: 'Sesión no válida.' });
    const role = claims.r;

    const privateUpload = p.match(/^\/api\/uploads\/([a-f0-9]{32}\.(?:jpg|png|webp))$/i);
    if (privateUpload && req.method === 'GET') {
      const name = privateUpload[1], meta = q.getUpload.get(name), file = path.join(DATA_DIR, 'uploads', name);
      if (!meta || !fs.existsSync(file)) return send(res, 404, { error: 'Imagen no encontrada.' });
      if (role === 'cliente') {
        const cid = authClientId(req), row = cid && q.getClient.get(cid);
        if (!row || !String(row.json || '').includes(name)) { audit(role, ip, 'upload.read.denied', name); return send(res, 403, { error: 'No tienes acceso a esta imagen.' }); }
      } else if (isStaff(claims)) {
        // El cobrador solo ve imágenes de sus clientes asignados; el administrador, todas.
        if (role !== 'admin' && !q.listClients.all().some((r) => String(r.json || '').includes(name) && q.isAssigned.get(claims.u, r.id))) { actorAudit(claims, ip, 'upload.read.denied', name); return send(res, 403, { error: 'No tienes acceso a esta imagen.' }); }
      } else return send(res, 403, { error: 'Acceso denegado.' });
      res.writeHead(200, { 'Content-Type': meta.mime, 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': 'inline' });
      actorAudit(claims, ip, 'upload.read', name);
      return fs.createReadStream(file).pipe(res);
    }

    if (p === '/api/register' && req.method === 'POST') {
      if (role !== 'cliente' || authClientId(req)) return send(res, 403, { error: 'Esta sesión no puede crear otra cuenta.' });
      const b = await readJson(req, MAX_STATE);
      const state = b && b.state, u = state && state.user || {}, profile = u.profile || {}, pm = u.pm || {};
      const name = String(u.fullName || u.name || '').replace(/\s+/g, ' ').trim();
      const ci = String(profile.ci || pm.ci || '').trim().toUpperCase();
      const key = ciKey(ci);
      const docs = u.identityDocs || {};
      const pass = String(b.password || '');
      // Las fotos pueden llegar como data URL (modo local) o como nombre de archivo ya subido por /api/upload.
      const validDoc = (v) => (typeof v === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 2_000_000) || (typeof v === 'string' && /^[a-f0-9]{32}\.(?:jpg|png|webp)$/i.test(v));
      if (!state || state.v !== 3 || !Array.isArray(state.loans) || !u.registered || name.length < 5 || name.split(/\s+/).filter(Boolean).length < 2 || !/^[VEJGP]-?\d{6,9}$/i.test(ci) || !key) return send(res, 400, { error: 'Faltan el nombre completo o una cédula válida para registrar la cuenta.' });
      if (pass.length < MIN_PASS) return send(res, 400, { error: 'La contraseña debe tener al menos ' + MIN_PASS + ' caracteres.' });
      if (!validDoc(docs.front) || !validDoc(docs.back) || !validDoc(docs.selfie)) return send(res, 400, { error: 'Para crear la cuenta debes adjuntar la cédula por ambos lados y una selfie.' });
      if (q.getClientByCi.get(key)) return send(res, 409, { error: 'Esta cédula ya está registrada. Usa el dispositivo con el que creaste la cuenta o contacta al prestamista.' });
      let stateToSave = state;
      const legacy = q.getState.get();
      if (legacy && q.listClients.all().length === 0) {
        try {
          const oldState = JSON.parse(legacy.json), oldU = oldState.user || {}, oldP = oldU.profile || {}, oldPm = oldU.pm || {};
          if (oldU.registered && ciKey(oldP.ci || oldPm.ci) === key) stateToSave = oldState;
        } catch (_) { /* si el respaldo legado no se puede leer, conserva la información enviada por el cliente */ }
      }
      const id = crypto.randomUUID(), ts = nowIso();
      // La línea comienza pendiente por decisión del prestamista; el cliente no puede preaprobarse.
      stateToSave = JSON.parse(JSON.stringify(stateToSave));
      stateToSave.user = stateToSave.user || {};
      stateToSave.user.creditLineReview = { status: 'pending', limit: 0, requestedAt: ts.slice(0,10), reviewedAt: null, reason: '' };
      // La contraseña de la cuenta viaja cifrada (scrypt) dentro del expediente: solo se usa para entrar desde cualquier dispositivo.
      stateToSave.user.passHash = hashPass(pass);
      const json = JSON.stringify(stateToSave);
      db.exec('BEGIN');
      try {
        q.insertClient.run(id, String((stateToSave.user||{}).fullName || (stateToSave.user||{}).name || name).trim(), ci, key, ts, 1, json, ts);
        q.addClientHistory.run(id, 1, json, 'cliente', ts);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); if (String(e && e.message).includes('UNIQUE')) return send(res, 409, { error: 'Esta cédula ya está registrada.' }); throw e; }
      audit('cliente', ip, 'client.register', ci);
      return send(res, 201, { clientId: id, version: 1, token: sign('cliente', CLIENT_TTL, id), client: clientSummary(q.getClient.get(id)) });
    }

    if (p === '/api/state' && req.method === 'GET' && role === 'cliente' && authClientId(req)) {
      const row = q.getClient.get(authClientId(req));
      if (!row) return send(res, 404, { error: 'Cuenta no encontrada.' });
      const since = url.searchParams.get('since');
      if (since !== null && Number(since) === row.version) return send(res, 200, { unchanged: true, version: row.version });
      return send(res, 200, { version: row.version, state: JSON.parse(row.json) });
    }

    if (p === '/api/state' && req.method === 'PUT' && role === 'cliente' && authClientId(req)) {
      const cid = authClientId(req), cur = q.getClient.get(cid);
      if (!cur) return send(res, 404, { error: 'Cuenta no encontrada.' });
      const b = await readJson(req, MAX_STATE), old = JSON.parse(cur.json);
      if (!Number.isInteger(b.version) || !b.state || typeof b.state !== 'object') return send(res, 400, { error: 'Petición inválida.' });
      if (b.version !== cur.version) return send(res, 409, { error: 'Versión desactualizada.', current: { version: cur.version, state: old } });
      const err = guardClient(old, b.state);
      if (err) { audit(role, ip, 'state.denied', err); return send(res, 403, { error: err }); }
      const nu = b.state.user || {}, np = nu.profile || {}, npm = nu.pm || {}, name = String(nu.fullName || nu.name || cur.name).trim(), ci = String(np.ci || npm.ci || cur.ci).trim();
      const nv = cur.version + 1, ts = nowIso(), json = JSON.stringify(b.state);
      db.exec('BEGIN'); try { q.updateClient.run(name, ci, nv, json, ts, cid); q.addClientHistory.run(cid, nv, json, 'cliente', ts); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      audit(role, ip, 'client.state.put', 'v' + nv + ' préstamos=' + b.state.loans.length);
      return send(res, 200, { version: nv });
    }

    if ((p === '/api/state' && (req.method === 'GET' || req.method === 'PUT')) && role === 'cliente' && !authClientId(req)) {
      return send(res, 409, { error: 'Registra tu cuenta para acceder a tu expediente individual.' });
    }

    if (p === '/api/state' && req.method === 'GET') {
      const row = q.getState.get();
      const version = row ? row.version : 0;
      const since = url.searchParams.get('since');
      if (since !== null && Number(since) === version) return send(res, 200, { unchanged: true, version });
      if (!row) return send(res, 200, { version: 0, state: null });
      return send(res, 200, '{"version":' + row.version + ',"state":' + row.json + '}');
    }

    if (p === '/api/state' && req.method === 'PUT') {
      if (!isStaff(claims)) return send(res, 403, { error: 'Solo el personal puede escribir el estado general.' });
      const b = await readJson(req, MAX_STATE);
      const cur = q.getState.get(), curVer = cur ? cur.version : 0;
      if (!Number.isInteger(b.version) || !b.state || typeof b.state !== 'object') return send(res, 400, { error: 'Petición inválida.' });
      if (b.version !== curVer) return send(res, 409, { error: 'Versión desactualizada.', current: cur ? { version: cur.version, state: JSON.parse(cur.json) } : { version: 0, state: null } });
      if (b.state.v !== 3 || !Array.isArray(b.state.loans)) return send(res, 400, { error: 'Estado inválido.' });
      const nv = curVer + 1, json = JSON.stringify(b.state), ts = nowIso();
      db.exec('BEGIN');
      try {
        q.upsertState.run(nv, json, ts, actor(claims));
        q.addHistory.run(nv, json, actor(claims), ts);
        q.pruneHistory.run(nv - 200); // conserva las últimas 200 versiones como respaldo
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      actorAudit(claims, ip, 'state.put', 'v' + nv + ' préstamos=' + b.state.loans.length);
      return send(res, 200, { version: nv });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      if (!uploadAllowed(ip)) return send(res, 429, { error: 'Demasiadas capturas. Intenta más tarde.' });
      const b = await readJson(req, Math.ceil(MAX_IMG * 1.4));
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
      if (!m) return send(res, 400, { error: 'Debe ser una imagen JPEG, PNG o WebP.' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > MAX_IMG) return send(res, 413, { error: 'La imagen es demasiado grande (máx. 4 MB).' });
      const spec = IMG[m[1]];
      if (!spec.ok(buf)) return send(res, 400, { error: 'El archivo no es una imagen válida.' });
      const name = crypto.randomBytes(16).toString('hex') + '.' + spec.ext;
      fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf, { mode: 0o600 });
      q.addUpload.run(name, buf.length, m[1], actor(claims), nowIso());
      actorAudit(claims, ip, 'upload', name + ' ' + buf.length + 'B');
      return send(res, 200, { url: '/uploads/' + name });
    }

    if (p === '/api/clients' && req.method === 'GET') {
      if (!isStaff(claims)) return send(res, 403, { error: 'Solo el personal puede ver los clientes.' });
      const all = q.listClients.all().map(clientSummary);
      const list = claims.r === 'admin' ? all : all.filter((c) => c.collectors.includes(claims.u));
      return send(res, 200, { clients: list, role: claims.r, user: { id: claims.u, username: claims.n } });
    }
    const clientStatePath = p.match(/^\/api\/clients\/([a-f0-9-]{36})\/state$/i);
    if (clientStatePath) {
      if (!isStaff(claims)) return send(res, 403, { error: 'Solo el personal puede abrir estos expedientes.' });
      const cid = clientStatePath[1], row = q.getClient.get(cid);
      if (!row) return send(res, 404, { error: 'Cliente no encontrado.' });
      if (!canSeeClient(claims, cid)) { actorAudit(claims, ip, 'client.denied', 'cliente=' + cid); return send(res, 403, { error: 'Este cliente no está asignado a tu cuenta.' }); }
      if (req.method === 'GET') return send(res, 200, { version: row.version, state: JSON.parse(row.json), client: clientSummary(row) });
      if (req.method === 'PUT') {
        const b = await readJson(req, MAX_STATE);
        if (!Number.isInteger(b.version) || !b.state || b.state.v !== 3 || !Array.isArray(b.state.loans)) return send(res, 400, { error: 'Estado inválido.' });
        if (b.version !== row.version) return send(res, 409, { error: 'Versión desactualizada.', current: { version: row.version, state: JSON.parse(row.json) } });
        const u = b.state.user || {}, profile = u.profile || {}, pm = u.pm || {};
        const name = String(u.fullName || u.name || row.name).trim(), ci = String(profile.ci || pm.ci || row.ci).trim();
        const nv = row.version + 1, ts = nowIso(), json = JSON.stringify(b.state);
        db.exec('BEGIN'); try { q.updateClient.run(name, ci, nv, json, ts, cid); q.addClientHistory.run(cid, nv, json, actor(claims), ts); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
        actorAudit(claims, ip, 'client.state.put', 'cliente=' + cid + ' v' + nv);
        return send(res, 200, { version: nv });
      }
      return send(res, 405, { error: 'Método no permitido.' });
    }

    /* ---------- usuarios, roles y asignaciones (solo administrador) ---------- */
    if (p === '/api/me' && req.method === 'GET') {
      if (!isStaff(claims)) return send(res, 403, { error: 'Solo el personal tiene ficha de usuario.' });
      const row = q.userById.get(claims.u);
      if (!row) return send(res, 401, { error: 'Cuenta no válida.' });
      return send(res, 200, { user: publicUser(row) });
    }
    if (p === '/api/users' && req.method === 'GET') {
      if (claims.r !== 'admin') return send(res, 403, { error: 'Solo el administrador gestiona usuarios.' });
      return send(res, 200, { users: q.listUsers.all().map(publicUser) });
    }
    if (p === '/api/users' && req.method === 'POST') {
      if (claims.r !== 'admin') return send(res, 403, { error: 'Solo el administrador gestiona usuarios.' });
      const b = await readJson(req, 8192);
      const username = normUser(b.username), name = String(b.name || '').trim(), role = String(b.role || 'cobrador'), pass = String(b.password || '');
      if (username.length < 3 || username.length > 40) return send(res, 400, { error: 'El usuario debe tener entre 3 y 40 caracteres (letras, números, punto, guion).' });
      if (name.length < 3 || name.length > 80) return send(res, 400, { error: 'Escribe el nombre completo de la persona.' });
      if (!ROLES.includes(role)) return send(res, 400, { error: 'Rol inválido.' });
      if (pass.length < MIN_PASS) return send(res, 400, { error: 'La contraseña debe tener al menos ' + MIN_PASS + ' caracteres.' });
      if (findUser(username)) return send(res, 409, { error: 'Ese usuario ya existe.' });
      const id = crypto.randomUUID(), ts = nowIso();
      q.insertUser.run(id, username, name, role, hashPass(pass), ts, ts);
      if (role === 'cobrador' && Array.isArray(b.clients)) for (const cid of b.clients) if (typeof cid === 'string' && q.getClient.get(cid)) q.addAssignment.run(id, cid, ts);
      actorAudit(claims, ip, 'user.create', role + ':' + username);
      return send(res, 201, { user: publicUser(q.userById.get(id)) });
    }
    const userPath = p.match(/^\/api\/users\/([a-f0-9-]{36})$/i);
    if (userPath) {
      if (claims.r !== 'admin') return send(res, 403, { error: 'Solo el administrador gestiona usuarios.' });
      const row = q.userById.get(userPath[1]);
      if (!row) return send(res, 404, { error: 'Usuario no encontrado.' });
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const b = await readJson(req, 8192), ts = nowIso();
        const name = b.name !== undefined ? String(b.name).trim() : row.name;
        const role = b.role !== undefined ? String(b.role) : row.role;
        const active = b.active !== undefined ? (b.active ? 1 : 0) : row.active;
        if (name.length < 3 || name.length > 80) return send(res, 400, { error: 'Escribe el nombre completo de la persona.' });
        if (!ROLES.includes(role)) return send(res, 400, { error: 'Rol inválido.' });
        if (row.id === claims.u && (role !== 'admin' || !active)) return send(res, 400, { error: 'No puedes quitarte a ti mismo el rol de administrador ni desactivar tu cuenta.' });
        if (row.role === 'admin' && (role !== 'admin' || !active)) {
          const others = q.listUsers.all().filter((u) => u.role === 'admin' && u.active && u.id !== row.id).length;
          if (others === 0) return send(res, 400, { error: 'Debe quedar al menos un administrador activo.' });
        }
        q.updateUser.run(name, role, active, ts, row.id);
        if (b.password !== undefined) {
          const pass = String(b.password || '');
          if (pass.length < MIN_PASS) return send(res, 400, { error: 'La contraseña debe tener al menos ' + MIN_PASS + ' caracteres.' });
          q.setPass.run(hashPass(pass), ts, row.id);
        }
        // Cambiar de rol, desactivar o cambiar la contraseña cierra las sesiones abiertas de esa persona.
        if (role !== row.role || !active || b.password !== undefined) q.dropUserSessions.run(row.id);
        if (Array.isArray(b.clients)) {
          q.dropAssignmentsOf.run(row.id);
          for (const cid of b.clients) if (typeof cid === 'string' && q.getClient.get(cid)) q.addAssignment.run(row.id, cid, ts);
        }
        actorAudit(claims, ip, 'user.update', row.username + ' rol=' + role + ' activo=' + active + (b.password !== undefined ? ' (contraseña cambiada)' : ''));
        return send(res, 200, { user: publicUser(q.userById.get(row.id)) });
      }
      if (req.method === 'DELETE') {
        if (row.id === claims.u) return send(res, 400, { error: 'No puedes borrar tu propia cuenta.' });
        if (row.role === 'admin') {
          const others = q.listUsers.all().filter((u) => u.role === 'admin' && u.active && u.id !== row.id).length;
          if (others === 0) return send(res, 400, { error: 'Debe quedar al menos un administrador activo.' });
        }
        q.dropUserSessions.run(row.id); q.dropAssignmentsOf.run(row.id); q.deleteUser.run(row.id);
        actorAudit(claims, ip, 'user.delete', row.username);
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'Método no permitido.' });
    }
    /* Asignar o quitar un cliente de un cobrador concreto: PUT /api/users/:id/clients/:clientId y DELETE del mismo. */
    const assignPath = p.match(/^\/api\/users\/([a-f0-9-]{36})\/clients\/([a-f0-9-]{36})$/i);
    if (assignPath && (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE')) {
      if (claims.r !== 'admin') return send(res, 403, { error: 'Solo el administrador asigna clientes.' });
      const row = q.userById.get(assignPath[1]), cid = assignPath[2];
      if (!row) return send(res, 404, { error: 'Usuario no encontrado.' });
      if (row.role !== 'cobrador') return send(res, 400, { error: 'Solo se asignan clientes a un cobrador.' });
      if (!q.getClient.get(cid)) return send(res, 404, { error: 'Cliente no encontrado.' });
      if (req.method === 'DELETE') { q.dropAssignment.run(row.id, cid); actorAudit(claims, ip, 'assign.remove', row.username + ' ← ' + cid); }
      else { q.addAssignment.run(row.id, cid, nowIso()); actorAudit(claims, ip, 'assign.add', row.username + ' → ' + cid); }
      return send(res, 200, { user: publicUser(q.userById.get(row.id)) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const c = authClaims(req);
      if (c && c.jti) q.dropSession.run(c.jti);
      return send(res, 200, { ok: true });
    }

    if (!isStaff(claims)) return send(res, 403, { error: 'Solo el personal puede hacer esto.' });

    if (p === '/api/export' && req.method === 'GET') {
      if (claims.r !== 'admin') return send(res, 403, { error: 'Solo el administrador exporta el respaldo general.' });
      const row = q.getState.get();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="quincena-respaldo.json"', 'Cache-Control': 'no-store' });
      return res.end(row ? row.json : 'null');
    }
    if (p === '/api/audit' && req.method === 'GET') {
      // El administrador ve todo; el cobrador solo lo suyo.
      const lim = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const rows = claims.r === 'admin' ? q.listAudit.all(lim) : q.listAudit.all(500).filter((r) => String(r.role || '').endsWith(':' + claims.n)).slice(0, lim);
      return send(res, 200, { audit: rows });
    }
    return send(res, 404, { error: 'No encontrado.' });
  }

  if (req.method === 'GET' && /\/(?:favicon\.ico|apple-touch-icon\.png|icon-(?:maskable-)?\d+\.png|manifest\.webmanifest|sw\.js)$/.test(p)) {
    // Archivos públicos de la app instalable (iconos, manifiesto, service worker): van ANTES del
    // bloqueo del antiguo endpoint de imágenes, para que no los atrape esa regla.
    const f = path.join(PUBLIC_DIR, p.slice(1));
    if (!fs.existsSync(f)) return send(res, 404, { error: 'No encontrado.' });
    const type = p.endsWith('.js') ? 'application/javascript; charset=utf-8'
      : p.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8'
      : 'image/' + (p.endsWith('.ico') ? 'x-icon' : 'png');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': p.endsWith('.js') ? 'no-cache' : 'public, max-age=86400', 'Service-Worker-Allowed': '/' });
    return fs.createReadStream(f).pipe(res);
  }

  if (req.method === 'GET' && /^\/uploads\/[0-9a-f]{32}\.(jpg|png|webp)$/.test(p)) {
    // Bloquea el antiguo endpoint público: los archivos se sirven únicamente por /api/uploads con Bearer.
    return send(res, 401, { error: 'Esta imagen requiere una sesión autenticada.' });
  }

  if (req.method === 'GET' && p === '/admin.html') {
    const f = path.join(PUBLIC_DIR, 'admin.html');
    if (!fs.existsSync(f)) return send(res, 404, { error: 'Panel administrativo no instalado.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" });
    return res.end(fs.readFileSync(f));
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const f = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(f)) return send(res, 404, { error: 'App del cliente no instalada.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` });
    return res.end(fs.readFileSync(f));
  }
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const f = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(f));
    }
  }
  return send(res, 404, { error: 'No encontrado.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e && e.status ? e.status : 500;
    if (status === 500) console.error('Error:', e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Error interno.' : e.message });
    else res.end();
  });
});
server.requestTimeout = 30e3;
server.listen(PORT, HOST, () => console.log('Quincena escuchando en http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '  (datos en ' + DATA_DIR + ')'));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => { try { db.close(); } catch (e) { /* ya cerrada */ } process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
