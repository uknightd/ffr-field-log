-- FFR Field Log: technicians can add materials that are missing from the price list.
-- They land with no price and needs_price = true; only the office can set prices or change them.
alter table public.materials add column if not exists needs_price boolean not null default false;
alter table public.materials add column if not exists added_by uuid references public.profiles(id) default auth.uid();
create policy "materials tech add unpriced" on public.materials for insert
  with check (public.is_active() and needs_price = true and price = 0);
