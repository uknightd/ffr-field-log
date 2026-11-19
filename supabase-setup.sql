-- FFR Field Log: database setup for Supabase
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- Safe to run more than once.

-- ---------- people ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'tech' check (role in ('admin','tech')),
  active boolean not null default false,
  email text default '',
  created_at timestamptz not null default now()
);

-- The first person to get an account becomes the admin (the office); everyone after is a technician.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- New technicians wait for the office to approve them (active = false).
  insert into public.profiles (id, email, full_name, role, active)
  values (new.id, coalesce(new.email,''),
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          case when exists (select 1 from public.profiles) then 'tech' else 'admin' end,
          not exists (select 1 from public.profiles))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin')
$$;

-- ---------- company settings (one row) ----------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  company text not null default 'FFR Comms',
  prefix text not null default 'FFR',
  next_no int not null default 1,
  logo text,               -- small image stored as data URL
  logo_w int, logo_h int,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Hands out the next job number (FFR-0001, FFR-0002, ...) safely across all phones.
create or replace function public.next_job_no() returns text
language plpgsql security definer set search_path = public as $$
declare n int; p text;
begin
  if not public.is_active() then raise exception 'not allowed'; end if;
  update public.settings set next_no = next_no + 1 where id = 1 returning next_no - 1, prefix into n, p;
  return p || '-' || lpad(n::text, 4, '0');
end $$;

-- ---------- clients ----------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  site text default '', contact text default '',
  sla text default '', covers text default '', excludes text default '',
  rate numeric default 0, callout numeric default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- jobs ----------
create table if not exists public.jobs (
  id uuid primary key,
  no text unique,
  client_id uuid references public.clients(id),
  site text default '',
  date date not null default current_date,
  time_in text default '', time_out text default '',
  type text default '' check (type in ('','sla','nonsla','install','maint')),
  reasons text[] not null default '{}',
  reason_note text default '',
  fault text default '', findings text default '', work text default '',
  materials jsonb not null default '[]',
  tech_id uuid references public.profiles(id) default auth.uid(),
  tech_name text default '', tech_sig text default '',
  client_name text default '', client_sig text default '',
  ack boolean not null default false,
  status text not null default 'draft' check (status in ('draft','done')),
  invoiced boolean not null default false,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_date_idx on public.jobs(date);

-- ---------- photos (files live in the private "job-photos" storage bucket) ----------
create table if not exists public.photos (
  id uuid primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage text not null check (stage in ('before','during','after')),
  taken_at timestamptz not null,
  lat double precision, lng double precision, acc double precision,
  path text not null,
  w int, h int,
  created_at timestamptz not null default now()
);
create index if not exists photos_job_idx on public.photos(job_id);

-- ---------- access rules ----------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.clients  enable row level security;
alter table public.jobs     enable row level security;
alter table public.photos   enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select using (public.is_active() or id = auth.uid());
drop policy if exists "profiles admin" on public.profiles;
create policy "profiles admin" on public.profiles for update using (public.is_admin());

-- Everyone signed in can read settings and clients; only the office (admin) changes them.
drop policy if exists "settings read" on public.settings;
create policy "settings read" on public.settings for select using (public.is_active());
drop policy if exists "settings admin" on public.settings;
create policy "settings admin" on public.settings for update using (public.is_admin());

drop policy if exists "clients read" on public.clients;
create policy "clients read" on public.clients for select using (public.is_active());
drop policy if exists "clients write" on public.clients;
create policy "clients write" on public.clients for all using (public.is_admin()) with check (public.is_admin());

-- Everyone sees all jobs. Technicians create and edit their own; the office can edit or delete any.
drop policy if exists "jobs read" on public.jobs;
create policy "jobs read" on public.jobs for select using (public.is_active());
drop policy if exists "jobs insert" on public.jobs;
create policy "jobs insert" on public.jobs for insert with check (public.is_active() and (tech_id = auth.uid() or public.is_admin()));
drop policy if exists "jobs update" on public.jobs;
create policy "jobs update" on public.jobs for update using (public.is_active() and (tech_id = auth.uid() or public.is_admin()));
drop policy if exists "jobs delete" on public.jobs;
create policy "jobs delete" on public.jobs for delete using (public.is_admin() or (tech_id = auth.uid() and status = 'draft'));

drop policy if exists "photos read" on public.photos;
create policy "photos read" on public.photos for select using (public.is_active());
drop policy if exists "photos write" on public.photos;
create policy "photos write" on public.photos for all
  using (public.is_admin() or exists (select 1 from public.jobs j where j.id = job_id and j.tech_id = auth.uid()))
  with check (public.is_admin() or exists (select 1 from public.jobs j where j.id = job_id and j.tech_id = auth.uid()));

-- ---------- photo storage ----------
insert into storage.buckets (id, name, public) values ('job-photos','job-photos', false)
  on conflict (id) do nothing;
drop policy if exists "job photos read" on storage.objects;
create policy "job photos read" on storage.objects for select using (bucket_id = 'job-photos' and public.is_active());
drop policy if exists "job photos upload" on storage.objects;
create policy "job photos upload" on storage.objects for insert with check (bucket_id = 'job-photos' and public.is_active());
drop policy if exists "job photos delete" on storage.objects;
create policy "job photos delete" on storage.objects for delete using (bucket_id = 'job-photos' and (public.is_admin() or owner = auth.uid()));
