-- =====================================================================
-- Quincena · esquema de base de datos para Supabase (plan gratuito) · v3
-- ---------------------------------------------------------------------
-- Cómo usarlo: Supabase → SQL Editor → New query → pega TODO este
-- archivo → Run. Se puede ejecutar varias veces sin romper nada.
--
-- Qué crea:
--   staff        personal del panel (administrador y cobrador)
--   clients      un expediente por cliente (estado de la app en JSON)
--   client_history  copias de cada versión del expediente
--   assignments  qué clientes atiende cada cobrador
--   audit        quién hizo qué y cuándo
--   bucket "documentos" (privado) para cédula, rostro y comprobantes
--
-- La seguridad la aplica la propia base de datos (Row Level Security):
--   * el cliente solo ve y modifica su expediente, y no puede aprobarse
--     líneas, préstamos ni pagos (lo vigila el trigger quincena_guard);
--   * el administrador ve todo; el cobrador solo sus clientes asignados.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- tablas ----------
create table if not exists public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  name       text not null,
  role       text not null check (role in ('admin', 'cobrador')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

create table if not exists public.clients (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null,
  ci         text not null,
  ci_key     text not null unique,
  version    integer not null default 1,
  state      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_history (
  client_id  uuid not null references public.clients (id) on delete cascade,
  version    integer not null,
  state      jsonb not null,
  actor      text,
  created_at timestamptz not null default now(),
  primary key (client_id, version)
);

create table if not exists public.assignments (
  user_id    uuid not null references public.staff (user_id) on delete cascade,
  client_id  uuid not null references public.clients (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
create index if not exists assignments_client on public.assignments (client_id);

create table if not exists public.audit (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  actor  text,
  action text not null,
  detail text
);

-- ---------- verificación en dos pasos del personal (v3): contraseña + código por correo ----------
-- La sesión del panel solo cuenta como "personal" si superó los dos pasos en esta misma sesión.
create table if not exists public.staff_2fa (
  user_id           uuid primary key references public.staff (user_id) on delete cascade,
  password_at       timestamptz,
  verified_sessions text[] not null default '{}'
);
alter table public.staff_2fa enable row level security;

create or replace function public.jwt_has_method(methods text[]) returns boolean
language sql stable as $$
  select exists (select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) x
                 where x ->> 'method' = any (methods));
$$;

-- ¿Esta sesión cumple la verificación en dos pasos? (obligatoria para administradores;
-- para cobradores solo si en Ajustes se activa "staff2faAll"; "staff2fa": false la desactiva para todos)
create or replace function public.staff_2fa_ok(uid uuid, r text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare cfg jsonb;
begin
  select data into cfg from public.app_settings where id = 1;
  cfg := coalesce(cfg, '{}'::jsonb);
  if coalesce(cfg ->> 'staff2fa', 'true') = 'false' then return true; end if;
  if r <> 'admin' and coalesce(cfg ->> 'staff2faAll', 'false') <> 'true' then return true; end if;
  return exists (select 1 from public.staff_2fa f
                 where f.user_id = uid and (auth.jwt() ->> 'session_id') = any (f.verified_sessions));
end;
$$;

-- ---------- funciones de apoyo para los permisos ----------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active and public.staff_2fa_ok(user_id, role));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active and role = 'admin' and public.staff_2fa_ok(user_id, role));
$$;

-- ¿El usuario actual (personal) puede ver este expediente?
create or replace function public.can_see_client(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active and public.staff_2fa_ok(s.user_id, s.role)
      and (s.role = 'admin'
           or exists (select 1 from public.assignments a where a.user_id = s.user_id and a.client_id = cid))
  );
$$;

-- Carpeta del bucket = id del cliente. Acceso: el propio cliente o el personal autorizado.
create or replace function public.can_use_folder(folder text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if folder is null or folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return folder = auth.uid()::text or public.can_see_client(folder::uuid);
end;
$$;

-- Nombre del autor para la auditoría: "admin:correo", "cobrador:correo" o "cliente".
create or replace function public.actor_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role || ':' || email from public.staff where user_id = auth.uid()),
    case when auth.uid() is null then 'sistema' else 'cliente' end);
$$;

create or replace function public.q_num(j jsonb) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric else 0 end;
$$;

create or replace function public.q_arr(j jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end;
$$;

create or replace function public.q_txt(j jsonb) returns text
language sql immutable as $$
  select case when j is null or jsonb_typeof(j) = 'null' then '' else j #>> '{}' end;
$$;

-- ---------- reglas: lo que el cliente NO puede cambiar en su expediente ----------
-- Devuelve el motivo del rechazo o NULL si el cambio es válido.
create or replace function public.quincena_guard(o jsonb, n jsonb) returns text
language plpgsql stable set search_path = public as $$
declare
  ou jsonb := coalesce(o -> 'user', '{}'::jsonb);
  nu jsonb := coalesce(n -> 'user', '{}'::jsonb);
  k text; e jsonb; v jsonb; p jsonb; l jsonb; pinst jsonb; linst jsonb; i jsonb; o2 jsonb; a jsonb; pa jsonb;
  ob numeric; nb numeric; oldr jsonb; newr jsonb; oldlog jsonb;
  cfg jsonb; rate numeric; maxn int; docs_open boolean;
begin
  if n is null or jsonb_typeof(n) <> 'object' or q_txt(n -> 'v') <> '3'
     or jsonb_typeof(n -> 'loans') is distinct from 'array'
     or jsonb_typeof(n -> 'user') is distinct from 'object'
     or jsonb_typeof(n -> 'config') is distinct from 'object'
     or jsonb_typeof(n -> 'notes') is distinct from 'array' then
    return 'Estado inválido.';
  end if;
  if o is null then return null; end if;

  if (o -> 'config') is distinct from (n -> 'config') then return 'El cliente no puede cambiar la configuración.'; end if;
  if q_num(o -> 'shift') <> q_num(n -> 'shift') then return 'El cliente no puede cambiar la fecha de la app.'; end if;
  if (ou -> 'points') is distinct from (nu -> 'points') then return 'El cliente no puede cambiar sus puntos.'; end if;
  if q_num(nu -> 'streak') > q_num(ou -> 'streak') then return 'El cliente no puede aumentar su racha.'; end if;
  ob := q_num(ou -> 'petBonusCredit'); nb := q_num(nu -> 'petBonusCredit');
  if nb > ob and (nb - ob > 10 or q_num(ou -> 'streak') - q_num(nu -> 'streak') < 5) then return 'Bono de mascota no válido.'; end if;
  if (ou -> 'levelOverride') is distinct from (nu -> 'levelOverride') then return 'Solo el prestamista puede cambiar tu nivel.'; end if;
  if (ou -> 'accountBlocked') is distinct from (nu -> 'accountBlocked') then return 'Solo el prestamista puede bloquear o desbloquear la cuenta.'; end if;
  docs_open := q_txt(ou #> '{creditLineReview,status}') = 'docs';

  if q_txt(ou -> 'registered') = 'true' and (
       q_txt(nu -> 'fullName') <> q_txt(ou -> 'fullName')
       or q_txt(nu #> '{profile,ci}') <> q_txt(ou #> '{profile,ci}')) then
    return 'El cliente no puede cambiar su nombre ni su cédula.';
  end if;

  foreach k in array array['front', 'back', 'selfie'] loop
    if not docs_open and q_txt(ou #> array['identityDocs', k]) <> '' and q_txt(ou #> array['identityDocs', k]) <> q_txt(nu #> array['identityDocs', k]) then
      return 'Los documentos de identidad ya enviados no se pueden sustituir desde esta cuenta; contacta al prestamista.';
    end if;
  end loop;

  oldr := ou -> 'creditLineReview'; newr := nu -> 'creditLineReview';
  if docs_open then
    -- el prestamista pidió fotos nuevas: el cliente puede reenviarlas y volver a "pendiente"
    if jsonb_typeof(newr) is distinct from 'object' or q_txt(newr -> 'status') not in ('docs', 'pending') or q_num(newr -> 'limit') <> 0 then
      return 'Solo el prestamista puede aprobar o rechazar una línea de crédito.';
    end if;
  elsif jsonb_typeof(oldr) = 'object' then
    if jsonb_typeof(newr) is distinct from 'object'
       or q_txt(oldr -> 'status') <> q_txt(newr -> 'status')
       or q_num(oldr -> 'limit') <> q_num(newr -> 'limit')
       or q_txt(oldr -> 'reviewedAt') <> q_txt(newr -> 'reviewedAt')
       or q_txt(oldr -> 'reason') <> q_txt(newr -> 'reason') then
      return 'Solo el prestamista puede aprobar o rechazar una línea de crédito.';
    end if;
  elsif jsonb_typeof(newr) = 'object' and q_txt(newr -> 'status') <> 'pending' then
    return 'La línea debe esperar la revisión del prestamista.';
  end if;

  -- historial: no se borra ni se modifica (salvo el recorte automático a 500 eventos)
  oldlog := q_arr(o -> 'log');
  for e in select x from jsonb_array_elements(oldlog) x loop
    select x into v from jsonb_array_elements(q_arr(n -> 'log')) x where x -> 'id' = e -> 'id' limit 1;
    if v is null then
      if jsonb_array_length(oldlog) < 500 then return 'El historial no se puede borrar.'; end if;
    elsif v <> e then
      return 'El historial no se puede modificar.';
    end if;
    v := null;
  end loop;

  -- préstamos
  for p in select x from jsonb_array_elements(q_arr(o -> 'loans')) x loop
    if not exists (select 1 from jsonb_array_elements(n -> 'loans') x where x -> 'id' = p -> 'id') then
      return 'No se pueden borrar préstamos.';
    end if;
  end loop;

  cfg := coalesce((select data from public.app_settings where id = 1), '{}'::jsonb);
  for l in select x from jsonb_array_elements(n -> 'loans') x loop
    p := null;
    select x into p from jsonb_array_elements(q_arr(o -> 'loans')) x where x -> 'id' = l -> 'id' limit 1;
    if p is null then
      if q_txt(l -> 'status') <> 'solicitud' or jsonb_array_length(q_arr(l -> 'installments')) > 0
         or (jsonb_typeof(l -> 'desembolso') is not null and jsonb_typeof(l -> 'desembolso') <> 'null') then
        return 'Un préstamo nuevo debe ser una solicitud.';
      end if;
      if q_txt(nu -> 'accountBlocked') = 'true' then return 'Tu cuenta está bloqueada. Contacta al prestamista.'; end if;
      if (select count(*) from jsonb_array_elements(n -> 'loans') x where q_txt(x -> 'status') = 'solicitud') > 1 then
        return 'Ya tienes una solicitud en revisión. Espera la respuesta del prestamista.';
      end if;
      -- la comisión y el total deben coincidir con los ajustes del negocio
      if jsonb_typeof(cfg -> 'rates') = 'object' then
        maxn := coalesce((select max(q_num(x -> 'maxN'))::int from jsonb_array_elements(q_arr(cfg -> 'levels')) x), 3);
        if q_num(l -> 'n') < 1 or q_num(l -> 'n') > maxn or q_num(l -> 'amount') <= 0 then return 'Solicitud inválida.'; end if;
        rate := q_num(cfg #> array['rates', q_txt(l -> 'n')]);
        if q_num(l -> 'rate') <> rate or abs(q_num(l -> 'total') - round(q_num(l -> 'amount') * (1 + rate / 100), 2)) > 0.011 then
          return 'Las condiciones del préstamo cambiaron. Actualiza la app y vuelve a solicitarlo.';
        end if;
      end if;
      continue;
    end if;
    if q_txt(p -> 'status') <> q_txt(l -> 'status') then return 'El cliente no puede cambiar el estado de un préstamo.'; end if;
    foreach k in array array['amount', 'n', 'rate', 'total'] loop
      if (p -> k) is distinct from (l -> k) then return 'Los datos del préstamo no se pueden modificar.'; end if;
    end loop;
    if coalesce(p -> 'desembolso', 'null'::jsonb) <> coalesce(l -> 'desembolso', 'null'::jsonb) then
      return 'Solo el prestamista puede registrar el comprobante de desembolso.';
    end if;
    pinst := q_arr(p -> 'installments'); linst := q_arr(l -> 'installments');
    if jsonb_array_length(pinst) <> jsonb_array_length(linst) then return 'Las cuotas no se pueden agregar ni quitar.'; end if;
    for i in select x from jsonb_array_elements(linst) x loop
      o2 := null;
      select x into o2 from jsonb_array_elements(pinst) x where x -> 'n' = i -> 'n' limit 1;
      if o2 is null then return 'Cuota inválida.'; end if;
      if q_txt(o2 -> 'status') <> q_txt(i -> 'status')
         and not (q_txt(o2 -> 'status') = 'pending' and q_txt(i -> 'status') = 'validating') then
        return 'El cliente no puede validar ni rechazar pagos.';
      end if;
      if (o2 -> 'amount') is distinct from (i -> 'amount') then return 'El monto de una cuota no se puede modificar.'; end if;
      if q_txt(o2 -> 'paidOn') <> q_txt(i -> 'paidOn') then return 'El cliente no puede marcar pagos como validados.'; end if;
      for a in select x from jsonb_array_elements(q_arr(i -> 'abonos')) x loop
        pa := null;
        select x into pa from jsonb_array_elements(q_arr(o2 -> 'abonos')) x where x -> 'id' = a -> 'id' limit 1;
        if pa is null then
          if q_txt(a -> 'status') <> 'validating' then return 'Un abono nuevo debe quedar en validación.'; end if;
        elsif q_txt(pa -> 'status') <> q_txt(a -> 'status') or (pa -> 'amount') is distinct from (a -> 'amount') then
          return 'El cliente no puede modificar abonos ya enviados.';
        end if;
      end loop;
      for a in select x from jsonb_array_elements(q_arr(o2 -> 'abonos')) x loop
        if not exists (select 1 from jsonb_array_elements(q_arr(i -> 'abonos')) x where x -> 'id' = a -> 'id') then
          return 'No se pueden borrar abonos.';
        end if;
      end loop;
    end loop;
  end loop;
  return null;
end;
$$;

-- ---------- triggers del expediente ----------
create or replace function public.clients_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare err text; d jsonb;
begin
  new.name := regexp_replace(trim(coalesce(new.name, '')), '\s+', ' ', 'g');
  new.ci := upper(trim(coalesce(new.ci, '')));
  new.ci_key := regexp_replace(new.ci, '[^A-Z0-9]', '', 'g');
  if public.is_staff() then
    raise exception 'El personal no crea expedientes desde aquí: el cliente se registra desde la app.';
  end if;
  if new.id is distinct from auth.uid() then raise exception 'Solo puedes crear tu propio expediente.'; end if;
  if length(new.name) < 5 or array_length(regexp_split_to_array(new.name, ' '), 1) < 2 then
    raise exception 'Escribe tu nombre completo (nombre y apellido).';
  end if;
  if new.ci !~ '^[VEJGP]-?[0-9]{6,9}$' then raise exception 'Cédula inválida. Ejemplo: V-12345678.'; end if;
  if exists (select 1 from public.clients where ci_key = new.ci_key) then
    raise exception 'Esta cédula ya está registrada.';
  end if;
  err := public.quincena_guard(null, new.state);
  if err is not null then raise exception '%', err; end if;
  d := coalesce(new.state #> '{user,identityDocs}', '{}'::jsonb);
  if q_txt(d -> 'front') = '' or q_txt(d -> 'selfie') = '' then
    raise exception 'Para crear la cuenta debes adjuntar la foto de tu cédula y la foto de tu rostro.';
  end if;
  if exists (select 1 from jsonb_array_elements(new.state -> 'loans') x
             where q_txt(x -> 'status') <> 'solicitud' or jsonb_array_length(q_arr(x -> 'installments')) > 0) then
    raise exception 'Una cuenta nueva no puede traer préstamos aprobados.';
  end if;
  -- La línea empieza siempre pendiente; puntos y racha empiezan en cero.
  new.state := jsonb_set(new.state, '{user,creditLineReview}', jsonb_build_object(
    'status', 'pending', 'limit', 0, 'requestedAt', to_char(now(), 'YYYY-MM-DD'), 'reviewedAt', null, 'reason', ''));
  new.state := jsonb_set(new.state, '{user,points}', '0');
  new.state := jsonb_set(new.state, '{user,streak}', '0');
  new.state := jsonb_set(new.state, '{user,petBonusCredit}', '0');
  new.state := jsonb_set(new.state, '{user,registered}', 'true');
  new.state := jsonb_set(new.state, '{user,fullName}', to_jsonb(new.name));
  new.state := jsonb_set(new.state, '{user,profile}', coalesce(new.state #> '{user,profile}', '{}'::jsonb) || jsonb_build_object('ci', new.ci));
  new.state := new.state #- '{user,passHash}';
  new.version := 1;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.clients_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare err text;
begin
  if new.id <> old.id then raise exception 'No se puede cambiar el identificador.'; end if;
  if public.can_see_client(old.id) then
    -- personal: solo se valida la forma del expediente
    if q_txt(new.state -> 'v') <> '3' or jsonb_typeof(new.state -> 'loans') is distinct from 'array'
       or jsonb_typeof(new.state -> 'user') is distinct from 'object' then
      raise exception 'Estado inválido.';
    end if;
    new.name := coalesce(nullif(trim(q_txt(new.state #> '{user,fullName}')), ''), old.name);
    new.ci := coalesce(nullif(upper(trim(q_txt(new.state #> '{user,profile,ci}'))), ''), old.ci);
    new.ci_key := regexp_replace(new.ci, '[^A-Z0-9]', '', 'g');
  elsif old.id = auth.uid() then
    err := public.quincena_guard(old.state, new.state);
    if err is not null then raise exception '%', err; end if;
    new.name := old.name; new.ci := old.ci; new.ci_key := old.ci_key;
  else
    raise exception 'Acceso denegado.';
  end if;
  new.created_at := old.created_at;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.clients_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.client_history (client_id, version, state, actor)
  values (new.id, new.version, new.state, public.actor_name())
  on conflict (client_id, version) do update set state = excluded.state, actor = excluded.actor, created_at = now();
  -- conserva las últimas 60 versiones de cada expediente
  delete from public.client_history where client_id = new.id and version <= new.version - 60;
  insert into public.audit (actor, action, detail)
  values (public.actor_name(), case when tg_op = 'INSERT' then 'client.register' else 'client.state.put' end,
          new.name || ' · C.I. ' || new.ci || ' · v' || new.version);
  return null;
end;
$$;

drop trigger if exists clients_before_insert on public.clients;
create trigger clients_before_insert before insert on public.clients for each row execute function public.clients_before_insert();
drop trigger if exists clients_before_update on public.clients;
create trigger clients_before_update before update on public.clients for each row execute function public.clients_before_update();
drop trigger if exists clients_after_write on public.clients;
create trigger clients_after_write after insert or update on public.clients for each row execute function public.clients_after_write();


-- ---------- ajustes del negocio (v2): comisiones, niveles, mora, Pipo, pago móvil y capital ----------
create table if not exists public.app_settings (
  id         integer primary key check (id = 1),
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.app_settings (id, data) values (1, jsonb_build_object(
  'rates', jsonb_build_object('1', 30, '2', 35, '3', 40),
  'levels', jsonb_build_array(
    jsonb_build_object('limit', 50, 'maxN', 2), jsonb_build_object('limit', 70, 'maxN', 2),
    jsonb_build_object('limit', 90, 'maxN', 3), jsonb_build_object('limit', 110, 'maxN', 3)),
  'mora', 4, 'pipoMax', 3, 'capital', 0,
  'payDetail', 'Banco 0191 (BNC) · Tel. 0424-8411730 · C.I. V-31513004',
  'autoReminder', true, 'autoMora', true))
on conflict (id) do nothing;

-- notas internas: solo el personal las ve (no forman parte del expediente que lee el cliente)
create table if not exists public.client_notes (
  client_id  uuid primary key references public.clients (id) on delete cascade,
  note       text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

-- cierres de quincena
create table if not exists public.closings (
  id         bigserial primary key,
  label      text not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  actor      text
);

-- ---------- permisos por fila (RLS) ----------
alter table public.staff          enable row level security;
alter table public.clients        enable row level security;
alter table public.client_history enable row level security;
alter table public.assignments    enable row level security;
alter table public.audit          enable row level security;
alter table public.app_settings   enable row level security;
alter table public.client_notes   enable row level security;
alter table public.closings       enable row level security;

drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select to authenticated using (true);

drop policy if exists notes_select on public.client_notes;
create policy notes_select on public.client_notes for select to authenticated using (public.can_see_client(client_id));
drop policy if exists notes_insert on public.client_notes;
create policy notes_insert on public.client_notes for insert to authenticated with check (public.can_see_client(client_id));
drop policy if exists notes_update on public.client_notes;
create policy notes_update on public.client_notes for update to authenticated using (public.can_see_client(client_id)) with check (public.can_see_client(client_id));

drop policy if exists closings_select on public.closings;
create policy closings_select on public.closings for select to authenticated using (public.is_admin());
drop policy if exists closings_insert on public.closings;
create policy closings_insert on public.closings for insert to authenticated with check (public.is_admin());

drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select to authenticated
  using (id = auth.uid() or public.can_see_client(id));
drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert to authenticated
  with check (id = auth.uid());
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using (id = auth.uid() or public.can_see_client(id))
  with check (id = auth.uid() or public.can_see_client(id));
drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients for delete to authenticated
  using (public.is_admin());

drop policy if exists history_select on public.client_history;
create policy history_select on public.client_history for select to authenticated
  using (public.can_see_client(client_id));

drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists audit_select on public.audit;
create policy audit_select on public.audit for select to authenticated
  using (public.is_admin());

-- ---------- funciones que llama la app ----------
-- Quién soy: devuelve el rol del usuario que inició sesión y registra el acceso.
create or replace function public.whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.staff; c public.clients;
begin
  if auth.uid() is null then return null; end if;
  select * into s from public.staff where user_id = auth.uid();
  if found then
    if not s.active then return jsonb_build_object('role', 'disabled'); end if;
    if not public.staff_2fa_ok(s.user_id, s.role) then
      return jsonb_build_object('role', s.role, 'id', s.user_id, 'email', s.email, 'name', s.name, 'twofa', 'required');
    end if;
    update public.staff set last_login = now() where user_id = s.user_id;
    insert into public.audit (actor, action) values (s.role || ':' || s.email, 'staff.auth.ok');
    return jsonb_build_object('role', s.role, 'id', s.user_id, 'email', s.email, 'name', s.name, 'twofa', 'ok');
  end if;
  select * into c from public.clients where id = auth.uid();
  if found then return jsonb_build_object('role', 'cliente', 'id', c.id, 'name', c.name); end if;
  return jsonb_build_object('role', 'none');
end;
$$;

-- Alta o edición de personal (solo administrador). El usuario debe existir en Authentication.
create or replace function public.admin_save_staff(p_email text, p_name text, p_role text, p_active boolean, p_clients uuid[])
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare uid uuid; em text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_admin() then raise exception 'Solo el administrador puede gestionar usuarios.'; end if;
  if p_role not in ('admin', 'cobrador') then raise exception 'Rol inválido.'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Escribe el nombre (mínimo 3 caracteres).'; end if;
  select id into uid from auth.users where lower(email) = em;
  if uid is null then raise exception 'No existe ninguna cuenta con el correo %.', em; end if;
  if exists (select 1 from public.clients where id = uid) then
    raise exception 'Ese correo pertenece a un cliente; usa otro correo para el personal.';
  end if;
  if uid = auth.uid() and (p_role <> 'admin' or not coalesce(p_active, true)) then
    raise exception 'No puedes quitarte el rol de administrador ni desactivarte a ti mismo.';
  end if;
  insert into public.staff (user_id, email, name, role, active)
  values (uid, em, trim(p_name), p_role, coalesce(p_active, true))
  on conflict (user_id) do update set email = excluded.email, name = excluded.name, role = excluded.role, active = excluded.active;
  delete from public.assignments where user_id = uid;
  if p_role = 'cobrador' and p_clients is not null then
    insert into public.assignments (user_id, client_id)
    select uid, c from unnest(p_clients) c where exists (select 1 from public.clients where id = c)
    on conflict do nothing;
  end if;
  insert into public.audit (actor, action, detail) values (public.actor_name(), 'staff.save', em || ' · ' || p_role || case when coalesce(p_active, true) then '' else ' · desactivado' end);
  return jsonb_build_object('id', uid);
end;
$$;

-- Registro de eventos desde la app (por ejemplo, lectura de documentos).
create or replace function public.log_event(p_action text, p_detail text default null) returns void
language sql security definer set search_path = public as $$
  insert into public.audit (actor, action, detail)
  select public.actor_name(), left(coalesce(p_action, 'evento'), 60), left(p_detail, 300)
  where auth.uid() is not null;
$$;

revoke all on function public.admin_save_staff(text, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.admin_save_staff(text, text, text, boolean, uuid[]) to authenticated;
revoke all on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;
revoke all on function public.log_event(text, text) from public, anon;
grant execute on function public.log_event(text, text) to authenticated;


-- Guardar los ajustes del negocio (solo administrador). La app del cliente los lee al entrar.
create or replace function public.admin_save_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; lv jsonb;
begin
  if not public.is_admin() then raise exception 'Solo el administrador puede cambiar los ajustes.'; end if;
  foreach k in array array['1', '2', '3'] loop
    if jsonb_typeof(p #> array['rates', k]) <> 'number' or q_num(p #> array['rates', k]) < 0 or q_num(p #> array['rates', k]) > 200 then
      raise exception 'Comisión inválida para % cuota(s).', k;
    end if;
  end loop;
  if jsonb_array_length(q_arr(p -> 'levels')) <> 4 then raise exception 'Deben existir 4 niveles.'; end if;
  for lv in select x from jsonb_array_elements(p -> 'levels') x loop
    if q_num(lv -> 'limit') < 10 or q_num(lv -> 'limit') > 100000 or q_num(lv -> 'maxN') not in (1, 2, 3) then
      raise exception 'Revisa los límites (mín. $10) y las cuotas (1 a 3) de cada nivel.';
    end if;
  end loop;
  if q_num(p -> 'mora') < 0 or q_num(p -> 'pipoMax') < 0 or q_num(p -> 'pipoMax') > 31 or q_num(p -> 'capital') < 0 then
    raise exception 'Revisa el recargo, los usos de Pipo y el capital.';
  end if;
  update public.app_settings set data = p, updated_at = now(), updated_by = public.actor_name() where id = 1;
  insert into public.audit (actor, action, detail) values (public.actor_name(), 'settings.save', left(p::text, 300));
  return p;
end;
$$;

-- Ajusta el capital disponible (al desembolsar resta, al cobrar suma). Personal del panel.
create or replace function public.staff_adjust_capital(p_delta numeric, p_reason text) returns numeric
language plpgsql security definer set search_path = public as $$
declare v numeric;
begin
  if not public.is_staff() then raise exception 'Acceso denegado.'; end if;
  update public.app_settings
     set data = jsonb_set(data, '{capital}', to_jsonb(round(greatest(0, q_num(data -> 'capital') + coalesce(p_delta, 0)), 2)))
   where id = 1
  returning q_num(data -> 'capital') into v;
  insert into public.audit (actor, action, detail) values (public.actor_name(), 'capital.adjust', coalesce(p_delta, 0)::text || ' · ' || left(coalesce(p_reason, ''), 200));
  return v;
end;
$$;

-- Restablecer la contraseña de un cliente (solo administrador). Mín. 8 caracteres.
create or replace function public.admin_set_client_password(p_client uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador puede restablecer contraseñas.'; end if;
  if length(coalesce(p_password, '')) < 8 or p_password !~ '[A-Za-zÁÉÍÓÚáéíóúÑñ]' or p_password !~ '[0-9]' then
    raise exception 'La contraseña debe tener al menos 8 caracteres, con letras y números.';
  end if;
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'Cliente no encontrado.'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_client;
  insert into public.audit (actor, action, detail)
  select public.actor_name(), 'client.password.reset', name || ' · C.I. ' || ci from public.clients where id = p_client;
end;
$$;

revoke all on function public.admin_save_settings(jsonb) from public, anon;
grant execute on function public.admin_save_settings(jsonb) to authenticated;
revoke all on function public.staff_adjust_capital(numeric, text) from public, anon;
grant execute on function public.staff_adjust_capital(numeric, text) to authenticated;
revoke all on function public.admin_set_client_password(uuid, text) from public, anon;
grant execute on function public.admin_set_client_password(uuid, text) to authenticated;


-- Paso 1 (tras entrar con contraseña): deja constancia y dice si hace falta el código por correo.
create or replace function public.staff_2fa_begin() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.staff;
begin
  select * into s from public.staff where user_id = auth.uid();
  if not found then
    if exists (select 1 from public.clients where id = auth.uid()) then
      raise exception 'Esta es una cuenta de cliente: entra desde la app, no desde el panel.';
    end if;
    raise exception 'Esta cuenta no tiene acceso al panel. El administrador debe darla de alta.';
  end if;
  if not s.active then raise exception 'Tu cuenta del panel está desactivada. Habla con el administrador.'; end if;
  if public.staff_2fa_ok(s.user_id, s.role) then return jsonb_build_object('required', false); end if;
  if not public.jwt_has_method(array['password']) then raise exception 'Primero entra con tu contraseña.'; end if;
  insert into public.staff_2fa (user_id, password_at) values (s.user_id, now())
  on conflict (user_id) do update set password_at = now();
  return jsonb_build_object('required', true, 'email', s.email);
end;
$$;

-- Paso 2 (tras validar el código del correo): marca esta sesión como verificada.
create or replace function public.staff_2fa_complete() returns boolean
language plpgsql security definer set search_path = public as $$
declare s public.staff; f public.staff_2fa; sid text := auth.jwt() ->> 'session_id';
begin
  select * into s from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'Esta cuenta no tiene acceso al panel.'; end if;
  if not public.jwt_has_method(array['otp', 'magiclink', 'email']) then raise exception 'Falta validar el código enviado al correo.'; end if;
  select * into f from public.staff_2fa where user_id = s.user_id;
  if not found or f.password_at is null or f.password_at < now() - interval '15 minutes' then
    raise exception 'El inicio de sesión caducó. Vuelve a escribir tu contraseña.';
  end if;
  if sid is null then raise exception 'Sesión inválida.'; end if;
  update public.staff_2fa
     set password_at = null,
         verified_sessions = (array_append(array_remove(verified_sessions, sid), sid))[greatest(1, cardinality(verified_sessions) - 8):]
   where user_id = s.user_id;
  insert into public.audit (actor, action) values (s.role || ':' || s.email, 'staff.2fa.ok');
  return true;
end;
$$;

revoke all on function public.staff_2fa_begin() from public, anon;
grant execute on function public.staff_2fa_begin() to authenticated;
revoke all on function public.staff_2fa_complete() from public, anon;
grant execute on function public.staff_2fa_complete() to authenticated;

-- ---------- almacenamiento privado de imágenes ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos', 'documentos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Límite antiabuso: cada cliente puede subir como máximo 20 imágenes cada 24 horas (el personal no tiene límite).
create or replace function public.uploads_today(folder text) returns integer
language sql stable security definer set search_path = public, storage as $$
  select count(*)::int from storage.objects o
  where o.bucket_id = 'documentos' and (storage.foldername(o.name))[1] = folder and o.created_at > now() - interval '24 hours';
$$;

drop policy if exists quincena_docs_insert on storage.objects;
create policy quincena_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and public.can_use_folder((storage.foldername(name))[1])
              and (public.is_staff() or public.uploads_today((storage.foldername(name))[1]) < 20));
drop policy if exists quincena_docs_select on storage.objects;
create policy quincena_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and public.can_use_folder((storage.foldername(name))[1]));

-- =====================================================================
-- SI TE QUEDAS SIN ACCESO AL PANEL porque no llega el código del correo, desactiva
-- temporalmente la verificación en dos pasos (y vuelve a activarla con 'true'):
--   update public.app_settings set data = jsonb_set(data, '{staff2fa}', 'false') where id = 1;
-- ---------------------------------------------------------------------
-- PRIMER ADMINISTRADOR (ejecútalo aparte, después de crear tu usuario en
-- Authentication → Users → Add user, con "Auto Confirm User" marcado).
-- Cambia el correo y el nombre y pulsa Run:
--
--   insert into public.staff (user_id, email, name, role)
--   select id, lower(email), 'Tu Nombre', 'admin' from auth.users
--   where lower(email) = lower('tu-correo@ejemplo.com')
--   on conflict (user_id) do update set role = 'admin', active = true;
-- =====================================================================
