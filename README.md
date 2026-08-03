# BRASFELS Control Center

[![Publicar Painel BRASFELS](https://github.com/stepoil-debug/BRASFELS/actions/workflows/pages.yml/badge.svg)](https://github.com/stepoil-debug/BRASFELS/actions/workflows/pages.yml)

Painel operacional independente para controle dos projetos BRASFELS, com importação incremental de arquivos Excel e persistência no schema `brasfels` do Supabase.

## Acesso

Painel publicado em:

`https://stepoil-debug.github.io/BRASFELS/`

## Recursos

- Visão executiva do FPSO P85.
- Controle de spools, materiais, programação e status.
- Importação dos arquivos Spool Map e Spool Materials.
- Reconhecimento das planilhas legadas de gráficos e faturamento.
- Validação antes de aplicar alterações.
- Chave operacional baseada em Isométrico + número do spool.
- Prevenção de importações duplicadas por hash.
- Atualização incremental sem apagar campos manuais.
- Conferência de peso entre spools e materiais.
- Histórico de importações.
- Armazenamento local para trabalho temporário.
- Sincronização e carregamento compartilhado pelo Supabase.

## Fluxo de atualização

1. Acesse o painel e faça login no Supabase.
2. Use **Importar atualização**.
3. Selecione um ou mais arquivos Excel.
4. Valide os arquivos.
5. Aplique a atualização local.
6. Abra **Configuração** e use **Sincronizar dados**.
7. Os demais usuários podem usar **Carregar dados** após o login.

## Banco de dados

- Projeto Supabase: `INTRANET STEP ONE`
- Schema: `brasfels`
- Projeto operacional: `FPSO-P85`
- Migration inicial: `supabase/migrations/20260803130000_brasfels_initial.sql`

O acesso é protegido por autenticação e RLS, com perfis `viewer`, `operator` e `admin`.

## Publicação

O workflow `.github/workflows/pages.yml` publica apenas os arquivos do site:

- `index.html`
- `styles.css`
- `app.js`
- `remote.js`
- `.nojekyll`

As migrations e demais arquivos do repositório não fazem parte do artefato público do GitHub Pages.
