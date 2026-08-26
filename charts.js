'use strict';

(function installBrasfelsCharts() {
  const DATASET = 'p85_joint_traceability';
  const PAGE_SIZE = 1000;
  const STAGES = [
    { key: 'cutting_date', label: 'Corte', short: 'Corte', source: 'Joint Traceability · X (Data Corte Spool)' },
    { key: 'coupling_date', label: 'Montagem / Acoplamento', short: 'Montagem', source: 'Joint Traceability · AB (Acoplamento / Data)' },
    { key: 'visual_adjust_date', label: 'Visual dimensional / ajuste', short: 'Visual ajuste', source: 'Joint Traceability · AF (Visual Ajuste / Data)' },
    { key: 'welding_date', label: 'Soldagem', short: 'Soldagem', source: 'Joint Traceability · AM (Soldagem / Data)' },
    { key: 'visual_date', label: 'Ensaio visual', short: 'Visual', source: 'Joint Traceability · BF (Ensaio Visual / Data)' },
    { key: 'lp_pm_date', label: 'LP / PM', short: 'LP/PM', source: 'Joint Traceability · BW (LP/PM / Data)' },
    { key: 'rx_us_date', label: 'RX / US', short: 'RX/US', source: 'Joint Traceability · DJ (RX/US / Data)' },
    { key: 'dimensional_date', label: 'Dimensional de fabricação', short: 'Dimensional', source: 'Joint Traceability · EI (Dimensional Fabricação / Data)' },
  ];

  let installed = false;
  let projectId = '';
  let joints = [];
  let sourceMeta = { file: '', updatedAt: '' };
  let currentToken = '';
  let filters = { module: '', placement: '', week: '' };

  const encode = value => encodeURIComponent(String(value ?? ''));
  const escape = value => typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const number = value => Number(value || 0);
  const formatNumber = (value, digits = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number(value));
  const formatDateTime = value => {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date) : '—';
  };
  const upper = value => String(value || '').trim().toUpperCase();

  function normalizeSpoolKey(value) {
    return upper(value)
      .replace(/\s+/g, '')
      .replace(/_/g, '-')
      .replace(/^CANC-?/, '')
      .replace(/-+/g, '-')
      .replace(/-+$/, '');
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const text = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? new Date(`${text}T12:00:00Z`)
      : new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateOnly(value) {
    const date = parseDate(value);
    if (!date) return '';
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  // Compatibilidade com a planilha legada: WEEKNUM(data,14)-1.
  // O tipo 14 inicia a semana na quinta-feira e o arquivo subtrai uma unidade.
  function legacyWeekNumber(value) {
    const date = parseDate(value);
    if (!date) return null;
    const year = date.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1, 12));
    const offset = (jan1.getUTCDay() - 4 + 7) % 7;
    const dayOfYear = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / 86400000) + 1;
    return Math.floor((dayOfYear - 1 + offset) / 7);
  }

  function weekKey(value) {
    const date = parseDate(value);
    const week = legacyWeekNumber(date);
    return date && week !== null ? `${date.getUTCFullYear()}-${week}` : '';
  }

  function parseWeekKey(key) {
    const match = String(key || '').match(/^(\d{4})-(\d{1,2})$/);
    return match ? { year: Number(match[1]), week: Number(match[2]) } : null;
  }

  function weekLabel(key) {
    const parsed = parseWeekKey(key);
    return parsed ? `Semana ${parsed.week} · ${parsed.year}` : 'Semana —';
  }

  function weekStart(key) {
    const parsed = parseWeekKey(key);
    if (!parsed) return null;
    const jan1 = new Date(Date.UTC(parsed.year, 0, 1, 12));
    const offset = (jan1.getUTCDay() - 4 + 7) % 7;
    const firstThursday = new Date(jan1.getTime() - offset * 86400000);
    return new Date(firstThursday.getTime() + parsed.week * 7 * 86400000);
  }

  function parseDiameterInches(value) {
    const text = String(value || '').replace(/["″]/g, '').replace(/-/g, ' ').trim();
    if (!text) return 0;
    return text.split(/\s+/).reduce((sum, part) => {
      if (/^\d+\/\d+$/.test(part)) {
        const [a, b] = part.split('/').map(Number);
        return b ? sum + a / b : sum;
      }
      const valueNumber = Number(part.replace(',', '.'));
      return Number.isFinite(valueNumber) ? sum + valueNumber : sum;
    }, 0);
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
      throw new Error(payload.message || payload.msg || payload.error || `Erro ${response.status} ao carregar os gráficos.`);
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

  async function fetchJointRecords(id) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${DATASET}&source_active=eq.true&select=payload,source_file_name,updated_at&order=source_row.asc&limit=${PAGE_SIZE}&offset=${offset}`);
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return rows;
  }

  function createView() {
    if (document.querySelector('#view-charts')) return;
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const materials = nav.querySelector('[data-view="materials"]');
    const button = document.createElement('button');
    button.id = 'chartsNav';
    button.className = 'nav-item';
    button.dataset.view = 'charts';
    button.innerHTML = '<span>▥</span> Gráficos <b id="chartsNavCount">0</b>';
    if (materials) nav.insertBefore(button, materials);
    else nav.appendChild(button);
    button.onclick = openView;

    const section = document.createElement('section');
    section.id = 'view-charts';
    section.className = 'view charts-view';
    section.innerHTML = `
      <div class="charts-toolbar">
        <div class="charts-toolbar-copy">
          <p class="eyebrow">P85 · APONTAMENTOS OPERACIONAIS</p>
          <h2>Gráficos de fabricação e avanço</h2>
          <p>Os indicadores reproduzem as regras do arquivo “Gráficos Brasfels” usando diretamente o Joint Traceability atual e o Spool Map, sem depender das planilhas auxiliares antigas.</p>
        </div>
        <div class="charts-actions">
          <button class="button secondary" id="chartsSource">Abrir base</button>
          <button class="button secondary" id="chartsRefresh">Atualizar gráficos</button>
          <button class="button primary import-shortcut" id="chartsImport">＋ Atualizar apontamentos</button>
        </div>
      </div>
      <div class="charts-filters">
        <label class="charts-filter"><span>Módulo</span><select id="chartsModule"><option value="">Todos os módulos</option></select></label>
        <label class="charts-filter"><span>Apontamentos</span><select id="chartsPlacement"><option value="">PIPE + CAMPO</option><option value="PIPE">Somente PIPE</option><option value="CAMPO">Somente CAMPO</option></select></label>
        <label class="charts-filter"><span>Semana de análise</span><select id="chartsWeek"><option value="">Última semana com dados</option></select></label>
      </div>
      <div id="chartsContent"><div class="charts-loading"><div><span></span><strong>Carregando apontamentos...</strong></div></div></div>`;
    document.querySelector('.main')?.appendChild(section);

    document.querySelector('#chartsRefresh').onclick = () => loadData(true);
    document.querySelector('#chartsImport').onclick = () => {
      const open = document.querySelector('#openImport');
      if (!open || open.hidden || open.disabled) return toast('Seu perfil não permite importar atualizações.', 'error');
      open.click();
    };
    document.querySelector('#chartsSource').onclick = () => {
      if (!joints.length) return toast('Ainda não há base de apontamentos importada.', 'error');
      if (window.BrasfelsSourcePopup?.open) window.BrasfelsSourcePopup.open(DATASET, 'Mapa de Juntas P85', joints.length);
    };
    document.querySelector('#chartsModule').onchange = event => { filters.module = event.target.value; refreshWeekOptions(); render(); };
    document.querySelector('#chartsPlacement').onchange = event => { filters.placement = event.target.value; refreshWeekOptions(); render(); };
    document.querySelector('#chartsWeek').onchange = event => { filters.week = event.target.value; render(); };
  }

  function openView() {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.querySelector('#view-charts')?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'chartsNav'));
    const title = document.querySelector('#pageTitle');
    if (title) title.textContent = 'Gráficos P85';
    document.querySelector('#sidebar')?.classList.remove('open');
    if (!joints.length && state.supabase.token) loadData(false);
  }

  function applicableJoints() {
    const module = filters.module;
    const moduleRows = joints.filter(item => !module || upper(item.module) === module);
    const stageRows = moduleRows.filter(item => !filters.placement || upper(item.placement) === filters.placement);
    return { moduleRows, stageRows };
  }

  function allWeeks(rows) {
    const keys = new Set();
    for (const row of rows) {
      STAGES.forEach(stage => {
        const key = weekKey(row[stage.key]);
        if (key) keys.add(key);
      });
    }
    return [...keys].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b);
      return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    });
  }

  function buildModuleOptions() {
    const select = document.querySelector('#chartsModule');
    if (!select) return;
    const modules = new Set(joints.map(item => upper(item.module)).filter(Boolean));
    (state.spools || []).forEach(item => { if (item.module) modules.add(upper(item.module)); });
    const values = [...modules].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const current = filters.module;
    select.innerHTML = '<option value="">Todos os módulos</option>' + values.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
    select.value = values.includes(current) ? current : '';
    filters.module = select.value;
  }

  function refreshWeekOptions() {
    const select = document.querySelector('#chartsWeek');
    if (!select) return;
    const { stageRows } = applicableJoints();
    const weeks = allWeeks(stageRows);
    const current = filters.week;
    select.innerHTML = weeks.slice().reverse().map(key => `<option value="${escape(key)}">${escape(weekLabel(key))}</option>`).join('');
    if (!weeks.length) {
      select.innerHTML = '<option value="">Sem semanas disponíveis</option>';
      filters.week = '';
      return;
    }
    filters.week = weeks.includes(current) ? current : weeks.at(-1);
    select.value = filters.week;
  }

  async function loadData(showToast) {
    const content = document.querySelector('#chartsContent');
    if (!state.supabase.token) {
      if (content) content.innerHTML = '<div class="chart-empty"><div><strong>Entre no painel para carregar os gráficos.</strong><span>Os apontamentos ficam protegidos no Supabase.</span></div></div>';
      return;
    }
    if (content) content.innerHTML = '<div class="charts-loading"><div><span></span><strong>Carregando apontamentos e conferindo fórmulas...</strong></div></div>';
    try {
      if (!state.spools?.length && window.loadBrasfelsRemoteData) await window.loadBrasfelsRemoteData({ silent: true });
      const id = await getProjectId();
      const [records, summary] = await Promise.all([
        fetchJointRecords(id),
        rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(id)}&dataset_type=eq.${DATASET}&select=active_rows,last_updated_at,source_file_name&limit=1`),
      ]);
      joints = records.map(record => ({ ...(record.payload || {}) }));
      sourceMeta = {
        file: summary[0]?.source_file_name || records[0]?.source_file_name || '',
        updatedAt: summary[0]?.last_updated_at || records.reduce((latest, row) => !latest || String(row.updated_at) > String(latest) ? row.updated_at : latest, ''),
      };
      document.querySelector('#chartsNavCount').textContent = formatNumber(joints.length);
      buildModuleOptions();
      refreshWeekOptions();
      render();
      if (showToast) toast(`${formatNumber(joints.length)} apontamentos carregados.`);
    } catch (error) {
      if (content) content.innerHTML = `<div class="chart-empty"><div><strong>Não foi possível carregar os gráficos.</strong><span>${escape(error.message)}</span></div></div>`;
      if (showToast) toast(error.message, 'error');
    }
  }

  function groupBySpool(rows) {
    const map = new Map();
    for (const row of rows) {
      const key = normalizeSpoolKey(row.spool_key);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  }

  function spoolMap(rows) {
    const map = new Map();
    for (const row of rows) map.set(normalizeSpoolKey(row.source_key), row);
    return map;
  }

  function maximumDate(rows, key) {
    let maximum = null;
    for (const row of rows) {
      const date = parseDate(row[key]);
      if (date && (!maximum || date > maximum)) maximum = date;
    }
    return maximum;
  }

  function compute() {
    const { moduleRows, stageRows } = applicableJoints();
    const moduleSpools = (state.spools || []).filter(spool => !filters.module || upper(spool.module) === filters.module);
    const spoolsByKey = spoolMap(moduleSpools);
    const rowsBySpool = groupBySpool(moduleRows);
    const selectedWeek = filters.week;

    const cumulative = STAGES.map(stage => ({ stage: stage.short, value: stageRows.filter(row => Boolean(row[stage.key])).length }));
    const selectedWeekStages = STAGES.map(stage => ({
      stage: stage.short,
      value: stageRows.filter(row => weekKey(row[stage.key]) === selectedWeek).length,
    }));

    const weeklyKeys = allWeeks(stageRows);
    const weeklyStages = weeklyKeys.map(key => ({
      key,
      label: `S${parseWeekKey(key)?.week ?? ''}`,
      corte: stageRows.filter(row => weekKey(row.cutting_date) === key).length,
      visual: stageRows.filter(row => weekKey(row.visual_adjust_date) === key).length,
      soldagem: stageRows.filter(row => weekKey(row.welding_date) === key).length,
    }));

    const pipeRows = moduleRows.filter(row => upper(row.placement) === 'PIPE');
    const pipeCounts = new Map();
    for (const row of pipeRows) {
      const key = normalizeSpoolKey(row.spool_key);
      pipeCounts.set(key, (pipeCounts.get(key) || 0) + 1);
    }

    const weldedInchesByDate = new Map();
    const weldedCountByWeek = new Map();
    const weldedWeightByWeek = new Map();
    let unlinkedRows = 0;
    const unmatchedKeys = new Set();
    for (const row of moduleRows) {
      const key = normalizeSpoolKey(row.spool_key);
      if (!spoolsByKey.has(key)) { unlinkedRows += 1; unmatchedKeys.add(key); }
    }

    for (const row of pipeRows) {
      if (!row.welding_date) continue;
      const date = dateOnly(row.welding_date);
      weldedInchesByDate.set(date, (weldedInchesByDate.get(date) || 0) + parseDiameterInches(row.diameter_inch));
      const key = weekKey(row.welding_date);
      if (key) weldedCountByWeek.set(key, (weldedCountByWeek.get(key) || 0) + 1);
      const spoolKey = normalizeSpoolKey(row.spool_key);
      const spool = spoolsByKey.get(spoolKey);
      const totalPipe = pipeCounts.get(spoolKey) || 0;
      if (spool && totalPipe && key) {
        const allocatedWeight = number(spool.weight_kg) / totalPipe;
        weldedWeightByWeek.set(key, (weldedWeightByWeek.get(key) || 0) + allocatedWeight);
      }
    }

    const fabricated = [];
    for (const [key, spoolJoints] of rowsBySpool.entries()) {
      const pipe = spoolJoints.filter(row => upper(row.placement) === 'PIPE');
      if (!pipe.length) continue;
      const allDimensionalApproved = pipe.every(row => upper(row.dimensional_status) === 'A');
      if (!allDimensionalApproved) continue;
      const completedAt = maximumDate(pipe, 'dimensional_date');
      if (!completedAt) continue;
      const spool = spoolsByKey.get(key);
      fabricated.push({ key, completedAt, weight: number(spool?.weight_kg), joints: pipe.length });
    }

    const fabricatedByWeek = new Map();
    for (const spool of fabricated) {
      const key = weekKey(spool.completedAt);
      if (!key) continue;
      const current = fabricatedByWeek.get(key) || { spools: 0, weight: 0, joints: 0 };
      current.spools += 1;
      current.weight += spool.weight;
      current.joints += spool.joints;
      fabricatedByWeek.set(key, current);
    }

    const selectedStart = weekStart(selectedWeek);
    const dailyInches = [];
    if (selectedStart) {
      for (let index = 0; index < 7; index += 1) {
        const date = new Date(selectedStart.getTime() + index * 86400000);
        const iso = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        dailyInches.push({
          date: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(date),
          iso,
          value: weldedInchesByDate.get(iso) || 0,
        });
      }
    }

    const productionWeekKeys = new Set([...weeklyKeys, ...weldedCountByWeek.keys(), ...fabricatedByWeek.keys()]);
    const productionWeekly = [...productionWeekKeys].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b);
      return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    }).map(key => ({
      key,
      label: `S${parseWeekKey(key)?.week ?? ''}`,
      fabricated: fabricatedByWeek.get(key)?.spools || 0,
      fabricatedWeight: fabricatedByWeek.get(key)?.weight || 0,
      weldedJoints: weldedCountByWeek.get(key) || 0,
      weldedWeight: weldedWeightByWeek.get(key) || 0,
    }));

    const plannedWeightByWeek = new Map();
    for (const spool of moduleSpools) {
      const key = weekKey(spool.manufacture_schedule_date);
      if (!key) continue;
      plannedWeightByWeek.set(key, (plannedWeightByWeek.get(key) || 0) + number(spool.weight_kg));
    }

    const weightKeys = new Set([...weldedWeightByWeek.keys(), ...plannedWeightByWeek.keys()]);
    const weightWeekly = [...weightKeys].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b);
      return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    }).map(key => ({
      key,
      label: `S${parseWeekKey(key)?.week ?? ''}`,
      actual: (weldedWeightByWeek.get(key) || 0) / 1000,
      planned: (plannedWeightByWeek.get(key) || 0) / 1000,
    }));

    const totalWeight = moduleSpools.reduce((sum, spool) => sum + number(spool.weight_kg), 0) / 1000;
    let cumulativeActual = 0;
    let cumulativePlanned = 0;
    const rundown = weightWeekly.map(row => {
      cumulativeActual += row.actual;
      cumulativePlanned += row.planned;
      return {
        ...row,
        actualRemaining: Math.max(0, totalWeight - cumulativeActual),
        plannedRemaining: Math.max(0, totalWeight - cumulativePlanned),
      };
    });

    const statusCounter = new Map();
    for (const spool of moduleSpools) {
      const raw = cleanStatus(spool.manufacture_status || spool.assembly_status || 'Sem status');
      statusCounter.set(raw, (statusCounter.get(raw) || 0) + 1);
    }
    const statuses = [...statusCounter.entries()]
      .map(([status, value]) => ({ status, value }))
      .sort((a, b) => b.value - a.value);

    const eligibleSpools = [...rowsBySpool.values()].filter(spoolRows => spoolRows.some(row => upper(row.placement) === 'PIPE')).length;
    const backlog = Math.max(0, eligibleSpools - fabricated.length);
    const linkedRows = Math.max(0, moduleRows.length - unlinkedRows);
    const selectedProduction = productionWeekly.find(row => row.key === selectedWeek) || { fabricated: 0, weldedJoints: 0, weldedWeight: 0, fabricatedWeight: 0 };
    const selectedInches = dailyInches.reduce((sum, row) => sum + row.value, 0);

    return {
      moduleRows, stageRows, moduleSpools, cumulative, selectedWeekStages, weeklyStages,
      dailyInches, productionWeekly, weightWeekly, rundown, statuses,
      fabricated, eligibleSpools, backlog, linkedRows, unlinkedRows, unmatchedKeys: [...unmatchedKeys],
      selectedProduction, selectedInches, totalWeight,
    };
  }

  function cleanStatus(value) {
    const status = String(value || '').trim();
    const map = {
      'FAB - Not Started': 'Não iniciado',
      'FAB - Spool on Hold': 'Spool em Hold',
      'FAB - Waiting Coupling': 'Aguardando Acoplamento',
      'FAB - Waiting Welding': 'Aguardando Soldagem',
      'FAB - Waiting Radiography/Ultrasonic': 'Aguardando RX/US',
      'FAB - Waiting Penetrating Test/Magnetic Test': 'Aguardando LP/PM',
      'FAB - Waiting Manufacturing Dimensional': 'Aguardando Dimensional de Fabricação',
      'FAB - Waiting Painting Primer': 'Aguardando Pintura de Fundo',
    };
    return map[status] || status || 'Sem status';
  }

  function renderStageBars(target, rows) {
    const element = document.querySelector(target);
    if (!element) return;
    const max = Math.max(1, ...rows.map(row => row.value));
    element.innerHTML = `<div class="stage-bars">${rows.map(row => `
      <div class="stage-row"><span>${escape(row.stage)}</span><div class="stage-track"><i style="width:${Math.max(0, Math.min(100, row.value / max * 100))}%"></i></div><strong>${formatNumber(row.value)}</strong></div>`).join('')}</div>`;
  }

  function renderLineChart(target, rows, series, valueFormatter = value => formatNumber(value)) {
    const element = document.querySelector(target);
    if (!element) return;
    if (!rows.length) { element.innerHTML = '<div class="chart-empty"><div><strong>Sem dados neste período.</strong></div></div>'; return; }
    const width = 920; const height = 285; const left = 54; const right = 20; const top = 18; const bottom = 42;
    const plotW = width - left - right; const plotH = height - top - bottom;
    const values = rows.flatMap(row => series.map(item => number(row[item.key])));
    const maxValue = Math.max(1, ...values) * 1.08;
    const x = index => rows.length === 1 ? left + plotW / 2 : left + index * plotW / (rows.length - 1);
    const y = value => top + plotH - (number(value) / maxValue) * plotH;
    let svg = `<div class="chart-legend">${series.map((item, index) => `<span><i class="l${index}"></i>${escape(item.label)}</span>`).join('')}</div><div class="chart-svg-wrap"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img">`;
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = maxValue * tick / 4;
      const yy = top + plotH - tick * plotH / 4;
      svg += `<line class="chart-grid-line" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"></line><text class="chart-axis-text" x="${left - 8}" y="${yy + 4}" text-anchor="end">${escape(valueFormatter(value))}</text>`;
    }
    rows.forEach((row, index) => { svg += `<text class="chart-axis-text" x="${x(index)}" y="${height - 14}" text-anchor="middle">${escape(row.label)}</text>`; });
    series.forEach((item, sIndex) => {
      const points = rows.map((row, index) => `${x(index)},${y(row[item.key])}`).join(' ');
      svg += `<polyline class="chart-line-${sIndex}" points="${points}"></polyline>`;
      rows.forEach((row, index) => {
        const value = number(row[item.key]);
        svg += `<circle class="chart-dot-${sIndex}" cx="${x(index)}" cy="${y(value)}" r="4"><title>${escape(`${item.label} · ${row.label}: ${valueFormatter(value)}`)}</title></circle>`;
      });
    });
    svg += '</svg></div>';
    element.innerHTML = svg;
  }

  function renderColumnChart(target, rows, key, formatter = value => formatNumber(value, 1)) {
    const element = document.querySelector(target);
    if (!element) return;
    if (!rows.length) { element.innerHTML = '<div class="chart-empty"><div><strong>Sem dados.</strong></div></div>'; return; }
    const width = 720; const height = 245; const left = 42; const right = 12; const top = 18; const bottom = 43;
    const plotW = width - left - right; const plotH = height - top - bottom;
    const max = Math.max(1, ...rows.map(row => number(row[key]))) * 1.08;
    const slot = plotW / rows.length; const barW = Math.min(52, slot * .62);
    let svg = `<div class="chart-svg-wrap"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img">`;
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = max * tick / 4; const yy = top + plotH - tick * plotH / 4;
      svg += `<line class="chart-grid-line" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"></line><text class="chart-axis-text" x="${left - 7}" y="${yy + 4}" text-anchor="end">${escape(formatter(value))}</text>`;
    }
    rows.forEach((row, index) => {
      const value = number(row[key]); const h = value / max * plotH; const xx = left + slot * index + (slot - barW) / 2; const yy = top + plotH - h;
      svg += `<rect class="chart-bar-primary" x="${xx}" y="${yy}" width="${barW}" height="${h}" rx="5"><title>${escape(`${row.date || row.label}: ${formatter(value)}`)}</title></rect><text class="chart-axis-text" x="${xx + barW / 2}" y="${height - 14}" text-anchor="middle">${escape(row.date || row.label)}</text>`;
    });
    svg += '</svg></div>';
    element.innerHTML = svg;
  }

  function renderStatusBars(target, rows) {
    const element = document.querySelector(target);
    if (!element) return;
    const max = Math.max(1, ...rows.map(row => row.value));
    element.innerHTML = rows.length ? `<div class="status-bars">${rows.map(row => `<div class="status-row"><span title="${escape(row.status)}">${escape(row.status)}</span><div class="stage-track"><i style="width:${row.value / max * 100}%"></i></div><strong>${formatNumber(row.value)}</strong></div>`).join('')}</div>` : '<div class="chart-empty"><strong>Sem status disponível.</strong></div>';
  }

  function renderFabricationSplit(target, fabricated, backlog, eligible) {
    const element = document.querySelector(target);
    if (!element) return;
    const percentage = eligible ? fabricated / eligible * 100 : 0;
    element.innerHTML = `<div class="fabrication-split"><div class="ring" style="--ring-pct:${Math.max(0, Math.min(100, percentage))}%"><div><strong>${formatNumber(percentage, 1)}%</strong><small>fabricado</small></div></div><div class="split-list"><div><span>Spools fabricados</span><strong>${formatNumber(fabricated)}</strong></div><div><span>Backlog</span><strong>${formatNumber(backlog)}</strong></div><div><span>Spools com juntas PIPE</span><strong>${formatNumber(eligible)}</strong></div></div></div>`;
  }

  function renderProductionMini(target, rows) {
    const element = document.querySelector(target);
    if (!element) return;
    const last = rows.at(-1) || {};
    element.innerHTML = `<div class="production-mini-grid">
      <div class="production-mini"><h4>Spools fabricados</h4><strong>${formatNumber(last.fabricated || 0)}</strong><small>${escape(last.label || '—')}</small><div id="miniFabricated"></div></div>
      <div class="production-mini"><h4>Juntas soldadas</h4><strong>${formatNumber(last.weldedJoints || 0)}</strong><small>${escape(last.label || '—')}</small><div id="miniWeldedJoints"></div></div>
      <div class="production-mini"><h4>Peso de juntas soldadas</h4><strong>${formatNumber((last.weldedWeight || 0) / 1000, 2)} t</strong><small>${escape(last.label || '—')}</small><div id="miniWeldedWeight"></div></div>
    </div>`;
    renderColumnChart('#miniFabricated', rows.slice(-12), 'fabricated', value => formatNumber(value));
    renderColumnChart('#miniWeldedJoints', rows.slice(-12), 'weldedJoints', value => formatNumber(value));
    const weightRows = rows.slice(-12).map(row => ({ ...row, weldedWeightT: row.weldedWeight / 1000 }));
    renderColumnChart('#miniWeldedWeight', weightRows, 'weldedWeightT', value => formatNumber(value, 1));
  }

  function render() {
    const content = document.querySelector('#chartsContent');
    if (!content) return;
    if (!joints.length) {
      content.innerHTML = `<div class="chart-empty"><div><strong>Nenhum Mapa de Juntas P85 importado.</strong><span>Use “Atualizar apontamentos” e selecione o arquivo Joint Traceability. O Spool Map continua sendo usado para pesos, programação e status.</span></div></div>`;
      return;
    }

    const data = compute();
    const selectedWeek = filters.week;
    const selected = data.selectedProduction;
    const selectedStageSoldagem = data.selectedWeekStages.find(row => row.stage === 'Soldagem')?.value || 0;
    const uniqueSpools = new Set(data.moduleRows.map(row => normalizeSpoolKey(row.spool_key)).filter(Boolean)).size;
    const canWrite = state.supabase.role === 'admin' || state.supabase.role === 'operator' || !state.supabase.role;
    const importButton = document.querySelector('#chartsImport');
    if (importButton) importButton.hidden = !canWrite;

    content.innerHTML = `
      <div class="charts-kpis">
        <article class="charts-kpi"><span>Juntas na base</span><strong>${formatNumber(data.moduleRows.length)}</strong><small>${formatNumber(uniqueSpools)} spools no mapa</small></article>
        <article class="charts-kpi ${data.unlinkedRows ? 'attention' : 'success'}"><span>Vínculo com Spool Map</span><strong>${formatNumber(data.linkedRows)}</strong><small>${data.unlinkedRows ? `${formatNumber(data.unlinkedRows)} juntas sem vínculo` : '100% das juntas vinculadas'}</small></article>
        <article class="charts-kpi"><span>Soldagem · ${escape(weekLabel(selectedWeek))}</span><strong>${formatNumber(selectedStageSoldagem)}</strong><small>PIPE + CAMPO conforme filtro</small></article>
        <article class="charts-kpi"><span>Polegadas soldadas</span><strong>${formatNumber(data.selectedInches, 1)}″</strong><small>Somente juntas PIPE · regra do Excel</small></article>
        <article class="charts-kpi"><span>Peso de juntas soldadas</span><strong>${formatNumber(selected.weldedWeight / 1000, 2)} t</strong><small>Peso proporcional por junta PIPE</small></article>
        <article class="charts-kpi"><span>Spools fabricados</span><strong>${formatNumber(selected.fabricated)}</strong><small>Todos os PIPE com dimensional aprovado</small></article>
      </div>

      <div class="charts-grid">
        <article class="chart-card span-12"><div class="chart-card-header"><div><p class="eyebrow">EVOLUÇÃO SEMANAL</p><h3>Corte, visual dimensional e soldagem</h3><p>Equivalente ao gráfico principal do arquivo legado, agora calculado da base atual.</p></div><span class="chart-badge">WEEKNUM(data,14)-1</span></div><div id="weeklyStageChart"></div></article>

        <article class="chart-card"><div class="chart-card-header"><div><p class="eyebrow">ACUMULADO</p><h3>Apontamentos por etapa</h3><p>Total acumulado de datas registradas em cada etapa.</p></div></div><div id="cumulativeStages"></div></article>
        <article class="chart-card"><div class="chart-card-header"><div><p class="eyebrow">SEMANA SELECIONADA</p><h3>Quantidade por etapa</h3><p>${escape(weekLabel(selectedWeek))} · ${filters.placement || 'PIPE + CAMPO'}</p></div></div><div id="selectedWeekStages"></div></article>

        <article class="chart-card"><div class="chart-card-header"><div><p class="eyebrow">POLEGADAS SOLDADAS</p><h3>Produção diária</h3><p>Soma do diâmetro em polegadas das juntas PIPE com data de soldagem.</p></div><span class="chart-badge">AM + N + W=PIPE</span></div><div id="dailyInchesChart"></div></article>
        <article class="chart-card"><div class="chart-card-header"><div><p class="eyebrow">FABRICAÇÃO SEMANAL</p><h3>Spools, juntas e peso</h3><p>As três medidas do gráfico combinado original, separadas para evitar escalas enganosas.</p></div></div><div id="productionWeekly"></div></article>

        <article class="chart-card span-8"><div class="chart-card-header"><div><p class="eyebrow">PESO SEMANAL</p><h3>Real x programado STEP</h3><p>Peso real das juntas soldadas por rateio do peso do spool e peso programado pela Manufacture Schedule Date.</p></div><span class="chart-badge">toneladas</span></div><div id="weightWeekly"></div></article>
        <article class="chart-card span-4"><div class="chart-card-header"><div><p class="eyebrow">FABRICADO x BACKLOG</p><h3>Situação dos spools</h3><p>Base elegível: spools que possuem juntas PIPE.</p></div></div><div id="fabricationSplit"></div></article>

        <article class="chart-card span-8"><div class="chart-card-header"><div><p class="eyebrow">RUNDOWN</p><h3>Peso remanescente</h3><p>Saldo do peso P85 após o avanço real de soldagem comparado ao consumo planejado.</p></div><span class="chart-badge">mesma unidade: t</span></div><div id="rundownChart"></div></article>
        <article class="chart-card span-4"><div class="chart-card-header"><div><p class="eyebrow">STATUS ATUAL</p><h3>Fabricação dos spools</h3><p>Distribuição usando o Manufacture Status atual do Spool Map.</p></div></div><div id="statusChart"></div></article>

        <article class="chart-card"><div class="chart-card-header"><div><p class="eyebrow">QUALIDADE DOS DADOS</p><h3>Conferência automática</h3><p>O painel não esconde registros que não fecham entre as duas fontes.</p></div></div><div id="qualityPanel"></div></article>
        <article class="chart-card"><div class="chart-card-header"><div><p class="eyebrow">AUDITORIA DE FÓRMULAS</p><h3>Regras reproduzidas do Excel</h3><p>Rastreabilidade dos cálculos usados nesta tela.</p></div></div><div id="formulaAudit"></div></article>
      </div>
      <div class="chart-source-strip"><span><strong>Fonte de apontamentos:</strong> ${escape(sourceMeta.file || 'p85_joint_traceability')}</span><span><strong>Atualização:</strong> ${escape(formatDateTime(sourceMeta.updatedAt))}</span><span><strong>Spool Map:</strong> ${formatNumber(data.moduleSpools.length)} registros ativos</span></div>`;

    renderLineChart('#weeklyStageChart', data.weeklyStages.slice(-12), [
      { key: 'corte', label: 'Corte' },
      { key: 'visual', label: 'Visual dimensional / ajuste' },
      { key: 'soldagem', label: 'Soldagem' },
    ]);
    renderStageBars('#cumulativeStages', data.cumulative);
    renderStageBars('#selectedWeekStages', data.selectedWeekStages);
    renderColumnChart('#dailyInchesChart', data.dailyInches, 'value', value => formatNumber(value, 0));
    renderProductionMini('#productionWeekly', data.productionWeekly);
    renderLineChart('#weightWeekly', data.weightWeekly.slice(-16), [
      { key: 'actual', label: 'Peso real soldado' },
      { key: 'planned', label: 'Peso programado STEP' },
    ], value => `${formatNumber(value, 1)} t`);
    renderFabricationSplit('#fabricationSplit', data.fabricated.length, data.backlog, data.eligibleSpools);
    renderLineChart('#rundownChart', data.rundown.slice(-16), [
      { key: 'actualRemaining', label: 'Saldo real' },
      { key: 'plannedRemaining', label: 'Saldo planejado' },
    ], value => `${formatNumber(value, 1)} t`);
    renderStatusBars('#statusChart', data.statuses);

    const quality = document.querySelector('#qualityPanel');
    if (quality) quality.innerHTML = `<div class="quality-list">
      <div class="quality-item"><span>Juntas carregadas do Joint Traceability</span><strong>${formatNumber(data.moduleRows.length)}</strong></div>
      <div class="quality-item"><span>Juntas vinculadas por chave normalizada do spool</span><strong>${formatNumber(data.linkedRows)}</strong></div>
      <div class="quality-item ${data.unlinkedRows ? 'warn' : ''}"><span>Juntas sem spool correspondente no Spool Map atual</span><strong>${formatNumber(data.unlinkedRows)}</strong></div>
      <div class="quality-item"><span>Spools com juntas PIPE usados na regra de fabricação</span><strong>${formatNumber(data.eligibleSpools)}</strong></div>
    </div>${data.unmatchedKeys.length ? `<div class="quality-detail"><strong>Chaves sem vínculo:</strong><br>${data.unmatchedKeys.slice(0, 12).map(escape).join('<br>')}${data.unmatchedKeys.length > 12 ? `<br>+ ${formatNumber(data.unmatchedKeys.length - 12)} outras` : ''}</div>` : ''}`;

    const audit = document.querySelector('#formulaAudit');
    if (audit) audit.innerHTML = `<div class="formula-audit">
      ${STAGES.map(stage => `<div class="formula-rule"><strong>${escape(stage.short)}</strong><code>CONTAGEM = data da etapa preenchida</code><small>${escape(stage.source)} · separado por P/C e somado como no Excel.</small></div>`).join('')}
      <div class="formula-rule"><strong>Polegadas soldadas</strong><code>Σ diâmetro (N) onde W = PIPE e AM possui data</code><small>Equivale à base POL SOLDADAS sem as colunas auxiliares.</small></div>
      <div class="formula-rule"><strong>Peso de juntas soldadas</strong><code>peso do spool ÷ total de juntas PIPE × juntas PIPE soldadas</code><small>Mesma regra das planilhas PESO - JUNTAS SOLDADAS e BASE DE DADOS.</small></div>
      <div class="formula-rule"><strong>Spool fabricado</strong><code>todas as juntas PIPE com EF = A; semana = MAX(EI)</code><small>Reprodução da fórmula usada para a fabricação semanal.</small></div>
      <div class="formula-rule"><strong>Semana</strong><code>WEEKNUM(data,14) - 1</code><small>Compatibilidade intencional com a numeração do arquivo Gráficos Brasfels.</small></div>
    </div>`;
  }

  function install() {
    if (installed) return;
    createView();
    if (!document.querySelector('#view-charts')) {
      setTimeout(install, 300);
      return;
    }
    installed = true;
    currentToken = state.supabase.token || '';
    if (currentToken) loadData(false);
    setInterval(() => {
      const token = state.supabase.token || '';
      if (token && token !== currentToken) {
        currentToken = token;
        projectId = '';
        loadData(false);
      } else if (!token) currentToken = '';
    }, 1800);
  }

  window.addEventListener('load', () => setTimeout(install, 2150));
  window.BrasfelsCharts = { open: openView, refresh: () => loadData(false) };
})();
