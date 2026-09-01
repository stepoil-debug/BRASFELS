'use strict';

(function () {
  const WORKER_URL = 'excel-import-worker-v2.js?v=9';
  const DATASET_LABELS = {
    p85_materials_raw: 'Materiais P85 (origem)', p85_unlinked_materials: 'Materiais P85 ainda sem spool', p83_spools: 'Spools P83',
    p83_joints: 'Mapa de juntas P83', p83_backlog: 'Backlog P83', p83_drawings: 'Controle de desenhos P83', p83_schedule: 'Programação P83',
    p83_measurement_summary: 'Resumo de medição P83', p83_finished_spools: 'Spools finalizados P83', p83_support_control: 'Controle de suportes P83',
    p83_billing_control: 'Controle de faturamento P83', p83_measurement_report: 'Relatório de medição P83', p83_measured_totals: 'Totais medidos P83',
    p83_supports: 'Suportes SGJ P83', p83_invoices: 'Notas fiscais P83',
  };
  let activeWorker = null, cancelRequested = false, sourceProjectId = '', sourceSummaries = [], installed = false;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  const encode = value => encodeURIComponent(String(value ?? ''));
  const fileKind = fileName => { const name = normHeader(fileName); if (name.includes('spool map')) return 'spool_map'; if (name.includes('spool materials')) return 'spool_materials'; if (name.includes('grafico') || name.includes('graficos')) return 'p83_production'; if (name.includes('faturamento')) return 'p83_billing'; return 'unknown'; };

  function setImportProgress(title, detail, current = null, total = null, error = false) {
    const progress = $('#modalProgress'); if (!progress) return; progress.hidden = false; progress.classList.toggle('error', error);
    $('#progressTitle').textContent = title || 'Processando...'; $('#progressDetail').textContent = detail || '';
    let bar = progress.querySelector('.import-v2-progress-track');
    if (!bar) { bar = document.createElement('div'); bar.className = 'import-v2-progress-track'; bar.innerHTML = '<i></i>'; progress.appendChild(bar); }
    const ratio = Number.isFinite(current) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, current / total * 100)) : null;
    bar.classList.toggle('indeterminate', ratio === null); bar.querySelector('i').style.width = ratio === null ? '35%' : `${ratio}%`;
  }

  function resetImportUi() {
    activeWorker?.terminate(); activeWorker = null; cancelRequested = false;
    const validate = $('#validateImport'), apply = $('#applyImport'), cancel = $('#cancelImport');
    if (validate) { validate.hidden = false; validate.disabled = !state.files.length; validate.textContent = 'Validar arquivos'; }
    if (apply) { apply.hidden = true; apply.disabled = true; apply.textContent = 'Aplicar atualização'; }
    if (cancel) { cancel.disabled = false; cancel.textContent = 'Cancelar'; }
    if ($('#modalProgress')) { $('#modalProgress').hidden = true; $('#modalProgress').classList.remove('error'); }
  }

  function cancelImportV2() {
    if (activeWorker) { cancelRequested = true; activeWorker.terminate(); activeWorker = null; resetImportUi(); toast('Processamento cancelado.', 'error'); return; }
    $('#importModal').hidden = true;
  }

  function runWorker(file, allowedKeys) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`; const worker = new Worker(WORKER_URL); activeWorker = worker;
      worker.onmessage = event => { const message = event.data || {}; if (message.id !== id) return;
        if (message.kind === 'progress') { setImportProgress(message.stage, message.detail, message.current, message.total); return; }
        worker.terminate(); if (activeWorker === worker) activeWorker = null;
        if (message.kind === 'result') resolve(message.result); else reject(new Error(message.error || 'Falha no processador de Excel.'));
      };
      worker.onerror = event => { worker.terminate(); if (activeWorker === worker) activeWorker = null; reject(new Error(event.message || 'O processador em segundo plano falhou.')); };
      worker.postMessage({ id, file, allowedKeys: [...allowedKeys] });
    });
  }

  async function validateImportV2() {
    if (!state.files.length) return;
    if (typeof Worker === 'undefined') { toast('Este navegador não suporta o processador de planilhas em segundo plano.', 'error'); return; }
    const validate = $('#validateImport'), apply = $('#applyImport'), cancel = $('#cancelImport');
    validate.disabled = true; validate.textContent = 'Processando...'; apply.hidden = true; apply.disabled = true; cancel.disabled = false; cancel.textContent = 'Cancelar processamento'; $('#validationSummary').hidden = true; cancelRequested = false;
    const order = { spool_map: 0, spool_materials: 1, p83_production: 2, p83_billing: 3, unknown: 4 };
    const selected = state.files.map(file => ({ file, type: fileKind(file.name) })).sort((a, b) => order[a.type] - order[b.type]);
    const allowedKeys = new Set(state.spools.map(item => item.source_key)), analyses = [], errors = [];
    for (let index = 0; index < selected.length; index += 1) {
      if (cancelRequested) return; const item = selected[index]; setImportProgress(`Arquivo ${index + 1} de ${selected.length}`, item.file.name); await frame();
      try {
        if (item.type === 'unknown') throw new Error('Modelo de arquivo não reconhecido.');
        const result = await runWorker(item.file, allowedKeys); result.file = item.file; result.mode = result.type === 'spool_map' || result.type === 'spool_materials' ? 'operational' : 'complementary';
        result.rowCount = result.rowCount ?? result.records?.length ?? 0; result.duplicateFile = state.imports.some(history => history.hash === result.hash && history.status === 'completed'); analyses.push(result);
        if (result.type === 'spool_map') result.records.forEach(record => allowedKeys.add(record.source_key));
      } catch (error) { if (cancelRequested) return; errors.push(`${item.file.name}: ${error.message}`); }
    }
    if (cancelRequested) return; state.pending = { analyses, errors };
    const spoolCount = analyses.find(item => item.type === 'spool_map')?.records.length || 0, materialCount = analyses.find(item => item.type === 'spool_materials')?.records.length || 0;
    const complementaryRows = analyses.filter(item => item.mode === 'complementary').reduce((total, item) => total + Number(item.rowCount || 0), 0);
    const datasetCount = analyses.reduce((total, item) => total + Number(item.datasets?.length || 0), 0);
    const validToApply = analyses.some(item => !item.duplicateFile && ((item.records?.length || 0) > 0 || (item.datasets?.length || 0) > 0));
    $('#validationSummary').hidden = false;
    $('#validationSummary').innerHTML = `<div class="validation-grid import-v2-summary-grid"><div><span>Spools P85</span><strong>${fmt(spoolCount)}</strong></div><div><span>Materiais P85</span><strong>${fmt(materialCount)}</strong></div><div><span>Linhas complementares</span><strong>${fmt(complementaryRows)}</strong></div><div><span>Conjuntos identificados</span><strong>${fmt(datasetCount)}</strong></div></div>${errors.length ? `<p class="warn"><strong>Arquivos com problema:</strong><br>${errors.map(escapeHtml).join('<br>')}</p>` : ''}<div class="selected-files import-v2-results">${analyses.map(item => { const rows = item.type === 'spool_map' || item.type === 'spool_materials' ? item.records.length : item.rowCount; const detail = item.datasets?.length ? `${item.datasets.length} conjuntos · ${fmt(rows)} linhas` : `${fmt(rows)} linhas`; return `<div class="file-row"><span>✓</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.fileName)} · ${detail}</small></div>${item.duplicateFile ? '<span class="tag amber">Já aplicado</span>' : '<span class="tag green">Pronto</span>'}</div>`; }).join('')}</div>`;
    $('#modalProgress').hidden = true; validate.hidden = true; validate.textContent = 'Validar arquivos'; apply.hidden = false; apply.disabled = !validToApply; cancel.disabled = false; cancel.textContent = 'Cancelar';
  }

  function restHeaders(write = false) { const headers = { apikey: state.supabase.key, Authorization: `Bearer ${state.supabase.token}`, 'Accept-Profile': 'brasfels', 'Content-Profile': 'brasfels', 'Content-Type': 'application/json' }; if (write) headers.Prefer = 'resolution=merge-duplicates,return=minimal'; return headers; }
  async function rest(path, options = {}) { const method = options.method || 'GET'; const response = await fetch(`${state.supabase.url}${path}`, { method, headers: restHeaders(method !== 'GET'), body: options.body === undefined ? undefined : JSON.stringify(options.body) }); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || payload.msg || payload.error || `Erro ${response.status} no Supabase.`); } if (response.status === 204 || method !== 'GET') return []; return response.json(); }
  async function getProjectId() { if (sourceProjectId) return sourceProjectId; const projects = await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`); if (!projects.length) throw new Error('Projeto FPSO-P85 não encontrado no schema brasfels.'); sourceProjectId = projects[0].id; return sourceProjectId; }

  function chunkByBytes(records, maxBytes = 1300000, maxRows = 100) { const chunks = []; let chunk = [], size = 2; records.forEach(record => { const recordSize = JSON.stringify(record).length + 1; if (chunk.length && (chunk.length >= maxRows || size + recordSize > maxBytes)) { chunks.push(chunk); chunk = []; size = 2; } chunk.push(record); size += recordSize; }); if (chunk.length) chunks.push(chunk); return chunks; }
  async function upsertChunks(path, rows, progressLabel, maxRows = 100) { const chunks = chunkByBytes(rows, 1300000, maxRows); let processed = 0; for (let index = 0; index < chunks.length; index += 1) { if (cancelRequested) throw new Error('Importação cancelada.'); processed += chunks[index].length; setImportProgress(progressLabel, `${fmt(processed)} de ${fmt(rows.length)} registros`, index + 1, chunks.length); await rest(path, { method: 'POST', body: chunks[index] }); await frame(); } }

  function spoolPayload(projectId, record) { const fields = ['source_key','contract','module','document','subsop','hts_sth','line','manufacturer','isometric','spool_number','spool_tag','priority','weight_kg','on_hold','spool_type','material','diameter_mm','diameter_inch','thickness_mm','specification','pipe_material','fluid','painting_condition','length_m','area_m2','total_joints','shop_joints','field_joints','manufacture_schedule_number','manufacture_schedule_date','cutting_date','fitting_date','fitup_date','welding_date','visual_inspection_date','dimensional_date','manufacture_release_date','packing_list','origin_location','sent_at','destination','received_at','received','assembly_schedule_number','assembly_schedule_date','manufacture_status','assembly_status','source_row_hash','source_data','manual_data']; const payload = { project_id: projectId, source_active: true, source_last_seen_at: new Date().toISOString() }; fields.forEach(field => { if (record[field] !== undefined) payload[field] = record[field]; }); return payload; }
  async function syncSpools(projectId, records) { if (!records.length) return { inserted: 0 }; const rows = records.map(record => spoolPayload(projectId, record)); await upsertChunks('/rest/v1/spools?on_conflict=project_id,source_key', rows, 'Gravando spools no Supabase', 90); return { inserted: rows.length }; }
  async function remoteSpoolIds(projectId) { const rows = [], pageSize = 1000; for (let offset = 0; ; offset += pageSize) { const page = await rest(`/rest/v1/spools?project_id=eq.${encode(projectId)}&source_active=eq.true&select=id,source_key&limit=${pageSize}&offset=${offset}`); rows.push(...page); if (page.length < pageSize) break; } return new Map(rows.map(record => [record.source_key, record.id])); }
  async function syncMaterials(projectId, records) { if (!records.length) return { linked: 0, unlinked: 0 }; const ids = await remoteSpoolIds(projectId), linked = [], unlinked = []; records.forEach(record => { const spoolId = ids.get(record.spool_source_key); if (!spoolId) { unlinked.push(record); return; } linked.push({ project_id: projectId, spool_id: spoolId, source_key: record.source_key, module: record.module, manufacturer_site: record.manufacturer_site, assembly_site: record.assembly_site, spool_revision: record.spool_revision, material_code: record.material_code, description: record.description, diameter_1: record.diameter_1, diameter_2: record.diameter_2, material_revision: record.material_revision, initials: record.initials, application: record.application, quantity: record.quantity, weight_kg: record.weight_kg, notes: record.notes, source_data: record.source_data || record, source_row_hash: record.source_row_hash, source_active: true, source_last_seen_at: new Date().toISOString() }); }); if (linked.length) await upsertChunks('/rest/v1/spool_materials?on_conflict=project_id,source_key', linked, 'Gravando materiais vinculados', 80); return { linked: linked.length, unlinked: unlinked.length }; }

  async function replaceSourceDataset(projectId, datasetType, fileInfo, records) { await rest(`/rest/v1/source_records?project_id=eq.${encode(projectId)}&dataset_type=eq.${encode(datasetType)}`, { method: 'PATCH', body: { source_active: false } }); const rows = records.map(record => ({ project_id: projectId, dataset_type: datasetType, source_key: record.source_key, source_file_hash: fileInfo.hash, source_file_name: fileInfo.fileName, source_sheet: record.source_sheet || datasetType, source_row: record.source_row || null, source_row_hash: record.source_row_hash, payload: record.payload || record, source_active: true })); if (rows.length) await upsertChunks('/rest/v1/source_records?on_conflict=project_id,dataset_type,source_key', rows, `Gravando ${DATASET_LABELS[datasetType] || datasetType}`, 35); }
  async function saveRawMaterials(projectId, analysis) { const raw = analysis.records.map(record => ({ dataset_type: 'p85_materials_raw', source_key: record.source_key, source_sheet: 'List', source_row: record.source_row, source_row_hash: record.source_row_hash, payload: record })); await replaceSourceDataset(projectId, 'p85_materials_raw', analysis, raw); }
  async function saveImportBatch(projectId, analysis, results) { const totalRows = analysis.type === 'spool_map' || analysis.type === 'spool_materials' ? analysis.records.length : analysis.rowCount; const batch = { project_id: projectId, source_type: analysis.type, file_name: analysis.fileName, file_hash: analysis.hash, sheet_name: analysis.datasets?.length ? analysis.datasets.map(dataset => dataset.sheet).join(', ').slice(0, 500) : null, status: 'completed', total_rows: totalRows, inserted_rows: Number(results.inserted || results.linked || totalRows || 0), updated_rows: Number(results.updated || 0), warning_rows: Number(results.unlinked || analysis.duplicates || 0), completed_at: new Date().toISOString(), validation_summary: { imported_by: 'excel-import-v2', datasets: analysis.datasets?.map(dataset => ({ type: dataset.type, sheet: dataset.sheet, rows: dataset.rows.length })) || [], results } }; await rest('/rest/v1/import_batches?on_conflict=project_id,file_hash', { method: 'POST', body: [batch] }); }
  function mergeLocal(analysis) { if (analysis.type === 'spool_map') { const result = mergeByKey(state.spools, analysis.records); state.spools = result.records; return result; } if (analysis.type === 'spool_materials') { const result = mergeByKey(state.materials, analysis.records); state.materials = result.records; return result; } return { inserted: analysis.rowCount || 0, updated: 0, unchanged: 0 }; }

  async function applyImportV2() {
    if (!state.pending?.analyses?.length) return; if (!state.supabase.token) { toast('Entre no painel antes de aplicar a atualização.', 'error'); return; }
    const apply = $('#applyImport'), cancel = $('#cancelImport'); apply.disabled = true; cancel.disabled = false; cancel.textContent = 'Cancelar processamento'; cancelRequested = false;
    const projectId = await getProjectId(), applied = [];
    try {
      for (let index = 0; index < state.pending.analyses.length; index += 1) {
        const analysis = state.pending.analyses[index]; if (analysis.duplicateFile) continue; if (cancelRequested) throw new Error('Importação cancelada.');
        apply.textContent = `Aplicando ${index + 1}/${state.pending.analyses.length}`; setImportProgress(`Aplicando ${analysis.label}`, analysis.fileName);
        const localResult = mergeLocal(analysis); let remoteResult = { ...localResult };
        if (analysis.type === 'spool_map') { remoteResult = await syncSpools(projectId, analysis.records); if (state.materials.length) remoteResult.materials = await syncMaterials(projectId, state.materials); }
        else if (analysis.type === 'spool_materials') { await saveRawMaterials(projectId, analysis); remoteResult = await syncMaterials(projectId, analysis.records); }
        else { for (const dataset of analysis.datasets || []) await replaceSourceDataset(projectId, dataset.type, analysis, dataset.rows); remoteResult = { inserted: analysis.rowCount, datasets: analysis.datasets.length }; }
        await saveImportBatch(projectId, analysis, { ...localResult, ...remoteResult });
        state.imports.push({ date: new Date().toISOString(), file: analysis.fileName, hash: analysis.hash, type: analysis.label, status: 'completed', rows: analysis.type === 'spool_map' || analysis.type === 'spool_materials' ? analysis.records.length : analysis.rowCount, inserted: Number(remoteResult.inserted || remoteResult.linked || localResult.inserted || 0), updated: Number(localResult.updated || 0), warnings: Number(remoteResult.unlinked || analysis.duplicates || 0) }); applied.push(analysis);
      }
      recalculate(); await persist(); renderAll(); if (window.renderBrasfelsProduction) window.renderBrasfelsProduction(); await loadSourceSummaries();
      if (window.loadBrasfelsRemoteData && applied.some(item => item.type === 'spool_map' || item.type === 'spool_materials')) await window.loadBrasfelsRemoteData({ silent: true });
      $('#lastUpdate').textContent = fmtDate(new Date().toISOString()); $('#modalProgress').hidden = true; $('#importModal').hidden = true; toast(`${applied.length} arquivo(s) aplicados com sucesso.`);
      showView(applied.some(item => item.mode === 'complementary') && !applied.some(item => item.mode === 'operational') ? 'source-data' : 'dashboard');
    } catch (error) { setImportProgress('Falha ao aplicar atualização', error.message || 'Erro desconhecido.', null, null, true); apply.disabled = false; apply.textContent = 'Tentar aplicar novamente'; toast(error.message || 'Falha na importação.', 'error'); }
    finally { cancel.disabled = false; cancel.textContent = 'Cancelar'; }
  }

  function installSourceView() {
    if ($('#view-source-data')) return; const nav = $('.nav'), importsNav = nav?.querySelector('[data-view="imports"]');
    if (nav && importsNav) { const button = document.createElement('button'); button.className = 'nav-item'; button.dataset.view = 'source-data'; button.innerHTML = '<span>▦</span> Dados P83 e financeiro <b id="sourceDatasetCount">0</b>'; nav.insertBefore(button, importsNav); button.onclick = () => showView('source-data'); }
    const importsView = $('#view-imports'), section = document.createElement('section'); section.id = 'view-source-data'; section.className = 'view source-data-view';
    section.innerHTML = `<div class="section-intro"><div><p class="eyebrow">BASES COMPLEMENTARES</p><h2>Produção P83, medição e faturamento</h2><p>As abas-fonte dos arquivos Gráficos e Faturamento são armazenadas separadamente. Matrizes derivadas de gráficos e fórmulas não são duplicadas.</p></div><button class="button primary import-shortcut source-import-shortcut">＋ Importar arquivo</button></div><div class="source-kpis" id="sourceKpis"></div><div class="source-layout"><article class="panel source-summary-panel"><div class="panel-header"><div><p class="eyebrow">CONJUNTOS IMPORTADOS</p><h3>Resumo das bases</h3></div><button class="button secondary" id="refreshSourceData">Atualizar</button></div><div id="sourceSummaryTable" class="source-summary-table"></div></article><article class="panel source-preview-panel"><div class="panel-header"><div><p class="eyebrow">PRÉVIA</p><h3 id="sourcePreviewTitle">Selecione um conjunto</h3></div></div><div id="sourcePreview" class="source-preview-empty">Clique em um conjunto para visualizar até 100 registros e suas colunas.</div></article></div>`;
    importsView.parentNode.insertBefore(section, importsView); $('.source-import-shortcut').onclick = () => $('#openImport').click(); $('#refreshSourceData').onclick = loadSourceSummaries;
  }

  async function loadSourceSummaries() { if (!state.supabase.token) return; try { const projectId = await getProjectId(); sourceSummaries = await rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(projectId)}&select=dataset_type,source_sheet,active_rows,last_updated_at,source_file_name&order=dataset_type.asc`); renderSourceSummaries(); } catch (error) { console.warn('Falha ao carregar bases complementares:', error); } }
  function renderSourceSummaries() { const totalRows = sourceSummaries.reduce((sum, item) => sum + Number(item.active_rows || 0), 0); const productionRows = sourceSummaries.filter(item => /^p83_(spools|joints|backlog|drawings|schedule|finished)/.test(item.dataset_type)).reduce((sum, item) => sum + Number(item.active_rows || 0), 0); const financialRows = sourceSummaries.filter(item => /(billing|measurement|measured|invoice|support)/.test(item.dataset_type)).reduce((sum, item) => sum + Number(item.active_rows || 0), 0); $('#sourceDatasetCount').textContent = fmt(sourceSummaries.length); $('#sourceKpis').innerHTML = `<article><span>Conjuntos de dados</span><strong>${fmt(sourceSummaries.length)}</strong><small>Abas-fonte armazenadas</small></article><article><span>Registros complementares</span><strong>${fmt(totalRows)}</strong><small>P83 e financeiro</small></article><article><span>Produção e engenharia</span><strong>${fmt(productionRows)}</strong><small>Spools, juntas e programação</small></article><article><span>Medição e faturamento</span><strong>${fmt(financialRows)}</strong><small>BM, NF e suportes</small></article>`; if (!sourceSummaries.length) { $('#sourceSummaryTable').innerHTML = '<div class="source-preview-empty">Nenhum arquivo P83 ou de faturamento foi aplicado.</div>'; return; } $('#sourceSummaryTable').innerHTML = sourceSummaries.map(item => `<button class="source-summary-row" data-dataset="${escapeHtml(item.dataset_type)}"><span><strong>${escapeHtml(DATASET_LABELS[item.dataset_type] || item.dataset_type)}</strong><small>${escapeHtml(item.source_sheet || '—')} · ${escapeHtml(item.source_file_name || '—')}</small></span><b>${fmt(item.active_rows)}</b><time>${fmtDate(item.last_updated_at)}</time></button>`).join(''); $$('.source-summary-row').forEach(button => { button.onclick = () => loadDatasetPreview(button.dataset.dataset); }); }
  function likelyColumns(rows) { const frequency = new Map(); rows.forEach(row => Object.keys(row.payload || {}).forEach(key => frequency.set(key, (frequency.get(key) || 0) + 1))); return [...frequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => key); }
  async function loadDatasetPreview(datasetType) { const projectId = await getProjectId(); $('#sourcePreviewTitle').textContent = DATASET_LABELS[datasetType] || datasetType; $('#sourcePreview').innerHTML = '<div class="source-preview-empty">Carregando registros...</div>'; try { const rows = await rest(`/rest/v1/source_records?project_id=eq.${encode(projectId)}&dataset_type=eq.${encode(datasetType)}&source_active=eq.true&select=source_key,source_sheet,source_row,payload&order=source_row.asc&limit=100`); if (!rows.length) { $('#sourcePreview').innerHTML = '<div class="source-preview-empty">Nenhum registro ativo neste conjunto.</div>'; return; } const columns = likelyColumns(rows); $('#sourcePreview').innerHTML = `<div class="table-scroll"><table><thead><tr><th>Chave</th>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.source_key)}</strong></td>${columns.map(column => `<td title="${escapeHtml(row.payload?.[column] ?? '')}">${escapeHtml(String(row.payload?.[column] ?? '—').slice(0, 80))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><small class="source-preview-note">Prévia dos primeiros ${fmt(rows.length)} registros. Todos os campos permanecem armazenados no Supabase.</small>`; } catch (error) { $('#sourcePreview').innerHTML = `<div class="source-preview-empty error">${escapeHtml(error.message)}</div>`; } }
  async function loadRawMaterialsFallback() { if (!state.supabase.token || state.materials.length) return; try { const projectId = await getProjectId(), rows = []; for (let offset = 0; ; offset += 1000) { const page = await rest(`/rest/v1/source_records?project_id=eq.${encode(projectId)}&dataset_type=eq.p85_materials_raw&source_active=eq.true&select=payload&limit=1000&offset=${offset}`); rows.push(...page.map(item => item.payload)); if (page.length < 1000) break; } if (rows.length) { state.materials = rows; await persist(); renderAll(); } } catch (error) { console.warn('Falha ao carregar materiais de origem:', error); } }

  function installImportV2() {
    if (installed) return; installed = true; installSourceView(); const originalOpenImport = openImport;
    openImport = function openImportV2() { originalOpenImport(); resetImportUi(); };
    $('#validateImport').onclick = validateImportV2; $('#applyImport').onclick = applyImportV2; $('#cancelImport').onclick = cancelImportV2; $('#closeImport').onclick = cancelImportV2;
    const baseShowView = showView; showView = function showViewV2(view) { baseShowView(view); if (view === 'source-data') { $('#pageTitle').textContent = 'Dados P83 e faturamento'; loadSourceSummaries(); } };
    if (state.supabase.token) { loadSourceSummaries(); loadRawMaterialsFallback(); }
    let previousToken = state.supabase.token; window.setInterval(() => { if (!previousToken && state.supabase.token) { loadSourceSummaries(); loadRawMaterialsFallback(); } previousToken = state.supabase.token; }, 2000);
  }
  window.addEventListener('load', () => setTimeout(installImportV2, 1200));
  window.BrasfelsImportV2 = { validate: validateImportV2, apply: applyImportV2, refresh: loadSourceSummaries };
})();

