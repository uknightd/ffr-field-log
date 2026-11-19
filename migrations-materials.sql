-- FFR Field Log: materials price list (run once after supabase-setup.sql)
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null default 'each',
  price numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.materials enable row level security;
create policy "materials read" on public.materials for select using (public.is_active());
create policy "materials write" on public.materials for all using (public.is_admin()) with check (public.is_admin());
