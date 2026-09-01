'use strict';

(function installBrasfelsDashboard() {
  const VIEW_ID = 'view-reports-dashboard';
  const JOINT_DATASET = 'p85_joint_traceability';
  const SCOPE_JOINTS = 'p85_scope_joints';
  const SCOPE_RATES = 'p85_scope_inspection_rates';
  const PAGE_SIZE = 1000;
  const STAGES = [
    { key: 'cutting_date', label: 'Corte' },
    { key: 'coupling_date', label: 'Montagem' },
    { key: 'visual_adjust_date', label: 'Visual dimensional' },
    { key: 'welding_date', label: 'Soldagem' },
    { key: 'visual_date', label: 'Visual' },
    { key: 'lp_pm_date', label: 'LP/PM' },
    { key: 'rx_us_date', label: 'Raio X / US' },
    { key: 'dimensional_date', label: 'Dimensional' },
  ];
  let installed = false;
  let projectId = '';
  let joints = [];
  let scopeJointMap = new Map();
  let scopeRateMap = new Map();
  let sourceMeta = { file: '', updatedAt: '', scopeFile: '', error: '' };
  let filters = { module: '', placement: '', week: '', period: '16' };
  let currentToken = '';

  const upper = value => String(value || '').trim().toUpperCase();
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const number = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    let text = clean(value).replace(/\s/g, '');
    if (!text) return 0;
    if (text.includes(',') && text.includes('.')) {
      text = text.lastIndexOf(',') > text.lastIndexOf('.')
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
    } else if (text.includes(',')) {
      text = text.replace(',', '.');
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const encode = value => encodeURIComponent(String(value ?? ''));
  const escape = value => typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (value, digits = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number(value));
  const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(number(value));

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const text = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00Z`) : new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateOnly(value) {
    const d = parseDate(value);
    return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : '';
  }

  // Compatibilidade com a planilha: WEEKNUM(data,14)-1.
  function legacyWeekNumber(value) {
    const date = parseDate(value);
    if (!date) return null;
    const year = date.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1, 12));
    const offset = (jan1.getUTCDay() - 4 + 7) % 7;
    const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / 86400000) + 1;
    return Math.floor((day - 1 + offset) / 7);
  }

  function weekKey(value) {
    const d = parseDate(value);
    const week = legacyWeekNumber(d);
    return d && week !== null ? `${d.getUTCFullYear()}-${week}` : '';
  }

  function parseWeekKey(key) {
    const m = String(key || '').match(/^(\d{4})-(\d{1,2})$/);
    return m ? { year: Number(m[1]), week: Number(m[2]) } : null;
  }

  function weekLabel(key, compact = false) {
    const p = parseWeekKey(key);
    return p ? (compact ? `S${p.week}` : `Semana ${p.week} · ${p.year}`) : (compact ? 'Todas' : 'Todas as semanas');
  }

  function weekStart(key) {
    const p = parseWeekKey(key);
    if (!p) return null;
    const jan1 = new Date(Date.UTC(p.year, 0, 1, 12));
    const offset = (jan1.getUTCDay() - 4 + 7) % 7;
    const firstThursday = new Date(jan1.getTime() - offset * 86400000);
    return new Date(firstThursday.getTime() + p.week * 7 * 86400000);
  }

  function normalizeSpoolKey(value) {
    return upper(value).replace(/\s+/g, '').replace(/_/g, '-').replace(/^CANC-?/, '').replace(/-+/g, '-').replace(/-+$/, '');
  }

  function normalizeText(value) {
    return upper(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
  }

  function jointKey(row) {
    return `${normalizeSpoolKey(row.spool_key)}|${upper(row.joint)}`;
  }

  function parseDiameterInches(value) {
    const text = String(value || '').replace(/["″]/g, '').replace(/-/g, ' ').trim();
    if (!text) return 0;
    return text.split(/\s+/).reduce((sum, part) => {
      if (/^\d+\/\d+$/.test(part)) {
        const [a, b] = part.split('/').map(Number);
        return b ? sum + a / b : sum;
      }
      const n = Number(part.replace(',', '.'));
      return Number.isFinite(n) ? sum + n : sum;
    }, 0);
  }

  function isApproved(value) {
    const t = upper(value);
    return t === 'A' || t === 'APROVADO' || t === 'APPROVED';
  }

  function isReleased(row) {
    return Boolean(row.release_date) || /JUNTA LIBERADA/.test(normalizeText(row.situation));
  }

  function cleanStatus(value) {
    const status = clean(value);
    const map = {
      'FAB - Not Started': 'Não iniciado',
      'FAB - Spool on Hold': 'Spool em Hold',
      'FAB - Waiting Coupling': 'Aguardando Acoplamento',
      'FAB - Waiting Welding': 'Aguardando Soldagem',
      'FAB - Waiting Radiography/Ultrasonic': 'Aguardando RX/US',
      'FAB - Waiting Penetrating Test/Magnetic Test': 'Aguardando LP/PM',
      'FAB - Waiting Manufacturing Dimensional': 'Aguardando Dimensional de Fabricação',
      'FAB - Waiting Painting Primer': 'Aguardando Pintura de Fundo',
      'FAB - Field Spool': 'Spool de Campo',
      'FAB - Not Allocated': 'Não alocado',
    };
    return map[status] || status || 'Sem status';
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
      throw new Error(payload.message || payload.msg || payload.error || `Erro ${response.status} ao carregar o Dashboard.`);
    }
    return response.json();
  }

  async function fetchAll(path) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const separator = path.includes('?') ? '&' : '?';
      const page = await rest(`${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`);
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return rows;
  }

  async function getProjectId() {
    if (projectId) return projectId;
    const rows = await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`);
    if (!rows.length) throw new Error('Projeto FPSO-P85 não encontrado.');
    projectId = rows[0].id;
    return projectId;
  }

  function createView() {
    if (document.querySelector(`#${VIEW_ID}`)) return;
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const before = document.querySelector('#financialNav') || document.querySelector('#scopeValuesNav') || nav.querySelector('[data-view="imports"]');
    const button = document.createElement('button');
    button.id = 'dashboardNav';
    button.className = 'nav-item';
    button.dataset.view = 'dashboard';
    button.innerHTML = '<span>▦</span> Dashboard <b id="dashboardNavCount">0</b>';
    nav.insertBefore(button, before || nav.firstChild);
    button.onclick = openView;

    const section = document.createElement('section');
    section.id = VIEW_ID;
    section.className = 'view brd-view';
    section.innerHTML = `
      <div class="brd-hero">
        <div>
          <p class="eyebrow">FPSO P85 · BRASFELS CONTROL CENTER</p>
          <h2>Dashboard executivo de fabricação</h2>
          <p>Visão consolidada dos relatórios da planilha “Gráficos Brasfels”, recalculada diretamente das bases atuais do Brasfels. O Excel é usado apenas como referência das regras e dos relatórios.</p>
        </div>
        <div class="brd-hero-side">
          <div class="brd-source-card"><span>Fonte operacional</span><strong id="dashboardSourceName">Joint Traceability + Spool Map</strong><small id="dashboardSourceTime">Aguardando carregamento...</small></div>
          <div class="brd-actions"><button class="button secondary" id="dashboardAuditSource">Abrir base</button><button class="button secondary" id="dashboardRefresh">Atualizar</button></div>
        </div>
      </div>
      <div class="brd-filterbar">
        <label class="brd-filter"><span>Módulo</span><select id="dashboardModule"><option value="">Todos os módulos</option></select></label>
        <label class="brd-filter"><span>Local de execução</span><select id="dashboardPlacement"><option value="">PIPE + CAMPO</option><option value="PIPE">PIPE</option><option value="CAMPO">CAMPO</option></select></label>
        <label class="brd-filter"><span>Semana de análise</span><select id="dashboardWeek"><option value="">Todas as semanas</option></select></label>
        <label class="brd-filter"><span>Janela dos gráficos</span><select id="dashboardPeriod"><option value="12">12 semanas</option><option value="16" selected>16 semanas</option><option value="24">24 semanas</option><option value="all">Todo histórico</option></select></label>
      </div>
      <div id="dashboardContent"><div class="brd-empty"><div><strong>Carregando Dashboard...</strong><span>Conferindo Joint Traceability, Spool Map e escopo.</span></div></div></div>`;
    document.querySelector('.main')?.appendChild(section);

    document.querySelector('#dashboardRefresh').onclick = () => loadData(true);
    document.querySelector('#dashboardAuditSource').onclick = () => {
      if (!joints.length) return toast('A base de juntas ainda não foi carregada.', 'error');
      window.BrasfelsSourcePopup?.open?.(JOINT_DATASET, 'Joint Traceability P85', joints.length);
    };
    document.querySelector('#dashboardModule').onchange = e => { filters.module = e.target.value; refreshWeekOptions(); render(); };
    document.querySelector('#dashboardPlacement').onchange = e => { filters.placement = e.target.value; refreshWeekOptions(); render(); };
    document.querySelector('#dashboardWeek').onchange = e => { filters.week = e.target.value; render(); };
    document.querySelector('#dashboardPeriod').onchange = e => { filters.period = e.target.value; render(); };
  }

  function openView() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelector(`#${VIEW_ID}`)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'dashboardNav'));
    const title = document.querySelector('#pageTitle');
    if (title) title.textContent = 'Dashboard P85';
    document.querySelector('#sidebar')?.classList.remove('open');
    if (!joints.length && state.supabase.token) loadData(false);
  }

  function filteredRows() {
    const moduleRows = uniqueJointRows(joints).filter(row => !filters.module || upper(row.module) === filters.module);
    const stageRows = moduleRows.filter(row => !filters.placement || upper(row.placement) === filters.placement);
    return { moduleRows, stageRows };
  }

  function allWeeks(rows) {
    const set = new Set();
    for (const row of rows) {
      STAGES.forEach(stage => { const key = weekKey(row[stage.key]); if (key) set.add(key); });
      const release = weekKey(row.release_date); if (release) set.add(release);
    }
    return [...set].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b);
      return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    });
  }

  function buildFilters() {
    const moduleSelect = document.querySelector('#dashboardModule');
    if (moduleSelect) {
      const modules = new Set(joints.map(row => upper(row.module)).filter(Boolean));
      (state.spools || []).forEach(spool => { if (spool.module) modules.add(upper(spool.module)); });
      const values = [...modules].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      moduleSelect.innerHTML = '<option value="">Todos os módulos</option>' + values.map(v => `<option value="${escape(v)}">${escape(v)}</option>`).join('');
      if (!values.includes(filters.module)) filters.module = '';
      moduleSelect.value = filters.module;
    }
    refreshWeekOptions();
  }

  function refreshWeekOptions() {
    const select = document.querySelector('#dashboardWeek');
    if (!select) return;
    const weeks = allWeeks(filteredRows().stageRows);
    if (!weeks.includes(filters.week)) filters.week = '';
    select.innerHTML = '<option value="">Todas as semanas</option>' + weeks.slice().reverse().map(key => `<option value="${escape(key)}">${escape(weekLabel(key))}</option>`).join('');
    select.value = filters.week;
  }

  function scopeRateFor(row) {
    const scope = scopeJointMap.get(jointKey(row));
    if (!scope) return 0;
    const rate = scopeRateMap.get(normalizeText(scope.diametro_espessura));
    if (!rate) return 0;
    const cls = normalizeText(row.inspection_class);
    if (/III|CLASSE 3|\b3\b/.test(cls)) return number(rate.classe_iii_valor_unitario);
    if (/II|CLASSE 2|\b2\b/.test(cls)) return number(rate.classe_ii_valor_unitario);
    return number(rate.classe_i_valor_unitario);
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

  function uniqueJointRows(rows) {
    const seen = new Set();
    return rows.filter(row => {
      const key = jointKey(row);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function proportionalWeight(weightKg, totalPipeJoints) {
    const total = Number(totalPipeJoints || 0);
    return total > 0 ? number(weightKg) / total : 0;
  }

  function fabricationState(rows) {
    const pipe = rows.filter(row => upper(row.placement) === 'PIPE');
    const approved = pipe.filter(row => isApproved(row.dimensional_status));
    const dates = pipe.map(row => parseDate(row.dimensional_date)).filter(Boolean);
    return {
      pipeCount: pipe.length,
      pending: Math.max(0, pipe.length - approved.length),
      completedAt: dates.length ? new Date(Math.max(...dates.map(date => date.getTime()))) : null,
      fabricated: pipe.length > 0 && approved.length === pipe.length,
    };
  }

  function backlogState(weightKg, totalPipeJoints, pendingJoints, onHold) {
    const pendingWeight = totalPipeJoints > 0
      ? number(weightKg) * Math.max(0, pendingJoints) / totalPipeJoints
      : 0;
    return { pendingWeight, holdWeight: onHold ? pendingWeight : 0, normalWeight: onHold ? 0 : pendingWeight };
  }

  function rundownSeries(totalWeightT, rows) {
    let actualUsed = 0;
    let plannedUsed = 0;
    return rows.map(row => {
      actualUsed += number(row.actual);
      plannedUsed += number(row.planned);
      return {
        ...row,
        actualRemaining: Math.max(0, number(totalWeightT) - actualUsed),
        plannedRemaining: Math.max(0, number(totalWeightT) - plannedUsed),
      };
    });
  }

  function compute() {
    const { moduleRows, stageRows } = filteredRows();
    const moduleSpools = (state.spools || []).filter(spool => !filters.module || upper(spool.module) === filters.module);
    const spools = new Map(moduleSpools.map(spool => [normalizeSpoolKey(spool.source_key), spool]));
    const rowsBySpool = groupBySpool(moduleRows);
    const selectedWeek = filters.week;

    const cumulativeStages = STAGES.map(stage => ({ label: stage.label, value: stageRows.filter(row => Boolean(row[stage.key])).length }));
    const selectedStages = STAGES.map(stage => ({ label: stage.label, value: selectedWeek ? stageRows.filter(row => weekKey(row[stage.key]) === selectedWeek).length : stageRows.filter(row => Boolean(row[stage.key])).length }));
    const weeks = allWeeks(stageRows);
    const stageWeekly = weeks.map(key => ({
      key, label: weekLabel(key, true),
      corte: stageRows.filter(row => weekKey(row.cutting_date) === key).length,
      montagem: stageRows.filter(row => weekKey(row.coupling_date) === key).length,
      soldagem: stageRows.filter(row => weekKey(row.welding_date) === key).length,
    }));

    const pipeRows = moduleRows.filter(row => upper(row.placement) === 'PIPE');
    const pipeCount = new Map();
    pipeRows.forEach(row => { const key = normalizeSpoolKey(row.spool_key); pipeCount.set(key, (pipeCount.get(key) || 0) + 1); });

    const weldedInchesByDate = new Map();
    const weldedJointsByWeek = new Map();
    const weldedWeightByWeek = new Map();
    let weldedJointsTotal = 0;
    for (const row of pipeRows) {
      if (!row.welding_date) continue;
      weldedJointsTotal += 1;
      const d = dateOnly(row.welding_date);
      weldedInchesByDate.set(d, (weldedInchesByDate.get(d) || 0) + parseDiameterInches(row.diameter_inch));
      const wk = weekKey(row.welding_date);
      if (!wk) continue;
      weldedJointsByWeek.set(wk, (weldedJointsByWeek.get(wk) || 0) + 1);
      const spoolKey = normalizeSpoolKey(row.spool_key);
      const spool = spools.get(spoolKey);
      const totalPipe = pipeCount.get(spoolKey) || 0;
      if (spool && totalPipe) weldedWeightByWeek.set(wk, (weldedWeightByWeek.get(wk) || 0) + proportionalWeight(spool.weight_kg, totalPipe));
    }

    const fabricated = [];
    let fabricatedWeight = 0;
    let pendingFabricationWeight = 0;
    let holdPendingWeight = 0;
    let eligibleSpools = 0;
    let pendingDimensionalJoints = 0;
    for (const [key, spoolRows] of rowsBySpool.entries()) {
      const fabrication = fabricationState(spoolRows);
      if (!fabrication.pipeCount) continue;
      eligibleSpools += 1;
      const spool = spools.get(key);
      const weight = number(spool?.weight_kg);
      const pending = fabrication.pending;
      pendingDimensionalJoints += pending;
      const backlog = backlogState(weight, fabrication.pipeCount, pending, spool?.on_hold || /HOLD/.test(upper(spool?.manufacture_status)));
      holdPendingWeight += backlog.holdWeight;
      pendingFabricationWeight += backlog.normalWeight;
      if (fabrication.fabricated) {
        fabricated.push({ key, completedAt: fabrication.completedAt, weight, joints: fabrication.pipeCount });
        fabricatedWeight += weight;
      }
    }

    const fabricatedByWeek = new Map();
    fabricated.forEach(item => {
      const wk = weekKey(item.completedAt);
      if (!wk) return;
      const current = fabricatedByWeek.get(wk) || { count: 0, weight: 0 };
      current.count += 1; current.weight += item.weight; fabricatedByWeek.set(wk, current);
    });

    const productionKeys = new Set([...weeks, ...weldedJointsByWeek.keys(), ...fabricatedByWeek.keys()]);
    const productionWeekly = [...productionKeys].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b); return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    }).map(key => ({
      key, label: weekLabel(key, true),
      fabricated: fabricatedByWeek.get(key)?.count || 0,
      weldedJoints: weldedJointsByWeek.get(key) || 0,
      weldedWeightT: (weldedWeightByWeek.get(key) || 0) / 1000,
    }));

    const plannedWeight = new Map();
    moduleSpools.forEach(spool => {
      const wk = weekKey(spool.manufacture_schedule_date);
      if (wk) plannedWeight.set(wk, (plannedWeight.get(wk) || 0) + number(spool.weight_kg));
    });
    const weightKeys = new Set([...weldedWeightByWeek.keys(), ...plannedWeight.keys()]);
    const weightWeekly = [...weightKeys].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b); return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    }).map(key => ({ key, label: weekLabel(key, true), actual: (weldedWeightByWeek.get(key) || 0) / 1000, planned: (plannedWeight.get(key) || 0) / 1000 }));

    const totalWeight = moduleSpools.reduce((sum, spool) => sum + number(spool.weight_kg), 0) / 1000;
    const rundown = rundownSeries(totalWeight, weightWeekly);

    const selectedStart = weekStart(selectedWeek);
    const dailyInches = [];
    if (selectedStart) {
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(selectedStart.getTime() + i * 86400000);
        const iso = dateOnly(d);
        dailyInches.push({ label: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(d), value: weldedInchesByDate.get(iso) || 0 });
      }
    } else {
      [...weldedInchesByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([iso, value]) => {
        const d = parseDate(iso);
        dailyInches.push({ label: d ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(d) : iso, value });
      });
    }

    const statusMap = new Map();
    moduleSpools.forEach(spool => { const status = cleanStatus(spool.manufacture_status || spool.assembly_status); statusMap.set(status, (statusMap.get(status) || 0) + 1); });
    const statuses = [...statusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    const aptPainting = moduleSpools.filter(spool => cleanStatus(spool.manufacture_status) === 'Aguardando Pintura de Fundo').length;
    const inaptStatuses = new Set(['Não iniciado', 'Não alocado', 'Spool de Campo']);
    const inaptWeightStatuses = new Set(['Não iniciado', 'Não alocado']);
    const inaptQty = moduleSpools.filter(spool => inaptStatuses.has(cleanStatus(spool.manufacture_status))).length;
    const inaptWeight = moduleSpools.filter(spool => inaptWeightStatuses.has(cleanStatus(spool.manufacture_status))).reduce((sum, spool) => sum + number(spool.weight_kg), 0) / 1000;
    const pendingTraceability = moduleRows.filter(row => isApproved(row.dimensional_status) && /RASTREAB/.test(normalizeText(row.situation))).length;
    const releasedJoints = moduleRows.filter(isReleased).length;

    const releaseValueByWeek = new Map();
    let pricedReleased = 0; let releasedValue = 0;
    moduleRows.forEach(row => {
      if (!isReleased(row) || !row.release_date) return;
      const rate = scopeRateFor(row);
      if (!rate) return;
      pricedReleased += 1;
      releasedValue += rate;
      const wk = weekKey(row.release_date);
      if (wk) releaseValueByWeek.set(wk, (releaseValueByWeek.get(wk) || 0) + rate);
    });
    let cumulativeValue = 0;
    const valueSeries = [...releaseValueByWeek.keys()].sort((a, b) => {
      const pa = parseWeekKey(a); const pb = parseWeekKey(b); return (pa.year * 100 + pa.week) - (pb.year * 100 + pb.week);
    }).map(key => { cumulativeValue += releaseValueByWeek.get(key) || 0; return { key, label: weekLabel(key, true), value: cumulativeValue }; });

    const selectedProduction = selectedWeek
      ? (productionWeekly.find(row => row.key === selectedWeek) || { fabricated: 0, weldedJoints: 0, weldedWeightT: 0 })
      : productionWeekly.reduce((total, row) => ({
        fabricated: total.fabricated + row.fabricated,
        weldedJoints: total.weldedJoints + row.weldedJoints,
        weldedWeightT: total.weldedWeightT + row.weldedWeightT,
      }), { fabricated: 0, weldedJoints: 0, weldedWeightT: 0 });
    const selectedInches = dailyInches.reduce((sum, row) => sum + row.value, 0);
    const dateFields = [...STAGES.map(stage => stage.key), 'release_date', 'inspection_release_date'];
    let invalidDates = 0;
    let futureDates = 0;
    let approvedWithoutDate = 0;
    for (const row of moduleRows) {
      for (const field of dateFields) {
        if (!row[field]) continue;
        const parsed = parseDate(row[field]);
        if (!parsed) invalidDates += 1;
        else if (parsed.getTime() > Date.now() + 86400000) futureDates += 1;
      }
      if (isApproved(row.dimensional_status) && !row.dimensional_date) approvedWithoutDate += 1;
    }
    const missingSpoolRows = moduleRows.filter(row => !spools.has(normalizeSpoolKey(row.spool_key))).length;
    const spoolsWithoutPipe = moduleSpools.filter(spool => {
      const rows = rowsBySpool.get(normalizeSpoolKey(spool.source_key)) || [];
      return !rows.some(row => upper(row.placement) === 'PIPE');
    }).length;
    const unparsedDiameters = pipeRows.filter(row => row.welding_date && parseDiameterInches(row.diameter_inch) <= 0).length;
    const fabricatedWithoutWeight = fabricated.filter(item => item.weight <= 0).length;

    return {
      moduleRows, stageRows, moduleSpools, cumulativeStages, selectedStages, stageWeekly, dailyInches,
      productionWeekly, weightWeekly, rundown, statuses, totalWeight, selectedProduction, selectedInches,
      releasedJoints, weldedJointsTotal, fabricated, fabricatedWeight: fabricatedWeight / 1000, eligibleSpools,
      pendingDimensionalJoints, pendingFabricationWeight: pendingFabricationWeight / 1000,
      holdPendingWeight: holdPendingWeight / 1000, aptPainting, inaptQty, inaptWeight, pendingTraceability,
      releasedValue, pricedReleased, valueSeries,
      quality: {
        duplicateJointRows: Math.max(0, joints.length - uniqueJointRows(joints).length),
        missingSpoolRows,
        spoolsWithoutPipe,
        invalidDates,
        futureDates,
        approvedWithoutDate,
        unparsedDiameters,
        fabricatedWithoutWeight,
      },
    };
  }

  function periodRows(rows) {
    if (filters.period === 'all') return rows;
    return rows.slice(-Math.max(1, Number(filters.period || 16)));
  }

  function lineChart(target, rows, series, formatter = value => fmt(value)) {
    const el = document.querySelector(target);
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="brd-empty"><div><strong>Sem dados para este filtro.</strong></div></div>'; return; }
    const data = periodRows(rows);
    const width = 900, height = 270, left = 58, right = 18, top = 18, bottom = 40;
    const pw = width - left - right, ph = height - top - bottom;
    const values = data.flatMap(row => series.map(s => number(row[s.key])));
    const max = Math.max(1, ...values) * 1.08;
    const x = i => data.length === 1 ? left + pw / 2 : left + i * pw / (data.length - 1);
    const y = v => top + ph - number(v) / max * ph;
    let html = `<div class="brd-legend">${series.map(s => `<span><i></i>${escape(s.label)}</span>`).join('')}</div><svg viewBox="0 0 ${width} ${height}" role="img">`;
    for (let t = 0; t <= 4; t += 1) {
      const val = max * t / 4, yy = top + ph - t * ph / 4;
      html += `<line class="brd-gridline" x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}"></line><text class="brd-axis" x="${left-8}" y="${yy+4}" text-anchor="end">${escape(formatter(val))}</text>`;
    }
    data.forEach((row, i) => {
      if (data.length <= 18 || i % 2 === 0 || i === data.length - 1) html += `<text class="brd-axis" x="${x(i)}" y="${height-12}" text-anchor="middle">${escape(row.label)}</text>`;
    });
    series.forEach((s, si) => {
      const pts = data.map((row, i) => `${x(i)},${y(row[s.key])}`).join(' ');
      html += `<polyline class="brd-line-${si}" points="${pts}"></polyline>`;
      data.forEach((row, i) => html += `<circle class="brd-dot-${si}" cx="${x(i)}" cy="${y(row[s.key])}" r="3.5"><title>${escape(`${s.label} · ${row.label}: ${formatter(row[s.key])}`)}</title></circle>`);
    });
    html += '</svg>';
    el.innerHTML = html;
  }

  function barChart(target, rows, formatter = value => fmt(value)) {
    const el = document.querySelector(target);
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="brd-empty"><strong>Sem dados.</strong></div>'; return; }
    const width = 700, height = 235, left = 48, right = 12, top = 15, bottom = 38;
    const max = Math.max(1, ...rows.map(r => number(r.value))) * 1.08;
    const pw = width-left-right, ph=height-top-bottom, slot=pw/rows.length, bw=Math.min(50,slot*.62);
    let html = `<svg viewBox="0 0 ${width} ${height}" role="img">`;
    for (let t=0;t<=4;t+=1){const val=max*t/4,yy=top+ph-t*ph/4;html+=`<line class="brd-gridline" x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}"></line><text class="brd-axis" x="${left-7}" y="${yy+4}" text-anchor="end">${escape(formatter(val))}</text>`;}
    rows.forEach((row,i)=>{const v=number(row.value),h=v/max*ph,x=left+slot*i+(slot-bw)/2,y=top+ph-h;html+=`<rect class="brd-bar" x="${x}" y="${y}" width="${bw}" height="${h}" rx="5"><title>${escape(`${row.label}: ${formatter(v)}`)}</title></rect><text class="brd-axis" x="${x+bw/2}" y="${height-11}" text-anchor="middle">${escape(row.label)}</text>`;});
    html+='</svg>';el.innerHTML=html;
  }

  function listBars(target, rows) {
    barChart(target, rows);
  }

  function statusBars(target, rows) {
    barChart(target, rows.slice(0, 12));
  }

  function render() {
    const content=document.querySelector('#dashboardContent'); if(!content)return;
    const d=compute();
    document.querySelector('#dashboardNavCount').textContent=fmt(d.moduleRows.length);
    const sourceName=document.querySelector('#dashboardSourceName'); if(sourceName)sourceName.textContent=sourceMeta.file||'Joint Traceability + Spool Map';
    const sourceTime=document.querySelector('#dashboardSourceTime'); if(sourceTime)sourceTime.textContent=sourceMeta.updatedAt?`Atualizado ${new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(sourceMeta.updatedAt))}`:(sourceMeta.error?'Verifique a base e tente Atualizar':(joints.length?'Base carregada':'Sem registros ativos'));
    const fabricationPct=d.eligibleSpools?d.fabricated.length/d.eligibleSpools*100:0;
    const selectedStage=d.selectedStages.find(r=>r.label==='Soldagem')?.value||0;
    const priceCoverage=d.releasedJoints?d.pricedReleased/d.releasedJoints*100:0;
    const dashboardNotice = sourceMeta.error
      ? `<div class="brd-note warn"><strong>Os gráficos estão visíveis, mas a base operacional não carregou.</strong> ${escape(sourceMeta.error)} Use <strong>Atualizar</strong> após entrar no painel para preencher os valores.</div>`
      : (!joints.length ? '<div class="brd-note warn"><strong>A base Joint Traceability P85 está sem registros ativos.</strong> Os cartões e os gráficos estão prontos, mas os valores de juntas só aparecem depois que o Mapa de Juntas for importado e aplicado. <button type="button" class="button secondary brd-inline-action" id="dashboardImportCta">Importar Mapa de Juntas</button></div>' : '');

    content.innerHTML=`
      ${dashboardNotice}
      <div class="brd-kpis">
        <article class="brd-kpi success"><span>Juntas liberadas</span><strong>${fmt(d.releasedJoints)}</strong><small>Data de liberação / situação atual</small></article>
        <article class="brd-kpi success"><span>Spools 100% dimensional</span><strong>${fmt(d.fabricated.length)}</strong><small>${fmt(fabricationPct,1)}% dos spools PIPE elegíveis</small></article>
        <article class="brd-kpi"><span>Peso fabricado</span><strong>${fmt(d.fabricatedWeight,2)} t</strong><small>Soma do peso dos spools concluídos</small></article>
        <article class="brd-kpi"><span>Juntas soldadas</span><strong>${fmt(d.weldedJointsTotal)}</strong><small>Acumulado de juntas PIPE</small></article>
        <article class="brd-kpi warn"><span>Backlog fabricação</span><strong>${fmt(d.pendingFabricationWeight,2)} t</strong><small>${fmt(d.pendingDimensionalJoints)} juntas PIPE pendentes</small></article>
        <article class="brd-kpi warn"><span>Peso em hold</span><strong>${fmt(d.holdPendingWeight,2)} t</strong><small>Peso pendente proporcional em spools hold</small></article>
        <article class="brd-kpi"><span>Aptos para pintura</span><strong>${fmt(d.aptPainting)}</strong><small>Status: Aguardando Pintura de Fundo</small></article>
        <article class="brd-kpi ${d.pendingTraceability?'danger':'success'}"><span>Rastreabilidade pendente</span><strong>${fmt(d.pendingTraceability)}</strong><small>Dimensional aprovado com pendência de material</small></article>
      </div>

      <div class="brd-section"><div class="brd-section-head"><div><p class="eyebrow">PRODUÇÃO</p><h3>Evolução e desempenho de fábrica</h3></div><p>${escape(weekLabel(filters.week))}</p></div>
        <div class="brd-grid">
          <article class="brd-card brd-span-12"><div class="brd-card-head"><div><h4>Evolução semanal · quantidade</h4><p>Reprodução do gráfico “Evolução Semanal (QTD)”: Corte, Montagem e Soldagem.</p></div><span class="brd-chip">Relatório 1/10</span></div><div id="dbStageWeekly" class="brd-chart"></div></article>
          <article class="brd-card"><div class="brd-card-head"><div><h4>Quantidade acumulada por etapa</h4><p>Oito etapas do fluxo de fabricação.</p></div><span class="brd-chip">Relatório 3/10</span></div><div id="dbCumulative" class="brd-chart compact"></div></article>
          <article class="brd-card"><div class="brd-card-head"><div><h4>Quantidade da semana selecionada</h4><p>Mesma leitura do gráfico semanal da planilha, sem valores congelados.</p></div><span class="brd-chip">Relatório 5/10</span></div><div id="dbWeekStages" class="brd-chart compact"></div></article>
          <article class="brd-card"><div class="brd-card-head"><div><h4>Polegadas soldadas por dia</h4><p>Soma do diâmetro das juntas PIPE pela data de soldagem.</p></div><span class="brd-chip">Relatório 2/10</span></div><div id="dbDailyInches" class="brd-chart compact"></div></article>
          <article class="brd-card"><div class="brd-card-head"><div><h4>Comparativo de desempenho da fábrica</h4><p>O gráfico original mistura três escalas. Aqui elas ficam sincronizadas e separadas para leitura correta.</p></div><span class="brd-chip">Relatórios 7–8/10</span></div><div class="brd-mini-grid"><div class="brd-mini"><h5>Spools fabricados</h5><strong>${fmt(d.selectedProduction.fabricated)}</strong><small>${escape(weekLabel(filters.week,true))}</small><div id="dbMiniSpools"></div></div><div class="brd-mini"><h5>Juntas soldadas</h5><strong>${fmt(d.selectedProduction.weldedJoints)}</strong><small>${escape(weekLabel(filters.week,true))}</small><div id="dbMiniJoints"></div></div><div class="brd-mini"><h5>Peso soldado</h5><strong>${fmt(d.selectedProduction.weldedWeightT,2)} t</strong><small>${escape(weekLabel(filters.week,true))}</small><div id="dbMiniWeight"></div></div></div></article>
        </div>
      </div>

      <div class="brd-section"><div class="brd-section-head"><div><p class="eyebrow">PESO & PROGRAMAÇÃO</p><h3>Real, planejado e rundown</h3></div><p>Spool Map + Joint Traceability</p></div>
        <div class="brd-grid">
          <article class="brd-card brd-span-8"><div class="brd-card-head"><div><h4>Peso semanal de juntas soldadas</h4><p>Peso do spool rateado pelas juntas PIPE, agrupado pela semana da soldagem.</p></div><span class="brd-chip">Relatório 4/10</span></div><div id="dbWeightWeekly" class="brd-chart"></div></article>
          <article class="brd-card brd-span-4"><div class="brd-card-head"><div><h4>Fabricado x backlog</h4><p>Base: spools com juntas PIPE.</p></div></div><div class="brd-ring-wrap"><div class="brd-ring" style="--p:${Math.min(100,fabricationPct)}"><div><strong>${fmt(fabricationPct,1)}%</strong><small>fabricado</small></div></div><div class="brd-split"><div><span>Fabricados</span><strong>${fmt(d.fabricated.length)}</strong></div><div><span>Backlog</span><strong>${fmt(Math.max(0,d.eligibleSpools-d.fabricated.length))}</strong></div><div><span>Elegíveis</span><strong>${fmt(d.eligibleSpools)}</strong></div></div></div></article>
          <article class="brd-card brd-span-8"><div class="brd-card-head"><div><h4>Fabrication rundown · peso remanescente</h4><p>Atualização do rundown legado: saldo real comparado ao peso programado no Spool Map, sem usar o planejamento Brasfels obsoleto.</p></div><span class="brd-chip">Relatório 9/10</span></div><div id="dbRundown" class="brd-chart"></div></article>
          <article class="brd-card brd-span-4"><div class="brd-card-head"><div><h4>Análise de escopo · status</h4><p>Distribuição atual do Manufacture Status.</p></div><span class="brd-chip">Relatório 10/10</span></div><div id="dbStatuses" class="brd-chart compact"></div></article>
        </div>
      </div>

      <div class="brd-section"><div class="brd-section-head"><div><p class="eyebrow">VALOR AGREGADO</p><h3>Liberação técnica valorizada</h3></div><p>Somente quando há vínculo verificável com a tabela de escopo</p></div>
        <div class="brd-grid">
          <article class="brd-card brd-span-12"><div class="brd-card-head"><div><h4>Valor agregado por juntas liberadas</h4><p>O legado valorizava cada junta pela faixa diâmetro/espessura. Aqui a junta atual é vinculada ao escopo e à classe de inspeção antes de receber valor.</p></div><span class="brd-chip">Relatório 6/10</span></div><div id="dbValueSeries" class="brd-chart"></div>${d.pricedReleased?`<div class="brd-note">Cobertura de valorização: <strong>${fmt(d.pricedReleased)}</strong> de <strong>${fmt(d.releasedJoints)}</strong> juntas liberadas (${fmt(priceCoverage,1)}%). Valor acumulado verificável: <strong>${escape(money(d.releasedValue))}</strong>.</div>`:`<div class="brd-note warn"><strong>Valor não exibido.</strong> O Dashboard não vai estimar preço médio. É necessário existir vínculo entre Joint Traceability, Base CS e tabela de valores para reproduzir este relatório sem inventar dados.</div>`}</article>
        </div>
      </div>

      <details class="brd-audit"><summary>Rastreabilidade dos 10 relatórios analisados</summary><div class="brd-audit-grid">
        <div class="brd-audit-item"><strong>1 · Evolução semanal</strong><span>Excel: BASE DE DADOS K41/K42/K44 × semanas AI:BC.</span><code>DB: cutting_date + coupling_date + welding_date</code></div>
        <div class="brd-audit-item"><strong>2 · Polegadas soldadas / dia</strong><span>Excel: POL SOLDADAS, soma de diâmetro para PIPE pela data de soldagem.</span><code>DB: diameter_inch + welding_date + placement=PIPE</code></div>
        <div class="brd-audit-item"><strong>3 · Quantidade acumulada</strong><span>Excel: 8 etapas, BASE DE DADOS K52:L59.</span><code>DB: datas preenchidas das 8 etapas do Joint Traceability</code></div>
        <div class="brd-audit-item"><strong>4 · Peso semanal soldado</strong><span>Excel: PESO - JUNTAS SOLDADAS → BASE DE DADOS linha 81.</span><code>DB: weight_kg do spool ÷ juntas PIPE × juntas soldadas</code></div>
        <div class="brd-audit-item"><strong>5 · Quantidade da semana</strong><span>Excel: INDEX da matriz semanal K41:BC48.</span><code>DB: mesma contagem das etapas filtrada por WEEKNUM(data,14)-1</code></div>
        <div class="brd-audit-item"><strong>6 · Valor agregado</strong><span>Excel: quantidade liberada × valor unitário por diâmetro/espessura.</span><code>DB: release_date + inspection_class + p85_scope_joints + p85_scope_inspection_rates</code></div>
        <div class="brd-audit-item"><strong>7–8 · Desempenho de fábrica</strong><span>Excel: gráfico composto com peso, juntas e spools em escalas diferentes.</span><code>DB: três séries semanais separadas para evitar distorção visual</code></div>
        <div class="brd-audit-item"><strong>9 · Rundown</strong><span>Excel: peso real + planejamentos e replanejamentos manuais/obsoletos.</span><code>DB: peso real soldado × manufacture_schedule_date atual</code></div>
        <div class="brd-audit-item"><strong>10 · Análise de escopo</strong><span>Excel: COUNTIF no status de fabricação do BASE SPOOL.</span><code>DB: manufacture_status ativo do Spool Map</code></div>
        <div class="brd-audit-item"><strong>Regra de semana</strong><span>A planilha usa uma semana não ISO.</span><code>WEEKNUM(data,14)-1 mantido por compatibilidade</code></div>
      </div></details>
      <div class="brd-source-strip"><span><strong>Joint Traceability:</strong> ${fmt(d.moduleRows.length)} juntas</span><span><strong>Spool Map:</strong> ${fmt(d.moduleSpools.length)} spools</span><span><strong>Semana:</strong> ${escape(weekLabel(filters.week))}</span><span><strong>Soldagem na semana:</strong> ${fmt(selectedStage)}</span><span><strong>Polegadas na semana:</strong> ${fmt(d.selectedInches,1)}″</span><span><strong>Qualidade:</strong> ${fmt(d.quality.duplicateJointRows + d.quality.missingSpoolRows + d.quality.invalidDates + d.quality.approvedWithoutDate + d.quality.unparsedDiameters)} alertas detectáveis</span></div>`;

    lineChart('#dbStageWeekly', d.stageWeekly, [{key:'corte',label:'Corte'},{key:'montagem',label:'Montagem'},{key:'soldagem',label:'Soldagem'}]);
    listBars('#dbCumulative', d.cumulativeStages);
    listBars('#dbWeekStages', d.selectedStages);
    barChart('#dbDailyInches', d.dailyInches, v=>fmt(v,0));
    barChart('#dbMiniSpools', periodRows(d.productionWeekly).slice(-8).map(r=>({label:r.label,value:r.fabricated})), v=>fmt(v));
    barChart('#dbMiniJoints', periodRows(d.productionWeekly).slice(-8).map(r=>({label:r.label,value:r.weldedJoints})), v=>fmt(v));
    barChart('#dbMiniWeight', periodRows(d.productionWeekly).slice(-8).map(r=>({label:r.label,value:r.weldedWeightT})), v=>`${fmt(v,1)} t`);
    barChart('#dbWeightWeekly', d.weightWeekly.map(row=>({ label: row.label, value: row.actual })), v=>`${fmt(v,1)} t`);
    lineChart('#dbRundown', d.rundown, [{key:'actualRemaining',label:'Saldo real'},{key:'plannedRemaining',label:'Saldo planejado'}], v=>`${fmt(v,1)} t`);
    statusBars('#dbStatuses', d.statuses);
    if (d.pricedReleased) lineChart('#dbValueSeries', d.valueSeries, [{key:'value',label:'Valor agregado'}], v=>money(v));
    else document.querySelector('#dbValueSeries').innerHTML='<div class="brd-empty"><div><strong>Sem cobertura de valores suficiente.</strong><span>Nenhum valor será inferido sem correspondência comprovada.</span></div></div>';
    document.querySelector('#dashboardImportCta')?.addEventListener('click', () => document.querySelector('#openImport')?.click());
  }

  async function loadData(showToast) {
    const content=document.querySelector('#dashboardContent');
    sourceMeta.error = '';
    if(!state.supabase.token){
      sourceMeta.error = 'Entre no painel para carregar os valores operacionais.';
      buildFilters(); render();
      return;
    }
    if(content) render();
    try {
      if (!state.spools?.length && window.loadBrasfelsRemoteData) await window.loadBrasfelsRemoteData({ silent: true });
      const id=await getProjectId();
      const [jointRows, jointSummary, scopeRows, rateRows, scopeSummary] = await Promise.all([
        fetchAll(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${JOINT_DATASET}&source_active=eq.true&select=payload,source_file_name,updated_at&order=source_row.asc`),
        rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(id)}&dataset_type=eq.${JOINT_DATASET}&select=active_rows,last_updated_at,source_file_name&limit=1`),
        fetchAll(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${SCOPE_JOINTS}&source_active=eq.true&select=source_key,payload`),
        fetchAll(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${SCOPE_RATES}&source_active=eq.true&select=payload`),
        rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(id)}&dataset_type=eq.${SCOPE_JOINTS}&select=source_file_name,last_updated_at&limit=1`),
      ]);
      joints=jointRows.map(row=>({...(row.payload||{})}));
      scopeJointMap=new Map(scopeRows.map(row=>[upper(row.source_key),row.payload||{}]));
      scopeRateMap=new Map(rateRows.map(row=>[normalizeText(row.payload?.faixa_diametro_espessura),row.payload||{}]));
      sourceMeta={
        file: jointSummary[0]?.source_file_name || jointRows[0]?.source_file_name || '',
        updatedAt: jointSummary[0]?.last_updated_at || jointRows.reduce((latest,row)=>!latest||String(row.updated_at)>String(latest)?row.updated_at:latest,''),
        scopeFile: scopeSummary[0]?.source_file_name || '',
        error: '',
      };
      buildFilters(); render();
      if(showToast)toast(`Dashboard atualizado: ${fmt(joints.length)} juntas analisadas.`);
    } catch(error) {
      sourceMeta.error = error.message || 'Falha ao carregar as fontes operacionais.';
      buildFilters(); render();
      if(showToast)toast(error.message,'error');
    }
  }

  function install() {
    if(installed)return;
    createView();
    if(!document.querySelector(`#${VIEW_ID}`)){setTimeout(install,300);return;}
    installed=true;
    currentToken=state.supabase.token||'';
    if(currentToken)loadData(false);
    setInterval(()=>{
      const token=state.supabase.token||'';
      if(token&&token!==currentToken){currentToken=token;projectId='';loadData(false);} else if(!token)currentToken='';
    },1800);
  }

  window.BrasfelsDashboardInternals = Object.freeze({
    legacyWeekNumber,
    parseDiameterInches,
    normalizeSpoolKey,
    isApproved,
    fabricationState,
    proportionalWeight,
    backlogState,
    rundownSeries,
    uniqueJointRows,
  });
  window.addEventListener('load',()=>setTimeout(install,2550));
  window.BrasfelsDashboard={open:openView,refresh:()=>loadData(false)};
})();

