'use strict';

(function installSourceDataPopup() {
  const PAGE_SIZE = 100;
  let installed = false;
  let projectId = '';
  let current = { dataset: '', title: '', total: 0, page: 1, rows: [], columns: [] };

  const encode = value => encodeURIComponent(String(value ?? ''));
  const escape = value => typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function createPopup() {
    if (document.querySelector('#sourceDataPopup')) return;
    const popup = document.createElement('div');
    popup.id = 'sourceDataPopup';
    popup.className = 'source-popup-backdrop';
    popup.hidden = true;
    popup.innerHTML = `
      <section class="source-popup-dialog" role="dialog" aria-modal="true" aria-labelledby="sourcePopupTitle">
        <header class="source-popup-header">
          <div>
            <p class="eyebrow">BASE IMPORTADA</p>
            <h2 id="sourcePopupTitle">Visualização dos dados</h2>
            <span id="sourcePopupMeta">Carregando...</span>
          </div>
          <button type="button" id="sourcePopupClose" class="source-popup-close" aria-label="Fechar">×</button>
        </header>
        <div class="source-popup-toolbar">
          <div class="source-popup-status" id="sourcePopupStatus">Preparando registros...</div>
          <button type="button" id="sourcePopupExport" class="button secondary">Exportar página CSV</button>
        </div>
        <div class="source-popup-content" id="sourcePopupContent">
          <div class="source-popup-loading"><span></span><strong>Carregando registros...</strong></div>
        </div>
        <footer class="source-popup-footer">
          <span id="sourcePopupRange">—</span>
          <div>
            <button type="button" id="sourcePopupPrev" class="button secondary">← Anterior</button>
            <strong id="sourcePopupPage">Página 1</strong>
            <button type="button" id="sourcePopupNext" class="button secondary">Próxima →</button>
          </div>
        </footer>
      </section>`;
    document.body.appendChild(popup);

    document.querySelector('#sourcePopupClose').onclick = closePopup;
    document.querySelector('#sourcePopupPrev').onclick = () => loadPage(current.page - 1);
    document.querySelector('#sourcePopupNext').onclick = () => loadPage(current.page + 1);
    document.querySelector('#sourcePopupExport').onclick = exportCurrentPage;
    popup.addEventListener('mousedown', event => {
      if (event.target === popup) closePopup();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !popup.hidden) closePopup();
    });
  }

  function closePopup() {
    const popup = document.querySelector('#sourceDataPopup');
    if (!popup) return;
    popup.hidden = true;
    document.body.classList.remove('source-popup-open');
  }

  async function rest(path) {
    const response = await fetch(`${state.supabase.url}${path}`, {
      headers: {
        apikey: state.supabase.key,
        Authorization: `Bearer ${state.supabase.token}`,
        'Accept-Profile': 'brasfels',
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || payload.msg || payload.error || `Erro ${response.status} ao carregar os dados.`);
    }
    return response.json();
  }

  async function getProjectId() {
    if (projectId) return projectId;
    const projects = await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`);
    if (!projects.length) throw new Error('Projeto FPSO-P85 não encontrado.');
    projectId = projects[0].id;
    return projectId;
  }

  function columnFrequency(rows) {
    const frequency = new Map();
    for (const row of rows) {
      for (const key of Object.keys(row.payload || {})) {
        const value = row.payload?.[key];
        if (value !== '' && value !== null && value !== undefined) {
          frequency.set(key, (frequency.get(key) || 0) + 1);
        }
      }
    }
    return [...frequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([key]) => key);
  }

  function displayValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number') {
      return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(value);
    }
    if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function renderRows(rows) {
    const content = document.querySelector('#sourcePopupContent');
    if (!rows.length) {
      content.innerHTML = '<div class="source-popup-empty">Nenhum registro encontrado neste conjunto.</div>';
      return;
    }

    current.columns = columnFrequency(rows);
    const headers = ['Chave', 'Linha', ...current.columns];
    content.innerHTML = `
      <div class="source-popup-table-wrap">
        <table class="source-popup-table">
          <thead><tr>${headers.map(header => `<th>${escape(header)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(row => {
            const values = [row.source_key, row.source_row, ...current.columns.map(column => row.payload?.[column])];
            return `<tr>${values.map(value => {
              const text = displayValue(value);
              return `<td title="${escape(text)}">${escape(text)}</td>`;
            }).join('')}</tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  }

  async function loadPage(page) {
    const pages = Math.max(1, Math.ceil(current.total / PAGE_SIZE));
    current.page = Math.min(Math.max(1, page), pages);
    const offset = (current.page - 1) * PAGE_SIZE;
    const content = document.querySelector('#sourcePopupContent');
    content.innerHTML = '<div class="source-popup-loading"><span></span><strong>Carregando registros...</strong></div>';
    document.querySelector('#sourcePopupPrev').disabled = true;
    document.querySelector('#sourcePopupNext').disabled = true;

    try {
      const id = await getProjectId();
      const rows = await rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${encode(current.dataset)}&source_active=eq.true&select=source_key,source_sheet,source_row,payload&order=source_row.asc&limit=${PAGE_SIZE}&offset=${offset}`);
      current.rows = rows;
      renderRows(rows);
      const start = rows.length ? offset + 1 : 0;
      const end = offset + rows.length;
      document.querySelector('#sourcePopupRange').textContent = `${start}–${end} de ${new Intl.NumberFormat('pt-BR').format(current.total)} registros`;
      document.querySelector('#sourcePopupPage').textContent = `Página ${current.page} de ${pages}`;
      document.querySelector('#sourcePopupStatus').textContent = `${rows.length} registros exibidos · ${current.columns.length} colunas identificadas`;
      document.querySelector('#sourcePopupPrev').disabled = current.page <= 1;
      document.querySelector('#sourcePopupNext').disabled = current.page >= pages;
      document.querySelector('#sourcePopupExport').disabled = !rows.length;
    } catch (error) {
      content.innerHTML = `<div class="source-popup-empty error">${escape(error.message || 'Não foi possível abrir os dados.')}</div>`;
      document.querySelector('#sourcePopupStatus').textContent = 'Falha ao carregar os registros';
    }
  }

  function openPopup(dataset, title, total) {
    if (!state.supabase.token) {
      if (typeof toast === 'function') toast('Entre no painel para abrir os dados.', 'error');
      return;
    }
    createPopup();
    current = { dataset, title, total: Number(total || 0), page: 1, rows: [], columns: [] };
    const popup = document.querySelector('#sourceDataPopup');
    document.querySelector('#sourcePopupTitle').textContent = title || dataset;
    document.querySelector('#sourcePopupMeta').textContent = `${new Intl.NumberFormat('pt-BR').format(current.total)} registros armazenados no Supabase`;
    document.querySelector('#sourcePopupStatus').textContent = 'Preparando registros...';
    popup.hidden = false;
    document.body.classList.add('source-popup-open');
    loadPage(1);
  }

  function exportCurrentPage() {
    if (!current.rows.length) return;
    const columns = ['source_key', 'source_row', ...current.columns];
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      columns.map(quote).join(';'),
      ...current.rows.map(row => columns.map(column => {
        const value = column === 'source_key' || column === 'source_row' ? row[column] : row.payload?.[column];
        return quote(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
      }).join(';')),
    ];
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${current.dataset}-pagina-${current.page}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function install() {
    if (installed) return;
    installed = true;
    createPopup();

    document.addEventListener('click', event => {
      const button = event.target.closest?.('.source-summary-row');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const dataset = button.dataset.dataset;
      const title = button.querySelector('strong')?.textContent?.trim() || dataset;
      const totalText = button.querySelector('b')?.textContent || '0';
      const total = Number(totalText.replace(/\./g, '').replace(',', '.')) || 0;
      openPopup(dataset, title, total);
      const preview = document.querySelector('#sourcePreview');
      if (preview) preview.innerHTML = '<div class="source-preview-empty">Os dados foram abertos em uma janela ampliada.</div>';
    }, true);
  }

  window.addEventListener('load', () => setTimeout(install, 1600));
  window.BrasfelsSourcePopup = { open: openPopup, close: closePopup };
})();
