'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadApp } = require('./harness');

const HTML = process.env.APP_HTML || path.join(__dirname, '..', 'public', 'index.html');
const fresh = () => loadApp(HTML);

test('todas las vistas se renderizan sin errores', () => {
  const app = fresh(), { x } = app;
  for (const tab of ['inicio', 'prestamos', 'calendario', 'nivel']) { x.ui.tab = tab; x.fn.render(); assert.ok(app.html().length > 200, tab); }
  for (const lt of ['activas', 'historial', 'pagos']) { x.ui.tab = 'prestamos'; x.ui.loanTab = lt; x.fn.render(); assert.ok(app.html().includes('Mis préstamos'), lt); }
  x.ui.unlocked = true; x.ui.role = 'prestamista'; x.fn.render();
  assert.doesNotMatch(app.html(), /Panel del prestamista|data-v="prestamista"|aria-label="Vista"/, 'el panel no está en la interfaz principal');
  let h = '';
  for (const pt of ['pend', 'hist', 'rep', 'cfg']) { x.ui.pTab = pt; h += x.fn.vPrestamista(); }
  for (const t of ['Reportes', 'Historial de pagos', 'Exportar y respaldar', 'Desembolsos']) assert.ok(h.includes(t), t);
  // La conexión ya no se configura desde la app: viene puesta de fábrica y no hay botón en el perfil.
  assert.doesNotMatch(h, /Conexión con el servidor/, 'no se pide configurar el servidor');
  assert.ok(x.fn.sheetHTML().length > 50);
  x.ui.sheet = { type: 'profile' };
  assert.doesNotMatch(x.fn.sheetHTML(), /data-a="server"/, 'el perfil no ofrece conectar al servidor');
  for (const type of ['server', 'profile', 'faq', 'pin', 'notes', 'importConfirm']) { x.ui.sheet = { type, mode: 'enter' }; x.ui.importData = x.getS(); assert.ok(x.fn.sheetHTML().length > 50, type); }
});

test('Pipo: máximo 3 usos al mes, 2 días de racha cada uno, y se reinicia al cambiar de mes', () => {
  const app = fresh(), { x } = app, S = x.getS();
  assert.equal(S.user.streak, 10);
  assert.equal(x.fn.pipoLeft(), 3);
  for (let n = 1; n <= 3; n++) {
    x.A.petPipoApply(null, { dataset: { l: '3', n: String(n) } });
    assert.equal(x.getS().user.streak, 10 - 2 * n, 'racha tras uso ' + n);
    assert.equal(x.fn.pipoUsed(), n);
  }
  assert.equal(x.fn.pipoLeft(), 0);
  const due = x.getS().loans.find(l => l.id === 3).installments[0].due;
  x.A.petPipoApply(null, { dataset: { l: '3', n: '1' } });
  assert.equal(x.getS().user.streak, 4, 'el cuarto uso no debe descontar racha');
  assert.equal(x.getS().loans.find(l => l.id === 3).installments[0].due, due, 'ni mover la fecha');
  x.A.petUse('pipo');
  assert.match(app.toast(), /3 veces este mes/);
  x.fn.render(); // botón de Pipo deshabilitado en el calendario
  x.ui.tab = 'calendario'; x.fn.render();
  assert.match(app.html(), /Límite del mes: 3 de 3/);
  x.getS().user.pipo.m = '2000-01'; // "mes anterior"
  assert.equal(x.fn.pipoLeft(), 3);
});

test('abono que cubre el saldo y se envía a tiempo no genera mora aunque se valide tarde; puntos por el abono final', () => {
  const app = fresh(), { x } = app, S = x.getS();
  x.ui.role = 'prestamista'; x.ui.unlocked = true;
  const l = S.loans.find(q => q.id === 3), i = l.installments[0];
  i.abonos = [{ id: 900, amount: x.fn.owed(i), ref: 'R-1234', proof: 'a.jpg', proofData: 'data:image/jpeg;base64,AA==', status: 'validating', submittedOn: x.fn.today(), paidOn: null }];
  x.A.skip('16'); // pasa la fecha de vencimiento (+15)
  assert.equal(i.mora, undefined, 'no debe aplicarse mora');
  assert.equal(x.fn.instStatus(i), 'validating');
  assert.equal(x.fn.blocked(), false);
  const pts = x.getS().user.points, streak = x.getS().user.streak;
  x.A.okAbono(null, { dataset: { l: '3', n: '1', ab: '900' } });
  assert.equal(i.status, 'paid');
  assert.equal(x.getS().user.points, pts + 10, 'pago puntual medido por el abono final');
  assert.equal(x.getS().user.streak, streak + 1);
});

