-- BRASFELS Control Center
-- Snapshot inicial do schema isolado usado pelo painel.

create extension if not exists pgcrypto;
create schema if not exists brasfels;

grant usage on schema brasfels to authenticated, service_role;

create table if not exists brasfels.projects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  client_name text not null default 'BRASFELS',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists brasfels.project_members (
  project_id uuid not null references brasfels.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer','operator','admin')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists brasfels.import_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brasfels.projects(id) on delete cascade,
  source_type text not null,
  file_name text not null,
  file_hash text not null,
  sheet_name text,
  status text not null default 'uploaded',
  total_rows integer not null default 0,
  inserted_rows integer not null default 0,
  updated_rows integer not null default 0,
  unchanged_rows integer not null default 0,
  warning_rows integer not null default 0,
  error_rows integer not null default 0,
  started_by uuid references auth.users(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  validation_summary jsonb not null default '{}'::jsonb,
  error_message text,
  unique (project_id, file_hash)
);

create table if not exists brasfels.spools (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brasfels.projects(id) on delete cascade,
  source_key text not null,
  contract text,
  module text,
  document text,
  subsop text,
  hts_sth text,
  line text,
  manufacturer text,
  isometric text not null,
  spool_number text not null,
  spool_tag text,
  priority text,
  weight_kg numeric,
  on_hold boolean not null default false,
  spool_type text,
  material text,
  diameter_mm numeric,
  diameter_inch text,
  thickness_mm numeric,
  specification text,
  pipe_material text,
  fluid text,
  painting_condition text,
  length_m numeric,
  area_m2 numeric,
  total_joints integer,
  shop_joints integer,
  field_joints integer,
  manufacture_schedule_number text,
  manufacture_schedule_date date,
  cutting_date timestamptz,
  fitting_date timestamptz,
  fitup_date timestamptz,
  welding_date timestamptz,
  visual_inspection_date timestamptz,
  dimensional_date timestamptz,
  manufacture_release_date timestamptz,
  packing_list text,
  origin_location text,
  sent_at timestamptz,
  destination text,
  received_at timestamptz,
  received boolean,
  assembly_schedule_number text,
  assembly_schedule_date date,
  manufacture_status text,
  assembly_status text,
  source_data jsonb not null default '{}'::jsonb,
  manual_data jsonb not null default '{}'::jsonb,
  source_row_hash text not null,
  source_active boolean not null default true,
  first_import_batch_id uuid references brasfels.import_batches(id),
  last_import_batch_id uuid references brasfels.import_batches(id),
  source_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, source_key)
);

create table if not exists brasfels.spool_materials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brasfels.projects(id) on delete cascade,
  spool_id uuid not null references brasfels.spools(id) on delete cascade,
  source_key text not null,
  module text,
  manufacturer_site text,
  assembly_site text,
  spool_revision text,
  material_code text not null,
  description text,
  diameter_1 text,
  diameter_2 text,
  material_revision text,
  initials text,
  application text,
  quantity numeric,
  weight_kg numeric,
  notes text,
  source_data jsonb not null default '{}'::jsonb,
  source_row_hash text not null,
  source_active boolean not null default true,
  first_import_batch_id uuid references brasfels.import_batches(id),
  last_import_batch_id uuid references brasfels.import_batches(id),
  source_last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, source_key)
);

