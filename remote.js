'use strict';

// Extensão de produção: carrega a base compartilhada protegida pelo Supabase.
(function () {
  const PAGE_SIZE = 1000;

  async function fetchAll(path) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const separator = path.includes('?') ? '&' : '?';
      const page = await api(`${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`);
      rows.push(...page);
      if (page.length < PAGE_SIZE) return rows;
    }
  }

  async function loadRemoteData(options = {}) {
    const { silent = false } = options;
    if (!state.supabase.token) {
      if (!silent) toast('Conecte-se ao Supabase primeiro.', 'error');
      return;
    }

    const button = document.querySelector('#loadSupabase');
    try {
      if (button) {
        button.disabled = true;
        button.textContent = 'Carregando...';
      }

      const projects = await api(`/rest/v1/projects?code=eq.${CONFIG.projectCode}&select=id`);
      if (!projects.length) throw new Error('Projeto FPSO-P85 não encontrado.');
      const projectId = projects[0].id;

      const spools = await fetchAll(`/rest/v1/spools?project_id=eq.${projectId}&source_active=eq.true&select=*`);
      const spoolKeys = new Map(spools.map(item => [item.id, item.source_key]));
      const materials = await fetchAll(`/rest/v1/spool_materials?project_id=eq.${projectId}&source_active=eq.true&select=*`);
      const imports = await fetchAll(`/rest/v1/import_batches?project_id=eq.${projectId}&select=*&order=started_at.asc`);

      state.spools = spools.map(item => ({ ...item }));
      state.materials = materials.map(item => ({
        ...item,
        spool_source_key: spoolKeys.get(item.spool_id) || '',
      }));
      state.imports = imports.map(item => ({
        date: item.completed_at || item.started_at,
        file: item.file_name,
        hash: item.file_hash,
        type: item.source_type,
        status: item.status,
        rows: item.total_rows,
        inserted: item.inserted_rows,
        updated: item.updated_rows,
        warnings: item.warning_rows,
      }));

      await persist();
      renderAll();
      const last = imports.at(-1)?.completed_at || imports.at(-1)?.started_at;
      if (last) document.querySelector('#lastUpdate').textContent = fmtDate(last);

      if (!silent) {
        toast(state.spools.length
          ? `${fmt(state.spools.length)} spools carregados do Supabase.`
          : 'A base compartilhada ainda está vazia. Importe as planilhas e sincronize.');
      }
    } catch (error) {
      toast(error.message || 'Falha ao carregar a base compartilhada.', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Carregar dados';
      }
    }
  }

  function install() {
    const login = document.querySelector('#loginSupabase');
    const sync = document.querySelector('#syncSupabase');
    if (!login || !sync || typeof loginSupabase !== 'function') {
      setTimeout(install, 250);
      return;
    }

    const load = document.createElement('button');
    load.id = 'loadSupabase';
    load.className = 'button secondary';
    load.textContent = 'Carregar dados';
    load.addEventListener('click', () => loadRemoteData());
    sync.parentElement.insertBefore(load, sync);

    login.onclick = async () => {
      await loginSupabase();
      if (state.supabase.token) await loadRemoteData({ silent: true });
    };

    if (state.supabase.token) loadRemoteData({ silent: true });
  }

  window.loadBrasfelsRemoteData = loadRemoteData;
  window.addEventListener('load', () => setTimeout(install, 250));
})();
