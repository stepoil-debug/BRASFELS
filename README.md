# BRASFELS Control Center

[![Publicar Painel BRASFELS](https://github.com/stepoil-debug/BRASFELS/actions/workflows/pages.yml/badge.svg)](https://github.com/stepoil-debug/BRASFELS/actions/workflows/pages.yml)

Painel operacional da parceria **STEP One × BrasFELS**, com importação incremental de arquivos Excel e persistência no schema `brasfels` do Supabase.

## Acesso

Painel publicado em:

`https://stepoil-debug.github.io/BRASFELS/`

A tela de entrada utiliza a mesma linguagem visual do login da Intranet STEP One e apresenta as duas marcas como sistema de parceria.

## Perfis

- `viewer`: consulta dashboards, spools, materiais e fluxo de produção.
- `operator`: possui leitura e pode importar/sincronizar atualizações.
- `admin`: acesso total, incluindo gestão de usuários.

O usuário `douglas.tabella@step-og.com` é mantido como administrador principal e não pode ser removido ou rebaixado pela interface.

## Gestão de acessos

A área **Gestão de acessos** fica disponível dentro do painel para administradores. Ela reúne:

- Usuários existentes no Supabase Auth.
- Colaboradores ativos encontrados na tabela `public.users` da intranet.
- Criação de conta com senha temporária.
- Preparação de acesso por convite para candidatos da intranet.
- Alteração entre visualização, operador e administrador.
- Revogação de acesso ao projeto.
- Redefinição administrativa de senha.

A operação é executada pela Edge Function autenticada `brasfels-user-admin`. A chave `service_role` nunca é enviada ao navegador.

## Recursos operacionais

- Visão executiva do FPSO P85.
- Controle de spools, materiais, programação e status.
- Fluxo de produção por etapa atual.
- Importação dos arquivos Spool Map e Spool Materials.
- Reconhecimento das planilhas legadas de gráficos e faturamento.
- Validação antes de aplicar alterações.
- Chave operacional baseada em Isométrico + número do spool.
- Prevenção de importações duplicadas por hash.
- Atualização incremental sem apagar campos manuais.
- Conferência de peso entre spools e materiais.
- Histórico de importações.
- Sincronização e carregamento compartilhado pelo Supabase.

## Banco de dados

- Projeto Supabase: `INTRANET STEP ONE`
- Schema: `brasfels`
- Projeto operacional: `FPSO-P85`
- Migration inicial: `supabase/migrations/20260803130000_brasfels_initial.sql`
- Administrador principal: `supabase/migrations/20260803193000_brasfels_primary_admin.sql`
- Função de acessos: `supabase/functions/brasfels-user-admin/`

## Publicação

O workflow `.github/workflows/pages.yml` monta um artefato público contendo somente o front-end e os recursos visuais necessários. As migrations e funções administrativas permanecem versionadas no repositório, mas não fazem parte dos arquivos servidos pelo GitHub Pages.
