'use strict';
/*
 * Vercel Function: entrega a la app y al panel los datos PÚBLICOS de Supabase
 * (la URL del proyecto y la clave "anon"/"publishable"), leídos de las variables
 * de entorno del proyecto en Vercel: SUPABASE_URL y SUPABASE_ANON_KEY.
 * Nunca pongas aquí la clave "service_role"/"secret".
 */
module.exports = (req, res) => {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const cfg = url && anonKey ? { url, anonKey } : {};
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end('window.QUINCENA_CONFIG=' + JSON.stringify(cfg) + ';');
};
