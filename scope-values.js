'use strict';

(function installScopeValuesView() {
  const DATASETS = {
    p85_scope_summary: 'Resumo do escopo',
    p85_scope_spools: 'Spools com composição de juntas',
    p85_scope_joints: 'Juntas por spool',
    p85_scope_inspection_rates: 'Valores por classe de inspeção',
    p85_scope_painting_rates: 'Valores de pintura',
    p85_scope_support_rates: 'Valores de suportes',
  };
  let installed = false;
  let projectId = '';
  let summaries = [];
  let summaryPayload = null;

  const encode = value => encodeURIComponent(String(value ?? ''));
  const number = value => Number(value || 0);
  const formatNumber = (value, digits = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number(value));
  const formatCurrency = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 }).format(number(value));
  const escape = value => typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '');

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
      throw new Error(payload.message || payload.msg || payload.error || `Erro ${response.status} ao carregar escopo e valores.`);
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

  function createView() {
    if (document.querySelector('#view-scope-values')) return;
    const nav = document.querySelector('.nav');
    const sourceNav = nav?.querySelector('[data-view="source-data"]');
    const button = document.createElement('button');
    button.id = 'scopeValuesNav';
    button.className = 'nav-item';
    button.dataset.view = 'scope-values';
    button.innerHTML = '<span>▤</span> Escopo e valores <b id="scopeValuesCount">0</b>';
    if (nav) nav.insertBefore(button, sourceNav || nav.querySelector('[data-view="imports"]'));
    button.onclick = openView;

    const section = document.createElement('section');
    section.id = 'view-scope-values';
    section.className = 'view scope-values-view';
    section.innerHTML = `
      <div class="section-intro scope-values-intro">
        <div><p class="eyebrow">PROPOSTA P85</p><h2>Escopo, juntas e valores</h2><p>Composição por spool, classes de inspeção, pintura e suportes importados da Tabela de Spools e Valores.</p></div>
        <div class="scope-values-actions"><button class="button secondary" id="scopeValuesRefresh">Atualizar</button><button class="button primary import-shortcut" id="scopeValuesImport">＋ Importar tabela</button></div>
      </div>
      <div class="scope-values-kpis" id="scopeValuesKpis"></div>
      <div class="scope-values-breakdown" id="scopeValuesBreakdown"></div>
      <div class="scope-values-grid">
        <article class="panel scope-values-panel"><div class="panel-header"><div><p class="eyebrow">CLASSES DE INSPEÇÃO</p><h3>Diâmetro, espessura e valor</h3></div><button class="button secondary" data-open-scope="p85_scope_inspection_rates">Abrir completo</button></div><div id="scopeInspectionTable"></div></article>
        <article class="panel scope-values-panel"><div class="panel-header"><div><p class="eyebrow">PINTURA</p><h3>Sistemas e áreas</h3></div><button class="button secondary" data-open-scope="p85_scope_painting_rates">Abrir completo</button></div><div id="scopePaintingTable"></div></article>
        <article class="panel scope-values-panel"><div class="panel-header"><div><p class="eyebrow">SUPORTES PRIMÁRIOS</p><h3>Sapata, trunnion e sela</h3></div><button class="button secondary" data-open-scope="p85_scope_support_rates">Abrir completo</button></div><div id="scopeSupportTable"></div></article>
        <article class="panel scope-values-panel scope-data-panel"><div class="panel-header"><div><p class="eyebrow">BASE DETALHADA</p><h3>Spools e juntas</h3></div></div><div id="scopeDatasetCards"></div></article>
      </div>`;
    document.querySelector('.main')?.appendChild(section);
    document.querySelector('#scopeValuesRefresh').onclick = () => loadView(true);
    document.querySelector('#scopeValuesImport').onclick = () => document.querySelector('#openImport')?.click();
    section.addEventListener('click', event => {
      const target = event.target.closest?.('[data-open-scope]');
      if (!target) return;
      openDataset(target.dataset.openScope);
    });
  }

  function openView() {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.querySelector('#view-scope-values')?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'scopeValuesNav'));
    const title = document.querySelector('#pageTitle');
    if (title) title.textContent = 'Escopo e valores P85';
    document.querySelector('#sidebar')?.classList.remove('open');
    loadView(false);
  }

  function countFor(dataset) {
    return summaries.filter(item => item.dataset_type === dataset).reduce((sum, item) => sum + number(item.active_rows), 0);
  }

  async function fetchAllSourceKeys(path) {
    const values = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await rest(`${path}&limit=1000&offset=${offset}`);
      values.push(...page.map(item => item.source_key));
      if (page.length < 1000) break;
    }
    return values;
  }

  async function matchedSpools(id) {
    const [scopeKeys, operationalKeys] = await Promise.all([
      fetchAllSourceKeys(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.p85_scope_spools&source_active=eq.true&select=source_key`),
      fetchAllSourceKeys(`/rest/v1/spools?project_id=eq.${encode(id)}&source_active=eq.true&select=source_key`),
    ]);
    const operational = new Set(operationalKeys);
    return scopeKeys.filter(key => operational.has(key)).length;
  }

  function table(headers, rows) {
    if (!rows.length) return '<div class="scope-values-empty">Nenhum dado importado.</div>';
    return `<div class="scope-values-table-wrap"><table><thead><tr>${headers.map(item => `<th>${escape(item.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map(item => `<td>${item.render ? item.render(row.payload || {}) : escape(row.payload?.[item.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  async function loadRates(id, dataset, limit = 50) {
    return rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${encode(dataset)}&source_active=eq.true&select=payload&order=source_row.asc&limit=${limit}`);
  }

  function render(matchCount, inspection, painting, supports) {
    const s = summaryPayload || {};
    const totalScope = number(s.total_spools);
    document.querySelector('#scopeValuesCount').textContent = formatNumber(totalScope);
    document.querySelector('#scopeValuesKpis').innerHTML = `
      <article><span>Spools na base de valores</span><strong>${formatNumber(s.total_spools)}</strong><small>${formatNumber(matchCount)} vinculados ao Spool Map atual</small></article>
      <article><span>Juntas detalhadas</span><strong>${formatNumber(s.total_juntas)}</strong><small>${formatNumber(s.total_isometricos)} isométricos</small></article>
      <article><span>Peso único dos spools</span><strong>${formatNumber(s.peso_unico_spools_kg, 2)} kg</strong><small>Sem repetir o peso por junta</small></article>
      <article><span>Valor total estimado</span><strong>${formatCurrency(s.valor_total_estimado)}</strong><small>Inspeção + pintura + suportes</small></article>`;

    document.querySelector('#scopeValuesBreakdown').innerHTML = `
      <article><span>Inspeção</span><strong>${formatCurrency(s.valor_inspecao_estimado)}</strong><small>${formatNumber(s.faixas_inspecao)} faixas · ${formatNumber(s.peso_escopo_inspecao_kg, 2)} kg</small></article>
      <article><span>Pintura</span><strong>${formatCurrency(s.valor_pintura_estimado)}</strong><small>${formatNumber(s.sistemas_pintura)} sistemas</small></article>
      <article><span>Suportes</span><strong>${formatCurrency(s.valor_suportes_estimado)}</strong><small>${formatNumber(s.total_suportes_planilha)} unidades</small></article>
      <article><span>Tipos de junta</span><strong>${formatNumber(s.juntas_bw)} BW</strong><small>${formatNumber(s.juntas_sw)} SW · ${formatNumber(s.juntas_br)} BR</small></article>`;

    document.querySelector('#scopeInspectionTable').innerHTML = table([
      { label: 'Faixa', key: 'faixa_diametro_espessura' },
      { label: 'Qtde.', render: row => formatNumber(row.quantidade_total, 1) },
      { label: 'Peso', render: row => `${formatNumber(row.peso_total_kg, 2)} kg` },
      { label: 'Valor', render: row => formatCurrency(row.valor_total_estimado) },
    ], inspection.slice(0, 10));
    document.querySelector('#scopePaintingTable').innerHTML = table([
      { label: 'Sistema', key: 'sistema_pintura' },
      { label: 'Qtde.', render: row => formatNumber(row.quantidade) },
      { label: 'Área', render: row => `${formatNumber(row.area_m2, 2)} m²` },
      { label: 'Valor', render: row => formatCurrency(row.valor_total_estimado) },
    ], painting);
    document.querySelector('#scopeSupportTable').innerHTML = table([
      { label: 'Suporte', key: 'suporte' },
      { label: 'Qtde.', render: row => formatNumber(row.quantidade_juntas) },
      { label: 'Peso', render: row => `${formatNumber(row.peso_t, 2)} t` },
      { label: 'Valor', render: row => formatCurrency(row.valor_total_estimado) },
    ], supports);

    const discrepancy = Math.abs(number(s.peso_suportes_total_origem) - number(s.peso_suportes_calculado_t));
    document.querySelector('#scopeDatasetCards').innerHTML = `
      <button data-open-scope="p85_scope_spools"><span><b>Spools com composição</b><small>Juntas BW, SW e BR agrupadas por spool</small></span><strong>${formatNumber(countFor('p85_scope_spools'))}</strong></button>
      <button data-open-scope="p85_scope_joints"><span><b>Base de juntas</b><small>Isométrico, spool, junta, diâmetro e espessura</small></span><strong>${formatNumber(countFor('p85_scope_joints'))}</strong></button>
      ${discrepancy > 0.01 ? `<div class="scope-values-warning"><b>Conferência necessária</b><span>O total de peso dos suportes informado na planilha (${formatNumber(s.peso_suportes_total_origem, 2)}) difere da soma dos itens (${formatNumber(s.peso_suportes_calculado_t, 2)} t). O painel preservou os dois valores.</span></div>` : ''}`;
  }

  async function loadView(showToast) {
    if (!state.supabase.token) return;
    const kpis = document.querySelector('#scopeValuesKpis');
    if (kpis) kpis.innerHTML = '<div class="scope-values-loading">Carregando escopo e valores...</div>';
    try {
      const id = await getProjectId();
      const [summaryRows, summaryView, inspection, painting, supports, matchCount] = await Promise.all([
        rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.p85_scope_summary&source_active=eq.true&select=payload&limit=1`),
        rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(id)}&dataset_type=like.p85_scope_%25&select=dataset_type,active_rows,last_updated_at,source_file_name`),
        loadRates(id, 'p85_scope_inspection_rates'),
        loadRates(id, 'p85_scope_painting_rates'),
        loadRates(id, 'p85_scope_support_rates'),
        matchedSpools(id),
      ]);
      summaryPayload = summaryRows[0]?.payload || null;
      summaries = summaryView;
      if (!summaryPayload) {
        document.querySelector('#scopeValuesKpis').innerHTML = '<div class="scope-values-empty wide">Importe o arquivo “Tabela de Spools e Valores” para preencher esta tela.</div>';
        document.querySelector('#scopeValuesBreakdown').innerHTML = '';
        document.querySelector('#scopeInspectionTable').innerHTML = '<div class="scope-values-empty">Sem dados.</div>';
        document.querySelector('#scopePaintingTable').innerHTML = '<div class="scope-values-empty">Sem dados.</div>';
        document.querySelector('#scopeSupportTable').innerHTML = '<div class="scope-values-empty">Sem dados.</div>';
        document.querySelector('#scopeDatasetCards').innerHTML = '';
        return;
      }
      render(matchCount, inspection, painting, supports);
      if (showToast && typeof toast === 'function') toast('Escopo e valores atualizados.');
    } catch (error) {
      document.querySelector('#scopeValuesKpis').innerHTML = `<div class="scope-values-empty wide error">${escape(error.message)}</div>`;
      if (showToast && typeof toast === 'function') toast(error.message, 'error');
    }
  }

  function openDataset(dataset) {
    const total = countFor(dataset);
    const title = DATASETS[dataset] || dataset;
    if (window.BrasfelsSourcePopup?.open) window.BrasfelsSourcePopup.open(dataset, title, total);
  }

  function install() {
    if (installed) return;
    installed = true;
    createView();
    let previousToken = state.supabase.token;
    window.setInterval(() => {
      if (!previousToken && state.supabase.token) loadView(false);
      previousToken = state.supabase.token;
    }, 2000);
  }

  window.addEventListener('load', () => window.setTimeout(install, 1800));
  window.BrasfelsScopeValues = { refresh: () => loadView(false), open: openView };
})();
