/*
 * Configuración de Supabase — alternativa a las variables de entorno de Vercel.
 * Si ya definiste SUPABASE_URL y SUPABASE_ANON_KEY en Vercel, NO toques este archivo.
 * Si no, escribe aquí la "Project URL" y la clave "anon public" (Supabase → Project Settings → API).
 * Ambas son públicas por diseño: la seguridad la ponen las reglas de supabase/schema.sql.
 * NUNCA pongas aquí la clave "service_role".
 */
(function () {
  var manual = { url: '', anonKey: '' };
  var c = window.QUINCENA_CONFIG;
  if (!(c && c.url && c.anonKey) && manual.url && manual.anonKey) window.QUINCENA_CONFIG = manual;
})();
