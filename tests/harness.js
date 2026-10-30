'use strict';
/* Carga el script real de la app (index.html) dentro de un contexto de Node con un DOM mínimo simulado.
   Sirve para probar la lógica (mora, abonos, Pipo, reportes, sincronización) sin navegador ni dependencias. */
const vm = require('node:vm');
const fs = require('node:fs');

function loadApp(htmlPath, { fetchImpl, href = 'http://localhost/', storage } = {}) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  const store = storage || new Map();
  const els = {};
  const mk = () => ({
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, id: '',
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    querySelector: () => mk(), querySelectorAll: () => [],
    appendChild(c) { if (c && c.id) els[c.id] = c; }, remove() {}, addEventListener() {},
    closest: () => null, click() {}, focus() {},
    innerHTML: '', textContent: '', value: '', files: [], hidden: false,
  });
  const document = {
    querySelector: (s) => els[s] || (els[s] = mk()),
    querySelectorAll: () => [],
    getElementById: (id) => els[id] || null,
    createElement: (t) => {
      const e = mk();
      if (t === 'canvas') { e.getContext = () => ({ drawImage() {} }); e.toDataURL = () => 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='; }
      return e;
    },
    body: mk(), documentElement: mk(), addEventListener() {}, hidden: false,
  };
  const downloads = [];
  const URLX = class extends URL {};
  URLX.createObjectURL = () => 'blob:test';
  URLX.revokeObjectURL = () => {};
  const ctx = {
    document, console, Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise, Error, RegExp, parseFloat, parseInt, isNaN, Number,
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL: URLX, Blob, TextEncoder, AbortController,
    crypto: globalThis.crypto, fetch: fetchImpl,
    location: new URL(href),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    scrollTo() {},
    FileReader: class { readAsDataURL() { setTimeout(() => { this.result = 'data:image/png;base64,iVBORw0KGgo='; this.onload && this.onload(); }, 0); } },
    Image: class { set src(v) { setTimeout(() => { this.width = 100; this.height = 80; this.onload && this.onload(); }, 0); } },
  };
  ctx.window = ctx;
  ctx.__downloads = downloads;
  const expose = `
;globalThis.__x={A,ui,Backend,
  getS:()=>S,setS:v=>{S=v},getTheme:()=>theme,getShift:()=>SHIFT,
  fn:{payments,vReportes,vPagosCliente,vInicio,vPrestamos,vCalendario,vNivel,vPrestamista,sheetHTML,exportRows,toCsv,csvCell,validBackup,
      vHistorial,logEv,logKind,firstName,isRegistered,histStats,savedPms,rememberPm,safeSrc,loanReceiptHTML,vDesembolsos,isLender,pipoLeft,pipoUsed,owed,instStatus,blocked,today,addDays,money,render,renderSheet,seed,available,level,applyMora,abonoCoversInTime}};
`;
  vm.runInNewContext(js + expose, ctx, { filename: 'app.js' });
  return { x: ctx.__x, els, store, ctx, toast: () => els['#toast'].textContent, html: () => els['#app'].innerHTML };
}

module.exports = { loadApp };
