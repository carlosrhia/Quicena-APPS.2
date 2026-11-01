// Cliente "Supabase" falso para el navegador: reenvía todo a Node (window.__sb), que lo ejecuta en PGlite.
(function () {
  function call(kind, payload) { return window.__sb(JSON.stringify({ kind, ...payload })).then((r) => JSON.parse(r)); }
  class Query {
    constructor(client, table) { this.c = client; this.t = table; this.f = []; this.op = 'select'; this.cols = '*'; this.ret = null; this.mode = 'many'; this.ord = []; this.lim = null; }
    select(cols) { if (this.op === 'select') this.cols = cols || '*'; else this.ret = cols || '*'; return this; }
    insert(v) { this.op = 'insert'; this.payload = v; return this; }
    update(v) { this.op = 'update'; this.payload = v; return this; }
    upsert(v) { this.op = 'upsert'; this.payload = v; return this; }
    eq(c, v) { this.f.push([c, '=', v]); return this; }
    gt(c, v) { this.f.push([c, '>', v]); return this; }
    order(c, o) { this.ord.push([c, o && o.ascending === false ? 'desc' : 'asc']); return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    then(res, rej) {
      return call('query', { claims: this.c.claims(), uid: this.c.uid(), t: this.t, op: this.op, cols: this.cols, ret: this.ret, f: this.f, ord: this.ord, lim: this.lim, mode: this.mode, payload: this.payload }).then(res, rej);
    }
  }
  class Client {
    constructor(opts) {
      this.key = (opts && opts.auth && opts.auth.storageKey) || 'sb';
      this.persist = !(opts && opts.auth && opts.auth.persistSession === false);
      this.mem = null;
      const self = this;
      this.auth = {
        async signUp({ email, password }) { const r = await call('signUp', { email, password }); if (!r.error) self.setSession(r.data.session); return r; },
        async signInWithPassword({ email, password }) { const r = await call('signIn', { email, password }); if (!r.error) self.setSession(r.data.session); return r; },
        async getSession() { return { data: { session: self.session() }, error: null }; },
        async signOut() { self.setSession(null); return { error: null }; },
        async updateUser({ password }) { return call('updateUser', { uid: self.uid(), password }); },
        async signInWithOtp({ email, options }) { return call('otpSend', { email, create: !(options && options.shouldCreateUser === false) }); },
        async verifyOtp({ email, token }) { const r = await call('otpVerify', { email, token }); if (!r.error) self.setSession(r.data.session); return r; },
      };
      this.storage = { from: (bucket) => ({
        upload: async (path, blob) => { const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); }); return call('upload', { claims: self.claims(), uid: self.uid(), bucket, path, data: b64 }); },
        createSignedUrl: (path) => call('signed', { claims: self.claims(), uid: self.uid(), bucket, path }),
      }) };
    }
    session() { if (!this.persist) return this.mem; try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch (e) { return null; } }
    setSession(s) { if (!this.persist) { this.mem = s; return; } if (s) localStorage.setItem(this.key, JSON.stringify(s)); else localStorage.removeItem(this.key); }
    uid() { const s = this.session(); return s && s.user ? s.user.id : null; }
    claims() { const s = this.session(); return s && s.user ? { sub: s.user.id, email: s.user.email, session_id: s.session_id, amr: s.amr } : {}; }
    from(t) { return new Query(this, t); }
    rpc(name, args) { return { then: (res, rej) => call('rpc', { claims: this.claims(), uid: this.uid(), name, args: args || {} }).then(res, rej) }; }
  }
  window.supabase = { createClient: (url, key, opts) => new Client(opts) };
})();
