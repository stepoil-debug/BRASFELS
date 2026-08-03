-- Mantém Douglas como administrador principal do projeto BRASFELS.
insert into brasfels.project_members (project_id, user_id, role)
select p.id, u.id, 'admin'
from brasfels.projects p
cross join auth.users u
where p.code = 'FPSO-P85'
  and lower(u.email) = 'douglas.tabella@step-og.com'
on conflict (project_id, user_id)
do update set role = 'admin';
