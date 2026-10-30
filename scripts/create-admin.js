'use strict';
/*
 * Crea una cuenta de administrador (o restablece su contraseña) sin usar las variables de entorno.
 *
 *   node scripts/create-admin.js <usuario> "<Nombre completo>"
 *
 * Pide la contraseña por teclado (no se ve al escribir) y la guarda cifrada con scrypt.
 * Debe ejecutarse en la misma máquina donde vive la base de datos; usa DATA_DIR igual que el servidor.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dbFile = path.join(DATA_DIR, 'quincena.db');
if (!fs.existsSync(dbFile)) {
  console.error('No existe la base de datos en ' + dbFile + '. Arranca el servidor una vez o revisa DATA_DIR.');
  process.exit(1);
}
const username = String(process.argv[2] || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
const name = String(process.argv[3] || '').trim();
if (username.length < 3 || name.length < 3) {
  console.error('Uso: node scripts/create-admin.js <usuario> "<Nombre completo>"');
  process.exit(1);
}

function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pass), salt, 64).toString('hex');
}
function askHidden(question) {
  // Las preguntas se leen con un único lector de líneas: en Windows, crear un readline nuevo por pregunta
  // se queda sin las líneas que ya están en la tubería.
  if (!process.env.QUINCENA_QUIET) process.stdout.write(question);
  return answers.next().then((r) => String((r.done ? '' : r.value) || '').trim());
}
const answers = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })[Symbol.asyncIterator]();

(async () => {
  const pass = await askHidden('Contraseña (mín. 8 caracteres): ');
  if (pass.length < 8) { console.error('La contraseña debe tener al menos 8 caracteres.'); process.exit(1); }
  const again = await askHidden('Repite la contraseña: ');
  if (pass !== again) { console.error('Las contraseñas no coinciden.'); process.exit(1); }

  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','cobrador')), pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login TEXT);`);
  const ts = new Date().toISOString();
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (row) {
    db.prepare("UPDATE users SET pass_hash = ?, role = 'admin', active = 1, name = ?, updated_at = ? WHERE id = ?").run(hashPass(pass), name, ts, row.id);
    console.log('Contraseña restablecida para ' + username + ' (rol administrador, activo).');
  } else {
    db.prepare("INSERT INTO users (id,username,name,role,pass_hash,active,created_at,updated_at,last_login) VALUES (?,?,?,'admin',?,1,?,?,NULL)").run(crypto.randomUUID(), username, name, hashPass(pass), ts, ts);
  console.log('Administrador creado: ' + username);
  }
  db.close();
  process.exit(0);
})();
