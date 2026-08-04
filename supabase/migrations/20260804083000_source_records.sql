-- Bases complementares BRASFELS / P83
-- Armazena as abas-fonte dos arquivos de produção, medição e faturamento.

create table if not exists brasfels.source_records (
  id bigint generated always as identity primary key,
  project_id uuid not null references brasfels.projects(id) on delete cascade,
  dataset_type text not null,
  source_key text not null,
  source_file_hash text not null,
  source_file_name text not null,
  source_sheet text not null,
  source_row integer,
  source_row_hash text not null,
  payload jsonb not null default '{}'::jsonb,
  source_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, dataset_type, source_key)
);

create index if not exists idx_brasfels_source_records_dataset on brasfels.source_records(project_id, dataset_type);
create index if not exists idx_brasfels_source_records_file on brasfels.source_records(project_id, source_file_hash);

alter table brasfels.source_records enable row level security;

drop policy if exists source_records_select on brasfels.source_records;
create policy source_records_select on brasfels.source_records for select to authenticated
using (brasfels.has_project_role(project_id, array['viewer','operator','admin']));

drop policy if exists source_records_write on brasfels.source_records;
create policy source_records_write on brasfels.source_records for all to authenticated
using (brasfels.has_project_role(project_id, array['operator','admin']))
with check (brasfels.has_project_role(project_id, array['operator','admin']));

grant select, insert, update, delete on brasfels.source_records to authenticated;
grant usage, select on all sequences in schema brasfels to authenticated;

create or replace function brasfels.touch_source_record()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_source_records_updated_at on brasfels.source_records;
create trigger trg_source_records_updated_at before update on brasfels.source_records
for each row execute function brasfels.touch_source_record();

create or replace view brasfels.v_source_dataset_summary
with (security_invoker = true) as
select project_id, dataset_type, source_sheet,
       count(*) filter (where source_active) as active_rows,
       max(updated_at) as last_updated_at,
       max(source_file_name) filter (where source_active) as source_file_name
from brasfels.source_records
group by project_id, dataset_type, source_sheet;

grant select on brasfels.v_source_dataset_summary to authenticated;
