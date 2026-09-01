'use strict';

(function installBrasfelsFinancialModule() {
  const PAGE_SIZE = 100;
  const TABS = [
    { sheet: 'Lista de Controle de Sup', dataset: 'p83_financial_support_control' },
    { sheet: 'Controle faturamento', dataset: 'p83_financial_billing_control' },
    { sheet: 'Relatorio de Medição', dataset: 'p83_financial_measurement_report' },
    { sheet: 'Custo', dataset: 'p83_financial_cost', hidden: true },
    { sheet: 'Total Medido', dataset: 'p83_financial_measured_totals' },
    { sheet: 'SGJ-Spool', dataset: 'p83_financial_sgj_spool' },
    { sheet: 'SGJ-Juntas', dataset: 'p83_financial_sgj_joints' },
    { sheet: 'SGJ-Suporte', dataset: 'p83_financial_sgj_support' },
    { sheet: 'Junta Suporte', dataset: 'p83_financial_support_joint', hidden: true },
    { sheet: 'Analise', dataset: 'p83_financial_analysis', hidden: true },
    { sheet: "Controle de NF's", dataset: 'p83_financial_invoices' },
  ];

  let installed = false;
  let projectId = '';
  let activeTab = TABS[0].dataset;
  let page = 1;
  let search = '';
  let metadata = [];
  let summaries = new Map();
  let requestToken = 0;

  const escape = value => typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const number = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = cleanText(value).replace(/\s/g, '').replace(/R\$/gi, '');
    if (!text || text === '-') return 0;
    const normalized = text.includes(',') && text.includes('.')
      ? (text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, ''))
      : text.replace(',', '.');
    const result = Number(normalized);
    return Number.isFinite(result) ? result : 0;
  };
  const formatNumber = (value, digits = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number(value));
  const formatCurrency = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 }).format(number(value));
  const encode = value => encodeURIComponent(String(value ?? ''));

  function authHeaders(count = false) {
    const result = {
      apikey: state.supabase.key,
      Authorization: `Bearer ${state.supabase.token}`,
      'Accept-Profile': 'brasfels',
      'Content-Type': 'application/json',
    };
    if (count) result.Prefer = 'count=exact';
    return result;
  }

  async function rest(path, options = {}) {
    const response = await fetch(`${state.supabase.url}${path}`, {
      method: options.method || 'GET',
      headers: authHeaders(Boolean(options.count)),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || payload.msg || payload.error || `Erro ${response.status} ao carregar o financeiro.`);
    }
    return { rows: await response.json(), response };
  }

  async function getProjectId() {
    if (projectId) return projectId;
    const { rows } = await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`);
    if (!rows.length) throw new Error('Projeto FPSO-P85 não encontrado.');
    projectId = rows[0].id;
    return projectId;
  }

  function createView() {
    if (document.querySelector('#view-financial')) return;
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const before = document.querySelector('#scopeValuesNav') || nav.querySelector('[data-view="imports"]');
    const button = document.createElement('button');
    button.id = 'financialNav';
    button.className = 'nav-item';
    button.dataset.view = 'financial';
    button.innerHTML = '<span>R$</span> Financeiro <b id="financialNavCount">0</b>';
    nav.insertBefore(button, before || null);
    button.onclick = openView;

    const section = document.createElement('section');
    section.id = 'view-financial';
    section.className = 'view financial-view';
    section.innerHTML = `
      <div class="financial-head">
        <div>
          <p class="eyebrow">P83 · FATURAMENTO E MEDIÇÃO</p>
          <h2>Módulo Financeiro</h2>
          <p>As áreas abaixo seguem a mesma ordem das abas da planilha de faturamento, incluindo as bases técnicas que estavam ocultas no Excel.</p>
        </div>
        <div class="financial-actions">
          <button class="button secondary" id="financialRefresh">Atualizar dados</button>
          <button class="button primary import-shortcut" id="financialImport">＋ Atualizar planilha</button>
        </div>
      </div>
      <div class="financial-kpis" id="financialKpis"></div>
      <div class="financial-tabs" id="financialTabs"></div>
      <div class="financial-sheet-head">
        <div><span id="financialSheetEyebrow">ABA DA PLANILHA</span><h3 id="financialSheetTitle"></h3><small id="financialSheetMeta"></small></div>
        <div class="financial-sheet-controls">
          <div class="search"><span>⌕</span><input id="financialSearch" placeholder="Pesquisar nesta aba"></div>
          <button class="button secondary" id="financialClearSearch" hidden>Limpar</button>
        </div>
      </div>
      <div id="financialMetadata" class="financial-metadata"></div>
      <div class="panel financial-table-panel">
        <div class="financial-table-state" id="financialTableState"></div>
        <div class="financial-table-wrap"><table id="financialTable"><thead></thead><tbody></tbody></table></div>
        <div class="financial-pagination" id="financialPagination"></div>
      </div>`;
    document.querySelector('.main')?.appendChild(section);

    document.querySelector('#financialRefresh').onclick = () => loadModule(true);
    document.querySelector('#financialImport').onclick = () => document.querySelector('#openImport')?.click();
    const searchInput = document.querySelector('#financialSearch');
    let searchTimer = null;
    searchInput.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        search = cleanText(searchInput.value);
        page = 1;
        document.querySelector('#financialClearSearch').hidden = !search;
        loadTab();
      }, 350);
    };
    document.querySelector('#financialClearSearch').onclick = () => {
      search = '';
      searchInput.value = '';
      page = 1;
      document.querySelector('#financialClearSearch').hidden = true;
      loadTab();
    };

    renderTabs();
  }

  function renderTabs() {
    const container = document.querySelector('#financialTabs');
    if (!container) return;
    container.innerHTML = TABS.map(tab => `
      <button class="financial-tab${tab.dataset === activeTab ? ' active' : ''}" data-financial-tab="${escape(tab.dataset)}">
        <span>${escape(tab.sheet)}</span><b>${formatNumber(summaries.get(tab.dataset)?.rows || 0)}</b>
      </button>`).join('');
    container.querySelectorAll('[data-financial-tab]').forEach(button => {
      button.onclick = () => {
        activeTab = button.dataset.financialTab;
        page = 1;
        search = '';
        const searchInput = document.querySelector('#financialSearch');
        if (searchInput) searchInput.value = '';
        document.querySelector('#financialClearSearch').hidden = true;
        renderTabs();
        loadTab();
      };
    });
  }

  function openView() {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.querySelector('#view-financial')?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'financialNav'));
    const title = document.querySelector('#pageTitle');
    if (title) title.textContent = 'Financeiro P83';
    document.querySelector('#sidebar')?.classList.remove('open');
    if (state.supabase.token) loadModule(false);
  }

  function headerMetadata(sheet) {
    return metadata.find(item => item.payload?.sheet === sheet && item.payload?.kind === 'header')?.payload || null;
  }

  function sheetMetadata(sheet) {
    return metadata
      .filter(item => item.payload?.sheet === sheet && item.payload?.kind !== 'header')
      .sort((a, b) => Number(a.payload?.row || 0) - Number(b.payload?.row || 0));
  }

  function payloadValue(sheet, payload, column) {
    if (!payload) return undefined;
    if (Array.isArray(payload.v)) {
      const headers = headerMetadata(sheet)?.headers || [];
      const index = headers.indexOf(column);
      return index >= 0 ? payload.v[index] : undefined;
    }
    return payload[column];
  }

  function metadataValue(label, preferredColumn = '') {
    const target = cleanText(label).toLowerCase();
    for (const item of metadata) {
      const cells = item.payload?.cells || {};
      for (const [column, value] of Object.entries(cells)) {
        if (cleanText(value).toLowerCase() !== target) continue;
        if (preferredColumn && cells[preferredColumn] !== undefined) return cells[preferredColumn];
        const keys = Object.keys(cells);
        const index = keys.indexOf(column);
        for (let step = index + 1; step < keys.length; step += 1) {
          const candidate = cells[keys[step]];
          if (candidate !== '' && candidate !== undefined) return candidate;
        }
      }
    }
    return null;
  }

  async function loadSummaryCards(id) {
    const totalDefinition = TABS.find(tab => tab.dataset === 'p83_financial_measured_totals');
    const { rows } = await rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${encode(totalDefinition.dataset)}&source_active=eq.true&select=payload&order=source_row.asc&limit=100`);
    const bmRows = rows.map(item => item.payload || {}).filter(payload => /^step-/i.test(cleanText(payloadValue('Total Medido', payload, 'Nº BM'))));
    const totalMeasured = bmRows.reduce((sum, payload) => sum + number(payloadValue('Total Medido', payload, 'Valor')), 0);
    const approved = bmRows.filter(payload => /aprovado/i.test(cleanText(payloadValue('Total Medido', payload, 'Status'))) && !/aguardando/i.test(cleanText(payloadValue('Total Medido', payload, 'Status')))).reduce((sum, payload) => sum + number(payloadValue('Total Medido', payload, 'Valor')), 0);
    const pending = bmRows.filter(payload => /aguardando/i.test(cleanText(payloadValue('Total Medido', payload, 'Status')))).reduce((sum, payload) => sum + number(payloadValue('Total Medido', payload, 'Valor')), 0);
    const contract = number(metadataValue('Valor contrato:')) || number(metadataValue('Valor contrato'));
    const toReceive = number(metadataValue('Valor a ser Pago:')) || number(metadataValue('Valor a ser Pago'));
    const balance = contract ? contract - totalMeasured : 0;
    const kpis = document.querySelector('#financialKpis');
    if (!kpis) return;
    kpis.innerHTML = `
      <article><span>Valor do contrato</span><strong>${formatCurrency(contract)}</strong><small>PO FB01012194</small></article>
      <article><span>Total medido</span><strong>${formatCurrency(totalMeasured)}</strong><small>${formatNumber(bmRows.length)} BMs lançados</small></article>
      <article class="ok"><span>Aprovado</span><strong>${formatCurrency(approved)}</strong><small>Boletins aprovados</small></article>
      <article class="warn"><span>Aguardando aprovação</span><strong>${formatCurrency(pending)}</strong><small>Boletins em aprovação</small></article>
      <article><span>Saldo da PO</span><strong>${formatCurrency(balance)}</strong><small>Contrato menos total medido</small></article>
      <article class="accent"><span>Valor a receber</span><strong>${formatCurrency(toReceive)}</strong><small>Controle faturamento</small></article>`;
  }

  function renderMetadata(tab) {
    const container = document.querySelector('#financialMetadata');
    if (!container) return;
    const rows = sheetMetadata(tab.sheet);
    if (!rows.length) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    const meaningful = rows.slice(0, 18).map(item => {
      const cells = Object.entries(item.payload?.cells || {}).filter(([, value]) => cleanText(value));
      if (!cells.length) return '';
      return `<div class="financial-meta-row"><b>Linha ${item.payload.row}</b>${cells.map(([column, value]) => `<span><i>${escape(column)}</i>${formatCell('', value, true)}</span>`).join('')}</div>`;
    }).filter(Boolean);
    container.hidden = !meaningful.length;
    container.innerHTML = meaningful.join('');
  }

  function looksCurrency(column) {
    const value = cleanText(column).toLowerCase();
    return /(valor|custo|saldo|recebid|receber|fatur|total da nf|valor unit)/.test(value) && !/(data|status)/.test(value);
  }

  function looksDate(column, value) {
    const label = cleanText(column).toLowerCase();
    return /(data|date|recebimento|envio)/.test(label) && /^\d{4}-\d{2}-\d{2}/.test(String(value || ''));
  }

  function statusClass(value) {
    const text = cleanText(value).toLowerCase();
    if (/aprovado|fabricado|montado|conclu|liberado/.test(text) && !/aguardando/.test(text)) return 'financial-status ok';
    if (/aguardando|pendente|hold|não iniciado|nao iniciado/.test(text)) return 'financial-status warn';
    if (/cancel|erro|reprov/.test(text)) return 'financial-status danger';
    return '';
  }

  function formatCell(column, value, metadataCell = false) {
    if (value === null || value === undefined || value === '') return '<span class="financial-empty">—</span>';
    if (typeof value === 'number') {
      if (looksCurrency(column)) return `<span class="financial-number currency">${escape(formatCurrency(value))}</span>`;
      return `<span class="financial-number">${escape(formatNumber(value, Math.abs(value % 1) > 0 ? 2 : 0))}</span>`;
    }
    if (looksDate(column, value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return escape(new Intl.DateTimeFormat('pt-BR').format(date));
    }
    const css = metadataCell ? '' : statusClass(value);
    return `<span${css ? ` class="${css}"` : ''}>${escape(value)}</span>`;
  }

  function extractCount(response, fallback) {
    const range = response.headers.get('content-range') || '';
    const match = range.match(/\/(\d+|\*)$/);
    if (match && match[1] !== '*') return Number(match[1]);
    return fallback;
  }

  async function fetchTabRows(id, tab, currentPage, term) {
    const offset = (currentPage - 1) * PAGE_SIZE;
    let path = `/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${encode(tab.dataset)}&source_active=eq.true&select=source_row,source_key,payload&order=source_row.asc&limit=${PAGE_SIZE}&offset=${offset}`;
    if (term) path += `&source_key=ilike.*${encode(term)}*`;
    const result = await rest(path, { count: true });
    return { rows: result.rows, total: extractCount(result.response, result.rows.length) };
  }

  function tableColumns(tab, rows) {
    const header = headerMetadata(tab.sheet);
    if (Array.isArray(header?.headers) && header.headers.length) return header.headers;
    const set = new Set();
    rows.forEach(item => Object.keys(item.payload || {}).filter(key => key !== 'v').forEach(key => set.add(key)));
    return [...set];
  }

  function renderTable(tab, rows, total, token) {
    if (token !== requestToken) return;
    const table = document.querySelector('#financialTable');
    const stateBox = document.querySelector('#financialTableState');
    const pagination = document.querySelector('#financialPagination');
    const columns = tableColumns(tab, rows);
    document.querySelector('#financialSheetTitle').textContent = tab.sheet;
    const summary = summaries.get(tab.dataset);
    document.querySelector('#financialSheetMeta').textContent = `${formatNumber(total)} registros${summary?.lastUpdated ? ` · Atualizado ${summary.lastUpdated}` : ''}`;
    renderMetadata(tab);

    if (!rows.length) {
      table.querySelector('thead').innerHTML = '';
      table.querySelector('tbody').innerHTML = '';
      stateBox.innerHTML = `<div class="financial-empty-state"><strong>${search ? 'Nenhum registro encontrado.' : 'Esta aba ainda não foi importada.'}</strong><span>${search ? 'Limpe a pesquisa ou procure outra chave.' : 'Use “Atualizar planilha” e selecione o arquivo de faturamento P83.'}</span></div>`;
      pagination.innerHTML = '';
      return;
    }

    stateBox.innerHTML = `<span>Linhas ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} de ${formatNumber(total)}</span><small>Rolagem horizontal mantém todas as colunas da planilha.</small>`;
    table.querySelector('thead').innerHTML = `<tr><th class="row-number">#</th>${columns.map(column => `<th>${escape(column)}</th>`).join('')}</tr>`;
    table.querySelector('tbody').innerHTML = rows.map(item => `<tr><td class="row-number">${escape(item.source_row || '')}</td>${columns.map((column, columnIndex) => `<td>${formatCell(column, Array.isArray(item.payload?.v) ? item.payload.v[columnIndex] : item.payload?.[column])}</td>`).join('')}</tr>`).join('');

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pagination.innerHTML = `
      <button ${page <= 1 ? 'disabled' : ''} data-page="prev">← Anterior</button>
      <span>Página <strong>${page}</strong> de <strong>${pages}</strong></span>
      <button ${page >= pages ? 'disabled' : ''} data-page="next">Próxima →</button>`;
    pagination.querySelector('[data-page="prev"]')?.addEventListener('click', () => { if (page > 1) { page -= 1; loadTab(); } });
    pagination.querySelector('[data-page="next"]')?.addEventListener('click', () => { if (page < pages) { page += 1; loadTab(); } });
  }

  async function loadTab() {
    if (!state.supabase.token) return;
    const tab = TABS.find(item => item.dataset === activeTab) || TABS[0];
    const token = ++requestToken;
    const stateBox = document.querySelector('#financialTableState');
    if (stateBox) stateBox.innerHTML = '<div class="financial-loading"><span></span><strong>Carregando aba...</strong></div>';
    document.querySelector('#financialSheetTitle').textContent = tab.sheet;
    document.querySelector('#financialSheetMeta').textContent = 'Consultando base versionada...';
    try {
      const id = await getProjectId();
      const result = await fetchTabRows(id, tab, page, search);
      renderTable(tab, result.rows, result.total, token);
    } catch (error) {
      if (token !== requestToken) return;
      stateBox.innerHTML = `<div class="financial-empty-state error"><strong>Não foi possível carregar esta aba.</strong><span>${escape(error.message)}</span></div>`;
    }
  }

  async function loadModule(showToast) {
    if (!state.supabase.token) return;
    try {
      const id = await getProjectId();
      // A consulta com LIKE sobre todas as bases financeiras pode ultrapassar
      // o timeout do PostgREST. Cada dataset já é conhecido em TABS, então
      // consultar por igualdade mantém a resposta pequena e previsível.
      const [summaryRows, { rows: metaRows }] = await Promise.all([
        Promise.all(TABS.map(tab => rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(id)}&dataset_type=eq.${encode(tab.dataset)}&select=dataset_type,active_rows,last_updated_at,source_file_name`)))
          .then(results => results.flatMap(result => result.rows)),
        rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.p83_financial_metadata&source_active=eq.true&select=payload,source_row&order=source_row.asc&limit=500`),
      ]);
      summaries = new Map();
      summaryRows.forEach(item => {
        const current = summaries.get(item.dataset_type) || { rows: 0, lastUpdated: '', file: '' };
        current.rows += Number(item.active_rows || 0);
        if (item.last_updated_at) current.lastUpdated = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.last_updated_at));
        if (item.source_file_name) current.file = item.source_file_name;
        summaries.set(item.dataset_type, current);
      });
      metadata = metaRows;
      const totalRecords = TABS.reduce((sum, tab) => sum + Number(summaries.get(tab.dataset)?.rows || 0), 0);
      const navCount = document.querySelector('#financialNavCount');
      if (navCount) navCount.textContent = totalRecords ? formatNumber(totalRecords) : '0';
      renderTabs();
      await Promise.all([loadSummaryCards(id), loadTab()]);
      if (showToast && typeof toast === 'function') toast('Módulo Financeiro atualizado.');
    } catch (error) {
      const kpis = document.querySelector('#financialKpis');
      if (kpis) kpis.innerHTML = `<div class="financial-module-empty"><strong>Importe a planilha de faturamento P83.</strong><span>${escape(error.message)}</span></div>`;
      await loadTab().catch(() => {});
      if (showToast && typeof toast === 'function') toast(error.message, 'error');
    }
  }

  function install() {
    if (installed) return;
    installed = true;
    createView();
    let previousToken = state.supabase.token;
    setInterval(() => {
      const token = state.supabase.token;
      if (!previousToken && token) loadModule(false);
      previousToken = token;
    }, 1800);
    if (state.supabase.token) loadModule(false);
  }

  window.addEventListener('load', () => setTimeout(install, 2350));
  window.BrasfelsFinancial = { open: openView, refresh: () => loadModule(false) };
})();