create table if not exists brasfels.manual_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brasfels.projects(id) on delete cascade,
  spool_id uuid references brasfels.spools(id) on delete cascade,
  category text not null default 'general',
  note text not null,
  resolved boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists brasfels.import_staging (
  id bigint generated always as identity primary key,
  batch_id uuid not null references brasfels.import_batches(id) on delete cascade,
  row_number integer not null,
  source_key text,
  row_hash text,
  payload jsonb not null,
  validation_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists brasfels.import_changes (
  id bigint generated always as identity primary key,
  batch_id uuid not null references brasfels.import_batches(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  source_key text not null,
  operation text not null,
  changed_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_brasfels_spools_project_module on brasfels.spools(project_id, module);
create index if not exists idx_brasfels_spools_project_status on brasfels.spools(project_id, manufacture_status);
create index if not exists idx_brasfels_spools_project_hold on brasfels.spools(project_id, on_hold);
create index if not exists idx_brasfels_materials_spool on brasfels.spool_materials(spool_id);
create index if not exists idx_brasfels_materials_code on brasfels.spool_materials(project_id, material_code);
create index if not exists idx_brasfels_imports_project_date on brasfels.import_batches(project_id, started_at desc);

create or replace function brasfels.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_projects_updated_at on brasfels.projects;
create trigger trg_projects_updated_at before update on brasfels.projects
for each row execute function brasfels.set_updated_at();

drop trigger if exists trg_spools_updated_at on brasfels.spools;
create trigger trg_spools_updated_at before update on brasfels.spools
for each row execute function brasfels.set_updated_at();

drop trigger if exists trg_materials_updated_at on brasfels.spool_materials;
create trigger trg_materials_updated_at before update on brasfels.spool_materials
for each row execute function brasfels.set_updated_at();

drop trigger if exists trg_notes_updated_at on brasfels.manual_notes;
create trigger trg_notes_updated_at before update on brasfels.manual_notes
for each row execute function brasfels.set_updated_at();

create or replace function brasfels.has_project_role(p_project_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = brasfels, public
as $$
  select exists (
    select 1
    from brasfels.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = auth.uid()
      and pm.role = any(p_roles)
  );
$$;

grant execute on function brasfels.has_project_role(uuid,text[]) to authenticated;

create or replace view brasfels.v_spool_dashboard
with (security_invoker = true)
as
select
  s.*,
  coalesce(m.material_rows, 0) as material_rows,
  coalesce(m.material_codes, 0) as material_codes,
  coalesce(m.material_weight_kg, 0) as material_weight_kg,
  abs(coalesce(s.weight_kg,0) - coalesce(m.material_weight_kg,0)) as weight_difference_kg,
  case
    when coalesce(s.weight_kg,0) = 0 then 0
    else round(abs(coalesce(s.weight_kg,0) - coalesce(m.material_weight_kg,0)) / s.weight_kg * 100, 4)
  end as weight_difference_pct
from brasfels.spools s
left join lateral (
  select count(*) as material_rows,
         count(distinct sm.material_code) as material_codes,
         sum(coalesce(sm.weight_kg,0)) as material_weight_kg
  from brasfels.spool_materials sm
  where sm.spool_id = s.id and sm.source_active
) m on true;

alter table brasfels.projects enable row level security;
alter table brasfels.project_members enable row level security;
alter table brasfels.import_batches enable row level security;
alter table brasfels.spools enable row level security;
alter table brasfels.spool_materials enable row level security;
alter table brasfels.manual_notes enable row level security;
alter table brasfels.import_staging enable row level security;
alter table brasfels.import_changes enable row level security;

drop policy if exists projects_select on brasfels.projects;
create policy projects_select on brasfels.projects for select to authenticated
using (brasfels.has_project_role(id, array['viewer','operator','admin']));

drop policy if exists members_select on brasfels.project_members;
create policy members_select on brasfels.project_members for select to authenticated
using (brasfels.has_project_role(project_id, array['viewer','operator','admin']));

drop policy if exists members_admin on brasfels.project_members;
create policy members_admin on brasfels.project_members for all to authenticated
using (brasfels.has_project_role(project_id, array['admin']))
with check (brasfels.has_project_role(project_id, array['admin']));

drop policy if exists imports_select on brasfels.import_batches;
create policy imports_select on brasfels.import_batches for select to authenticated
using (brasfels.has_project_role(project_id, array['viewer','operator','admin']));

drop policy if exists imports_write on brasfels.import_batches;
create policy imports_write on brasfels.import_batches for all to authenticated
using (brasfels.has_project_role(project_id, array['operator','admin']))
with check (brasfels.has_project_role(project_id, array['operator','admin']));

drop policy if exists spools_select on brasfels.spools;
create policy spools_select on brasfels.spools for select to authenticated
using (brasfels.has_project_role(project_id, array['viewer','operator','admin']));

drop policy if exists spools_write on brasfels.spools;
create policy spools_write on brasfels.spools for all to authenticated
using (brasfels.has_project_role(project_id, array['operator','admin']))
with check (brasfels.has_project_role(project_id, array['operator','admin']));

drop policy if exists materials_select on brasfels.spool_materials;
create policy materials_select on brasfels.spool_materials for select to authenticated
using (brasfels.has_project_role(project_id, array['viewer','operator','admin']));

drop policy if exists materials_write on brasfels.spool_materials;
create policy materials_write on brasfels.spool_materials for all to authenticated
using (brasfels.has_project_role(project_id, array['operator','admin']))
with check (brasfels.has_project_role(project_id, array['operator','admin']));

drop policy if exists notes_select on brasfels.manual_notes;
create policy notes_select on brasfels.manual_notes for select to authenticated
using (brasfels.has_project_role(project_id, array['viewer','operator','admin']));

drop policy if exists notes_write on brasfels.manual_notes;
create policy notes_write on brasfels.manual_notes for all to authenticated
using (brasfels.has_project_role(project_id, array['operator','admin']))
with check (brasfels.has_project_role(project_id, array['operator','admin']));

grant select on brasfels.projects, brasfels.project_members, brasfels.import_batches,
  brasfels.spools, brasfels.spool_materials, brasfels.manual_notes,
  brasfels.import_staging, brasfels.import_changes, brasfels.v_spool_dashboard to authenticated;

grant insert, update, delete on brasfels.project_members, brasfels.import_batches,
  brasfels.spools, brasfels.spool_materials, brasfels.manual_notes,
  brasfels.import_staging, brasfels.import_changes to authenticated;

grant usage, select on all sequences in schema brasfels to authenticated;

insert into brasfels.projects (code, name, client_name)
values ('FPSO-P85', 'FPSO P85', 'BRASFELS')
on conflict (code) do update set name = excluded.name, active = true;