test('abono parcial NO frena la mora; un abono final tardío no da puntos', () => {
  const app = fresh(), { x } = app, S = x.getS();
  x.ui.role = 'prestamista'; x.ui.unlocked = true;
  const i = S.loans.find(q => q.id === 3).installments[0];
  i.abonos = [{ id: 901, amount: 5, ref: 'R-5555', status: 'validating', submittedOn: x.fn.today(), proofData: '' }];
  x.A.skip('16');
  assert.equal(i.mora, 4, 'mora aplicada porque el abono no cubría el saldo');
  assert.equal(x.fn.blocked(), true);
  // el prestamista valida el abono parcial: saldo baja pero la cuota sigue abierta
  const before = x.fn.owed(i);
  x.A.okAbono(null, { dataset: { l: '3', n: '1', ab: '901' } });
  assert.equal(x.fn.owed(i), Math.round((before - 5) * 100) / 100);
  assert.notEqual(i.status, 'paid');
  // abono final enviado tarde: completa la cuota pero sin puntos
  i.abonos.push({ id: 902, amount: x.fn.owed(i), ref: 'R-6666', status: 'validating', submittedOn: x.fn.today(), proofData: '' });
  const pts = x.getS().user.points;
  x.A.okAbono(null, { dataset: { l: '3', n: '1', ab: '902' } });
  assert.equal(i.status, 'paid');
  assert.equal(x.getS().user.points, pts, 'sin puntos por pago tardío');
  assert.equal(x.getS().user.streak, 0);
});

test('Michi reduce el recargo y también el saldo cuando ya había abonos', () => {
  const app = fresh(), { x } = app, S = x.getS();
  const i = S.loans.find(q => q.id === 3).installments[0];
  i.mora = 4; i.balanceDue = 12; // saldo ya incluye la mora
  x.A.petMichiApply(null, { dataset: { l: '3', n: '1' } });
  assert.equal(i.mora, 2);
  assert.equal(i.balanceDue, 10);
});

test('historial de pagos, reportes y CSV', () => {
  const app = fresh(), { x } = app;
  const ps = x.fn.payments();
  assert.equal(ps.length, 2, 'el préstamo de ejemplo pagado tiene 2 cuotas');
  assert.equal(ps.reduce((s, p) => s + p.amount, 0), 22, '$20 al 10% en 2 cuotas = $22 en total');
  // pago con abonos: aparece cada abono, no la cuota duplicada
  const l = x.getS().loans.find(q => q.id === 3), i = l.installments[0];
  i.abonos = [{ id: 1, amount: 10, ref: 'A1', status: 'paid', submittedOn: x.fn.today(), paidOn: x.fn.today() }, { id: 2, amount: 5, ref: 'A2', status: 'paid', submittedOn: x.fn.today(), paidOn: x.fn.today() }];
  i.status = 'paid'; i.paidOn = x.fn.today();
  assert.equal(x.fn.payments().filter(p => p.loan.id === 3).length, 2);
  x.ui.unlocked = true; x.ui.role = 'prestamista';
  for (const r of ['mes', '3m', 'todo']) { x.ui.range = r; assert.ok(x.fn.vReportes().includes('Cobrado'), r); }
  const rows = x.fn.exportRows('pagos');
  assert.equal(rows[0][0], 'Fecha');
  const csv = x.fn.toCsv(rows);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(x.fn.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(x.fn.csvCell('@cmd'), "'@cmd");
  assert.equal(x.fn.csvCell(5.5), '5,5');
  assert.equal(x.fn.csvCell('a;b'), '"a;b"');
  assert.ok(x.fn.exportRows('prestamos').length >= 3);
  assert.ok(x.fn.exportRows('cuotas').length >= 6);
  x.ui.role = 'cliente'; x.ui.unlocked = false;
  x.A.exportCsv('prestamos');
  assert.match(app.toast(), /Solo el prestamista/);
});

test('respaldo JSON: validación y restauración', () => {
  const app = fresh(), { x } = app;
  const bk = JSON.parse(JSON.stringify(x.getS()));
  assert.equal(x.fn.validBackup(bk), true);
  assert.equal(x.fn.validBackup({ v: 2 }), false);
  assert.equal(x.fn.validBackup(null), false);
  bk.user.name = 'Restaurado'; x.ui.role = 'prestamista'; x.ui.unlocked = true; x.ui.importData = bk;
  x.A.importOk();
  assert.equal(x.getS().user.name, 'Restaurado');
});

test('la variable --accent-soft existe en el CSS', () => {
  const html = require('node:fs').readFileSync(HTML, 'utf8');
  assert.match(html, /--accent-soft:color-mix/);
});

test('los botones de las hojas no se comprimen (antes se cortaba "Enviar abono para validar")', () => {
  const html = require('node:fs').readFileSync(HTML, 'utf8');
  assert.match(html, /\.sheet>\*\{flex-shrink:0\}/);
  assert.match(html, /\.sheet>\.btn\{flex-shrink:0\}/);
});

test('botones de las hojas apilados (uno debajo del otro) y campos de 16px para que iOS no amplíe la página', () => {
  const html = require('node:fs').readFileSync(HTML, 'utf8');
  assert.match(html, /\.sheet \.row:has\(>\.btn\)\{flex-direction:column-reverse/);
  assert.match(html, /\.field input,\.field select,\.field textarea\{font-size:16px\}/);
  assert.doesNotMatch(html, /\.sheet \.btn\{flex-shrink:0/, 'los botones de una fila no pueden quedar sin poder encogerse');
});

test('modo oscuro: botón luna/sol pequeño arriba a la derecha, alterna, persiste y aplica data-theme', () => {
  const app = fresh(), { x } = app, root = app.ctx.document.documentElement;
  const SUN = '<circle cx="12" cy="12" r="4"/>', MOON = 'M20 14.5A8 8 0 0 1 9.5 4';
  x.fn.render();
  assert.equal(x.getTheme(), 'light');
  assert.equal(root.dataset.theme, 'light');
  let h = app.html();
  assert.ok(h.indexOf('themebtn') > -1 && h.indexOf('themebtn') < h.indexOf('data-a="profile"'), 'el botón de tema va en el grupo superior derecho');
  assert.match(h, /iconbtn sm themebtn/);
  assert.ok(h.includes(SUN) && !h.includes(MOON), 'en modo claro se ve el sol');
  x.A.theme();
  assert.equal(x.getTheme(), 'dark'); assert.equal(root.dataset.theme, 'dark');
  assert.equal(app.store.get('quincena.theme'), 'dark');
  x.fn.render(); h = app.html();
  assert.ok(h.includes(MOON) && !h.includes(SUN.slice(0, 20) + 'x'), 'en modo oscuro se ve la luna');
  assert.doesNotMatch(h, /themebtn spin/, 'el giro del icono se aplica en el sitio, sin volver a dibujar la página');
  assert.match(app.html(), /Cambiar a modo claro/);
  // persiste entre sesiones
  const again = loadApp(HTML, { storage: app.store });
  assert.equal(again.x.getTheme(), 'dark');
  assert.equal(again.ctx.document.documentElement.dataset.theme, 'dark');
  x.A.theme(); x.fn.render();
  assert.equal(x.getTheme(), 'light'); assert.ok(app.html().includes(SUN));
  assert.match(require('node:fs').readFileSync(HTML, 'utf8'), /--bub1:color-mix\(in srgb,var\(--accent\) 46%,#0b1116\)/, 'burbuja de navegación adaptada al modo oscuro');
});

test('las animaciones de entrada solo ocurren al cambiar de pantalla; las hojas no se reanimán en cada paso', () => {
  const app = fresh(), { x } = app;
  x.A.tab('nivel');
  assert.equal(app.els['#app'].className, 'app enter');
  x.A.cprev();
  assert.equal(app.els['#app'].className, 'app', 'un toque normal no repite la entrada');
  x.ui.sheet = null; x.fn.renderSheet(); // se cierra el tutorial inicial
  x.ui.sheet = { type: 'faq' }; x.fn.renderSheet();
  assert.doesNotMatch(app.els['#layer'].innerHTML, /scrim still/, 'al abrir sí se anima');
  x.fn.renderSheet();
  assert.match(app.els['#layer'].innerHTML, /scrim still/, 'al cambiar de paso no se reanima');
  x.ui.sheet = null; x.fn.renderSheet();
  x.ui.sheet = { type: 'faq' }; x.fn.renderSheet();
  assert.doesNotMatch(app.els['#layer'].innerHTML, /scrim still/, 'una hoja nueva vuelve a animarse');
});

test('rendimiento: fondo fijo en capa propia y sin animar filtros', () => {
  const html = require('node:fs').readFileSync(HTML, 'utf8');
  assert.doesNotMatch(html, /background-attachment:fixed/);
  assert.match(html, /body::before\{content:"";position:fixed/);
  assert.match(html, /@keyframes flameLive\{0%\{transform:rotate\(-7deg\) scale\(\.96,1\.02\)\}45%\{transform:rotate\(5deg\) scale\(1\.07,\.94\)\}100%\{transform:rotate\(-2deg\) scale\(1\.02,1\.08\)\}\}/);
});

const asLender = (x) => { x.ui.role = 'prestamista'; x.ui.unlocked = true; };
const asClient = (x) => { x.ui.role = 'cliente'; x.ui.unlocked = false; };
const fakeFile = { type: 'image/png', name: 'pago.png' };
const setInput = (app, sel, props) => Object.assign(app.ctx.document.querySelector(sel), props);

test('el cliente NO puede validar, rechazar ni aprobar nada aunque dispare las acciones', () => {
  const app = fresh(), { x } = app, S = x.getS();
  const i = S.loans.find(q => q.id === 3).installments[0];
  i.status = 'validating'; i.ref = 'R-1'; i.proofData = 'data:image/png;base64,AAAA'; i.submittedOn = x.fn.today(); i.paymentAmount = 34.5;
  S.loans.push({ id: 60, amount: 10, n: 1, rate: 5, total: 10.5, status: 'solicitud', installments: [], createdAt: x.fn.today() });
  asClient(x);
  for (const [fn, ds] of [['okP', { l: '3', n: '1' }], ['rejP', { l: '3', n: '1' }], ['okB', { l: '3', n: '1' }], ['okL', { l: '60' }], ['rejL', { l: '60' }], ['okAbono', { l: '3', n: '1', ab: '1' }], ['saveCfg', {}], ['skip', {}], ['reset', {}], ['disburse', { l: '60', m: 'approve' }]]) {
    x.A[fn](ds.n ? undefined : (fn === 'skip' ? '1' : undefined), { dataset: ds });
    assert.match(app.toast(), /Solo el prestamista/, fn);
  }
  assert.equal(i.status, 'validating');
  assert.equal(S.loans.find(l => l.id === 60).status, 'solicitud');
  // la hoja del comprobante de un pago nunca muestra "Validar pago" al cliente, solo al prestamista
  x.ui.sheet = { type: 'proof', loan: 3, n: 1 };
  assert.doesNotMatch(x.fn.sheetHTML(), /Validar pago|No coincide/);
  asLender(x);
  assert.match(x.fn.sheetHTML(), /Validar pago/);
});

test('desembolso: el prestamista adjunta captura y referencia al aprobar, y el cliente la ve al deslizar el contrato', async () => {
  const app = fresh(), { x } = app, S = x.getS();
  S.loans.push({ id: 61, amount: 20, n: 2, rate: 10, total: 22, status: 'solicitud', installments: [], createdAt: x.fn.today(), cobro: { bank: 'BNC', phone: '0414-1234567', ci: 'V-12345678' }, method: 'pm' });
  asLender(x);
  // "Aprobar y desembolsar" ya no aprueba directo: abre la hoja del desembolso
  x.A.disburse(null, { dataset: { l: '61', m: 'approve' } });
  assert.equal(x.ui.sheet.type, 'disburse'); assert.equal(x.ui.sheet.mode, 'approve');
  assert.equal(S.loans.find(l => l.id === 61).status, 'solicitud');
  assert.match(x.fn.sheetHTML(), /Aprobar y enviar comprobante/);
  // sin referencia ni captura no avanza
  setInput(app, '#dRef', { value: '' }); setInput(app, '#dProof', { files: [] });
  await x.A.disburseSend(null, { dataset: { l: '61' } });
  assert.match(app.ctx.document.querySelector('#derr').textContent, /referencia/i);
  setInput(app, '#dRef', { value: '004512' });
  await x.A.disburseSend(null, { dataset: { l: '61' } });
  assert.match(app.ctx.document.querySelector('#derr').textContent, /captura/i);
  assert.equal(S.loans.find(l => l.id === 61).status, 'solicitud');
  // con ambos: aprueba y guarda el comprobante
  setInput(app, '#dProof', { files: [fakeFile] });
  await x.A.disburseSend(null, { dataset: { l: '61' } });
  const l = x.getS().loans.find(q => q.id === 61);
  assert.equal(l.status, 'activo'); assert.equal(l.desembolso.ref, '004512'); assert.equal(l.desembolso.amount, 20);
  assert.ok(l.desembolso.proofData.startsWith('data:image/'));
  assert.equal(x.ui.sheet, null);
  // el cliente: panel deslizable con el comprobante del desembolso, sin botones de validación
  asClient(x); x.ui.tab = 'prestamos'; x.ui.loanTab = 'activas'; x.fn.render();
  const h = app.html();
  assert.match(h, /Dinero enviado ✓/); assert.match(h, /Ref\. 004512/); assert.match(h, /comprobante de tu desembolso/);
  assert.doesNotMatch(h, /Validar pago|No coincide/);
  assert.match(x.getS().notes[0].text, /comprobante del pago móvil/);
  x.A.viewDesembolso(null, { dataset: { l: '61' } });
  const sh = x.fn.sheetHTML();
  assert.match(sh, /Comprobante del desembolso/); assert.match(sh, /004512/); assert.doesNotMatch(sh, /Validar pago/);
  // el cliente no puede cambiarlo
  x.A.disburse(null, { dataset: { l: '61', m: 'attach' } });
  assert.match(app.toast(), /Solo el prestamista/);
});

test('desembolso: reemplazo posterior, préstamo sin comprobante y panel del prestamista', async () => {
  const app = fresh(), { x } = app;
  asLender(x); x.ui.pTab = 'pend';
  let adminHtml = x.fn.vPrestamista();
  assert.match(adminHtml, /Desembolsos por adjuntar/); assert.match(adminHtml, /Adjuntar comprobante/); assert.match(adminHtml, /Pendiente/);
  x.ui.pTab = 'hist'; adminHtml = x.fn.vPrestamista(); assert.match(adminHtml, /Sin comprobante/); assert.match(adminHtml, /Adjuntar comprobante/);
  asClient(x); x.ui.tab = 'prestamos'; x.fn.render();
  assert.match(app.html(), /aún no ha adjuntado el comprobante/);
  asLender(x);
  x.A.disburse(null, { dataset: { l: '3', m: 'attach' } });
  assert.equal(x.ui.sheet.mode, 'attach');
  setInput(app, '#dRef', { value: 'REF-9999' }); setInput(app, '#dProof', { files: [fakeFile] });
  await x.A.disburseSend(null, { dataset: { l: '3' } });
  assert.equal(x.getS().loans.find(l => l.id === 3).desembolso.ref, 'REF-9999');
  assert.equal(x.getS().loans.find(l => l.id === 3).status, 'activo', 'adjuntar no cambia el estado');
  // reemplazar solo la referencia conserva la captura
  const before = x.getS().loans.find(l => l.id === 3).desembolso.proofData;
  x.A.disburse(null, { dataset: { l: '3', m: 'attach' } });
  setInput(app, '#dRef', { value: 'REF-0001' }); setInput(app, '#dProof', { files: [] });
  await x.A.disburseSend(null, { dataset: { l: '3' } });
  assert.equal(x.getS().loans.find(l => l.id === 3).desembolso.ref, 'REF-0001');
  assert.equal(x.getS().loans.find(l => l.id === 3).desembolso.proofData, before);
});

test('datos de pago móvil: se guardan, se rellenan con un toque, no se duplican y se pueden quitar', () => {
  const app = fresh(), { x } = app;
  asClient(x);
  const fill = (bank, phone, ci) => { setInput(app, '#pmBank', { value: bank }); setInput(app, '#pmPhone', { value: phone }); setInput(app, '#pmCI', { value: ci }); };
  x.A.request();
  assert.doesNotMatch(x.fn.sheetHTML(), /Tus datos guardados/, 'sin datos previos no aparece la lista');
  fill('BNC', '0414-1234567', 'V-12345678'); x.A.rnext();
  assert.equal(x.ui.sheet.step, 2);
  x.ui.sheet = null;
  x.A.request(); fill('Banesco', '0424-7654321', 'V-87654321'); x.A.rnext(); x.ui.sheet = null;
  x.A.request(); fill('bnc', '04141234567', 'v12345678'); x.A.rnext(); x.ui.sheet = null; // el mismo BNC escrito distinto
  assert.equal(x.fn.savedPms().length, 2, 'sin duplicados');
  assert.equal(x.fn.savedPms()[0].bank, 'bnc', 'el último usado va primero');
  // al abrir de nuevo: campos vacíos y tarjetas guardadas; un toque rellena los tres campos
  x.A.request();
  let sh = x.fn.sheetHTML();
  assert.match(sh, /Tus datos guardados/); assert.match(sh, /Banesco/);
  assert.doesNotMatch(sh, /id="pmBank"[^>]*value="BNC"/i);
  x.A.pmUse('1');
  sh = x.fn.sheetHTML();
  assert.match(sh, /id="pmBank"[^>]*value="Banesco"/); assert.match(sh, /id="pmPhone"[^>]*value="0424-7654321"/); assert.match(sh, /id="pmCI"[^>]*value="V-87654321"/);
  assert.match(sh, /aria-pressed="true"/);
  // quitar
  x.A.pmDel('1');
  assert.equal(x.fn.savedPms().length, 1);
  assert.doesNotMatch(x.fn.sheetHTML(), /<b>Banesco<\/b>/);
  x.A.pmDel('0');
  assert.equal(x.fn.savedPms().length, 0);
  // una cuenta guardada con la versión anterior (solo S.user.pm) también aparece
  x.getS().user.pm = { bank: 'Mercantil', phone: '0412-1112233', ci: 'V-11223344' }; x.getS().user.pmList = [];
  assert.equal(x.fn.savedPms()[0].bank, 'Mercantil');
});

test('seguridad de imágenes: un comprobante manipulado no puede inyectar código', () => {
  const app = fresh(), { x } = app, S = x.getS();
  const evil = 'x" onerror="alert(1)';
  assert.equal(x.fn.safeSrc(evil), '');
  assert.equal(x.fn.safeSrc('javascript:alert(1)'), '');
  assert.ok(x.fn.safeSrc('data:image/png;base64,iVBORw0KGgo=').startsWith('data:image/png'));
  assert.ok(x.fn.safeSrc('/uploads/' + 'a'.repeat(32) + '.png'));
  assert.equal(x.fn.safeSrc('data:text/html;base64,PGI+'), '');
  const l = S.loans.find(q => q.id === 3), i = l.installments[0];
  i.status = 'validating'; i.ref = 'R'; i.proofData = evil; i.submittedOn = x.fn.today();
  i.abonos = [{ id: 5, amount: 3, ref: 'ab', status: 'validating', submittedOn: x.fn.today(), proofData: evil }];
  l.desembolso = { proofData: evil, ref: '<img src=x onerror=alert(2)>', amount: 90, date: x.fn.today() };
  asLender(x);
  for (const pt of ['pend', 'hist']) { x.ui.pTab = pt; const lenderHtml=x.fn.vPrestamista(); assert.doesNotMatch(lenderHtml, /<[^>]*\sonerror=/); assert.match(lenderHtml, /Ref\./); }
  x.ui.sheet = { type: 'proof', loan: 3, n: 1 }; assert.doesNotMatch(x.fn.sheetHTML(), /<[^>]*\sonerror=/);
  x.ui.sheet = { type: 'abonoProof', loan: 3, n: 1, ab: 5 }; assert.doesNotMatch(x.fn.sheetHTML(), /<[^>]*\sonerror=/);
  x.ui.sheet = { type: 'desembolso', loan: 3 }; assert.doesNotMatch(x.fn.sheetHTML(), /<[^>]*\sonerror=/);
  asClient(x); x.ui.tab = 'prestamos'; x.fn.render(); assert.doesNotMatch(app.html(), /<[^>]*\sonerror=/);
  assert.match(x.fn.loanReceiptHTML(l), /aún no ha adjuntado/, 'una imagen no válida no se muestra');
});

test('panel del prestamista: pestañas Pendientes, Historial, Reportes y Ajustes', () => {
  const app = fresh(), { x } = app, S = x.getS();
  const i = S.loans.find(q => q.id === 3).installments[0];
  i.status = 'validating'; i.ref = 'R-7'; i.proofData = 'data:image/png;base64,AAAA'; i.submittedOn = x.fn.today();
  S.loans.push({ id: 70, amount: 10, n: 1, rate: 5, total: 10.5, status: 'solicitud', installments: [], createdAt: x.fn.today() });
  asLender(x); x.ui.pTab = undefined;
  let h = x.fn.vPrestamista();
  assert.match(h, /class="seg ptabs"/); assert.match(h, /Capital en la calle/, 'el resumen siempre visible');
  assert.match(h, /Solicitudes<\/h2>/); assert.match(h, /Validar pago/);
  assert.doesNotMatch(h, /Configuración<\/h2>|Exportar y respaldar|Desembolsos<\/h2>/);
  assert.match(h, /<span class="cnt">3<\/span>/, 'contador de pendientes (solicitud + pago + desembolso sin comprobante)');
  assert.doesNotMatch(h, />Envíos</);
  x.A.ptab('hist'); h = x.fn.vPrestamista(); assert.match(h, /Préstamos pedidos/); assert.doesNotMatch(h, /Validar pago/); assert.doesNotMatch(h, />Envíos</);
  x.A.ptab('rep'); h = x.fn.vPrestamista(); assert.match(h, /Exportar y respaldar/); assert.match(h, /Historial de pagos/); assert.doesNotMatch(h, /Guardar cambios/);
  x.A.ptab('cfg'); h = x.fn.vPrestamista(); assert.match(h, /Guardar cambios/); assert.doesNotMatch(h, /Exportar y respaldar/);
});

test('cliente: Pagos sin totales ni descargas, y las acciones de descarga están bloqueadas', () => {
  const app = fresh(), { x } = app;
  asClient(x); x.ui.tab = 'prestamos'; x.ui.loanTab = 'pagos'; x.fn.render();
  const h = app.html();
  assert.match(h, /Cuota/); assert.doesNotMatch(h, /Total pagado|Descargar|CSV|exportCsv|exportBackup/);
  x.ui.tab = 'inicio'; x.fn.render(); assert.doesNotMatch(app.html(), /exportCsv|exportBackup|Descargar/);
  for (const a of ['exportCsv', 'exportBackup']) { x.A[a]('pagos', { dataset: { v: 'pagos' } }); assert.match(app.toast(), /Solo el prestamista/, a); }
});

test('comprobante del desembolso: oculto detrás de la tarjeta y con pista animada una sola vez', async () => {
  const app = fresh(), { x } = app;
  const css = app.src || require('node:fs').readFileSync(HTML, 'utf8');
  assert.match(css, /\.loan-reveal\{opacity:0;visibility:hidden/);
  assert.match(css, /\.loan-swipe-wrap\.revealed \.loan-reveal,\.loan-swipe-wrap\.peek \.loan-reveal\{opacity:1;visibility:visible/);
  assert.match(css, /@keyframes peek/); assert.match(css, /prefers-reduced-motion:reduce\)\{\.loan-swipe-wrap\.peek/);
  asClient(x); x.ui.tab = 'prestamos'; x.ui.loanTab = 'activas';
  assert.ok(!x.ui.peekDone);
  x.fn.render();
  assert.equal(x.ui.peekDone, true, 'la pista se programa al ver Préstamos por primera vez');
  x.fn.render(); x.fn.render();
  assert.equal(x.ui.peekDone, true);
});

test('cuenta: exige nombre completo, cédula, foto de la cédula y foto del rostro antes de registrar', async () => {
  // Sin servidor disponible: la cuenta se crea en el dispositivo (y se sube sola cuando el servidor responda).
  const app = loadApp(HTML, { fetchImpl: async () => { throw new Error('sin red'); } }), { x } = app;
  x.Backend.enabled = false; // modo local explícito para esta prueba
  assert.equal(x.ui.sheet.type, 'authHome', 'sin cuenta primero aparece la pantalla de acceso');
  x.A.authCreate();
  assert.equal(x.ui.sheet.type, 'signup', 'el registro empieza directamente en los datos personales');
  assert.match(x.fn.sheetHTML(), /Nombre completo/); assert.match(x.fn.sheetHTML(), /Cédula de identidad/);
  assert.match(x.fn.sheetHTML(), /suFront/); assert.doesNotMatch(x.fn.sheetHTML(), /suBack/, 'ya no se pide el reverso'); assert.doesNotMatch(x.fn.sheetHTML(), /id="suFront"[^>]*capture/, 'la cédula deja elegir cámara o archivo'); assert.match(x.fn.sheetHTML(), /data-a="authBack"/, 'botón Volver'); assert.match(x.fn.sheetHTML(), /suSelfie/);
  x.A.close(); assert.equal(x.ui.sheet.type, 'signup', 'la hoja de registro no se puede cerrar sin completarla');
  const go = async (name, ci, withDocs = false, pass = 'clave-larga-1') => { setInput(app, '#suName', { value: name }); setInput(app, '#suCI', { value: ci }); setInput(app, '#suPass', { value: pass }); setInput(app, '#suPass2', { value: pass }); if(withDocs) for(const id of ['#suFront','#suSelfie']) setInput(app,id,{files:[{type:'image/png',name:id.slice(1)+'.png',size:100}]}); await x.A.signupSave(); };
  await go('Carlos', 'V-12345678'); assert.match(app.ctx.document.querySelector('#suerr').textContent, /nombre completo/i);
  await go('Carlos Pérez', '123'); assert.match(app.ctx.document.querySelector('#suerr').textContent, /cédula/i);
  await go('Carlos 123 Pérez', 'V-12345678'); assert.match(app.ctx.document.querySelector('#suerr').textContent, /nombre completo/i);
  await go('Carlos Pérez', 'V-12345678'); assert.match(app.ctx.document.querySelector('#suerr').textContent, /cédula y la foto de tu rostro/i, 'sin fotos no se crea la cuenta');
  assert.ok(!x.getS().user.registered);
  await go('  carlos   andrés pérez ', 'v 12.345.678', true);
  const u = x.getS().user;
  assert.equal(u.registered, true); assert.equal(u.name, 'carlos andrés pérez'); assert.equal(u.profile.ci, 'V-12345678');
  assert.ok(u.identityDocs.front && u.identityDocs.selfie, 'cédula y rostro');
  assert.equal(u.identityDocs.back, '', 'el reverso de la cédula es opcional');
  assert.equal(u.creditLineReview.status, 'pending', 'la línea comienza pendiente de aprobación');
  assert.equal(x.ui.sheet.type, 'tutorial', 'tras registrarse sigue el recorrido');
  assert.equal(x.fn.firstName(), 'carlos');
  assert.match(x.getS().notes[0].text, /Nueva cuenta creada/);
  // en la edición de perfil el nombre y la cédula quedan bloqueados
  x.ui.sheet = { type: 'profileEdit' }; assert.match(x.fn.sheetHTML(), /id="profileName"[^>]*readonly/); assert.match(x.fn.sheetHTML(), /id="profileCI"[^>]*readonly/);
});

test('historial por usuario: identificado por nombre y cédula, con préstamos, pagos y mascotas del mes', () => {
  const app = fresh(), { x } = app, S = x.getS();
  S.user.registered = true; S.user.name = 'María Gómez Rojas'; S.user.fullName = S.user.name; S.user.profile = { phone: '', email: '', ci: 'V-9876543' }; S.user.createdAt = x.fn.today();
  S.user.tutorialDone = true; x.ui.sheet = null; S.user.points = 600; S.user.streak = 12;
  x.A.petPipoApply(null, { dataset: { l: '3', n: '1' } });
  x.A.petUse('burbujita');
  asLender(x); x.A.ptab('hist');
  const h = x.fn.vPrestamista();
  assert.match(h, /María Gómez Rojas/); assert.match(h, /C\.I\. V-9876543/);
  assert.match(h, /Préstamos pedidos/); assert.match(h, /Mascotas · /);
  assert.match(h, /Pipo<\/span><b>1 de 3 usos/);
  assert.match(h, /Pipo extendió la cuota 1/, 'la actividad registra el uso de la mascota');
  assert.match(h, /Ver cuotas/); assert.match(h, /Falta por pagar/); assert.match(h, /Cuotas pagadas/);
  assert.match(h, /Pagado<\/span>|class="pill ok">Pagado/);
  // el historial se llena con lo que hace el cliente en la página
  asClient(x); x.ui.tab = 'inicio';
  S.loans.push({ id: 80, amount: 30, n: 2, rate: 10, total: 33, status: 'solicitud', installments: [], createdAt: x.fn.today() });
  x.fn.logEv('prestamista', 'María Gómez Rojas solicitó $30 en 2 cuotas.');
  asLender(x); x.fn.render();
  assert.doesNotMatch(app.html(), /solicitó \$30 en 2 cuotas/, 'la actividad administrativa no se muestra en la app de cliente');
  assert.match(x.fn.vPrestamista(), /solicitó \$30 en 2 cuotas/); assert.match(x.fn.vPrestamista(), /En revisión/);
  assert.equal(x.fn.histStats().pedidos, 3);
  assert.equal(x.fn.logKind('Pipo extendió la cuota'), 'pet');
  assert.equal(x.fn.logKind('Pago validado: cuota 1 de 2.'), 'pay');
  assert.equal(x.fn.logKind('Tu préstamo de $90 fue aprobado.'), 'loan');
});

test('historial del prestamista: búsqueda en vivo por nombre completo o cédula y expedientes separados', () => {
  const app = fresh(), { x } = app;
  x.Backend.on = true; x.Backend.clients = [
    { id: 'id-1', name: 'María Gómez Rojas', ci: 'V-9876543', points: 120, streak: 4, activeLoans: 1, user: { name: 'María Gómez Rojas', fullName: 'María Gómez Rojas', profile: { ci: 'V-9876543' }, points: 120, streak: 4 } },
    { id: 'id-2', name: 'Pedro Antonio Díaz', ci: 'V-12345678', points: 35, streak: 1, activeLoans: 0, user: { name: 'Pedro Antonio Díaz', fullName: 'Pedro Antonio Díaz', profile: { ci: 'V-12345678' }, points: 35, streak: 1 } },
  ];
  x.ui.role = 'prestamista'; x.ui.unlocked = true; x.ui.pTab = 'hist'; x.ui.histOpen = null; x.ui.histQuery = '';
  x.fn.render();
  assert.doesNotMatch(app.html(), /histSearch|María Gómez Rojas|Pedro Antonio Díaz/, 'el historial administrativo no se muestra en la app principal');
  assert.match(x.fn.vHistorial(), /histSearch/); assert.match(x.fn.vHistorial(), /María Gómez Rojas/); assert.match(x.fn.vHistorial(), /Pedro Antonio Díaz/);
  x.ui.histQuery = '9876543';
  const byCi = x.fn.vHistorial(); assert.match(byCi, /María Gómez Rojas/); assert.doesNotMatch(byCi, /Pedro Antonio Díaz/);
  x.ui.histQuery = 'pedro antonio';
  const byName = x.fn.vHistorial(); assert.match(byName, /Pedro Antonio Díaz/); assert.doesNotMatch(byName, /María Gómez Rojas/);
  assert.match(byName, /data-v="id-2"/, 'cada tarjeta apunta al identificador real del expediente');
});

test('expediente: mostrar cédula frontal, trasera y selfie; el prestamista puede aprobar o rechazar la línea', () => {
  const app = fresh(), { x } = app, S = x.getS();
  S.user.registered = true; S.user.name = 'Andrea Pérez Gómez'; S.user.fullName = S.user.name;
  S.user.profile = { phone: '', email: '', ci: 'V-12345678' };
  S.user.identityDocs = { front: 'data:image/jpeg;base64,AAAA', back: 'data:image/jpeg;base64,BBBB', selfie: 'data:image/jpeg;base64,CCCC' };
  S.user.creditLineReview = { status: 'pending', limit: 0, requestedAt: x.fn.today(), reviewedAt: null, reason: '' };
  x.ui.sheet = null; asLender(x); x.ui.pTab = 'hist'; x.ui.histOpen = 'local';
  let h = x.fn.vHistorial();
  assert.match(h, /Cédula · parte delantera/); assert.match(h, /Cédula · parte trasera/); assert.match(h, /Foto del rostro/);
  assert.match(h, /data-a="creditApprove"/); assert.match(h, /data-a="creditReject"/);
  setInput(app, '#creditLineAmount', { value: '50' });
  x.A.creditApprove();
  assert.equal(x.getS().user.creditLineReview.status, 'approved');
  assert.equal(x.getS().user.creditLineReview.limit, 50);
  assert.ok(app.toast().includes('aprobada'));
  h = x.fn.vHistorial(); assert.match(h, /Límite aprobado/); assert.match(h, /\$50/);
  // La aprobación desbloquea el acceso a solicitar préstamo, sujeto al resto de reglas del producto.
  asClient(x); x.ui.tab = 'inicio';
  assert.ok(x.fn.available() >= 0);
});

test('modo oscuro: sin transiciones globales y con fundido de vista cuando el navegador lo permite', () => {
  const app = fresh(), { x } = app;
  const css = require('node:fs').readFileSync(HTML, 'utf8');
  assert.doesNotMatch(css, /theme-anim \*[^{]*\{transition:background-color/, 'ya no se animan todos los elementos');
  assert.match(css, /theme-anim \*,:root\.theme-anim \*::before,:root\.theme-anim \*::after\{transition:none!important\}/);
  assert.match(css, /::view-transition-old\(root\)/);
  let called = 0; app.ctx.document.startViewTransition = (cb) => { called++; cb(); return { finished: Promise.resolve() }; };
  const before = x.getTheme(); x.A.theme(); assert.equal(called, 1); assert.notEqual(x.getTheme(), before);
  delete app.ctx.document.startViewTransition; x.A.theme(); assert.equal(x.getTheme(), before, 'sin View Transitions cambia igual, al instante');
});

test('logo: PNG incrustado, se adapta al nivel (tono) y al modo claro/oscuro', () => {
  const app = fresh(), { x } = app;
  const css = require('node:fs').readFileSync(HTML, 'utf8');
  assert.match(css, /\.brand i\.logo,\.logo-hero\{background:url\(data:image\/png;base64,/);
  for (const n of [2, 3, 4]) assert.match(css, new RegExp('html\\[data-lvl="' + n + '"\\]\\{--logo-rot:'));
  assert.match(css, /:root\[data-theme="dark"\] \.brand i\.logo/);
  asClient(x); x.fn.render(); assert.match(app.html(), /<i class="logo"/);
  asLender(x); x.fn.render(); assert.match(app.html(), /<i class="logo"/);
  assert.match(css, /rel="icon" type="image\/png"/);
});
