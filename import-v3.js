'use strict';

(function installBrasfelsImportV3() {
  let installed = false;
  let running = false;
  let cancelled = false;
  let activeController = null;
  let projectIdCache = '';

  const encode = value => encodeURIComponent(String(value ?? ''));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  function progress(title, detail, current = null, total = null, error = false) {
    const box = document.querySelector('#modalProgress');
    if (!box) return;
    box.hidden = false;
    box.classList.toggle('error', error);
    const titleEl = document.querySelector('#progressTitle');
    const detailEl = document.querySelector('#progressDetail');
    if (titleEl) titleEl.textContent = title || 'Processando...';
    if (detailEl) detailEl.textContent = detail || '';
    let track = box.querySelector('.import-v2-progress-track');
    if (!track) {
      track = document.createElement('div');
      track.className = 'import-v2-progress-track';
      track.innerHTML = '<i></i>';
      box.appendChild(track);
    }
    const ratio = Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, current / total * 100))
      : null;
    track.classList.toggle('indeterminate', ratio === null);
    track.querySelector('i').style.width = ratio === null ? '35%' : `${ratio}%`;
  }

  function headers(write = false) {
    const result = {
      apikey: state.supabase.key,
      Authorization: `Bearer ${state.supabase.token}`,
      'Accept-Profile': 'brasfels',
      'Content-Profile': 'brasfels',
      'Content-Type': 'application/json',
    };
    if (write) result.Prefer = 'resolution=merge-duplicates,return=minimal';
    return result;
  }

  async function rest(path, options = {}) {
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs || 45000;
    const maxAttempts = options.attempts || 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (cancelled) throw new Error('Importação cancelada.');
      const controller = new AbortController();
      activeController = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${state.supabase.url}${path}`, {
          method,
          headers: headers(method !== 'GET'),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const message = payload.message || payload.msg || payload.error || `Erro ${response.status} no Supabase.`;
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }
        if (response.status === 204 || method !== 'GET') return [];
        return response.json();
      } catch (error) {
        clearTimeout(timer);
        if (cancelled) throw new Error('Importação cancelada.');
        lastError = error;
        const retryable = error.name === 'AbortError' || !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          if (error.name === 'AbortError') throw new Error(`O Supabase não respondeu em ${Math.round(timeoutMs / 1000)} segundos.`);
          throw error;
        }
        progress('Reconectando ao Supabase', `Tentativa ${attempt + 1} de ${maxAttempts}...`);
        await sleep(900 * attempt);
      } finally {
        if (activeController === controller) activeController = null;
      }
    }
    throw lastError || new Error('Falha de comunicação com o Supabase.');
  }

  async function getProjectId() {
    if (projectIdCache) return projectIdCache;
    const projects = await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`);
    if (!projects.length) throw new Error('Projeto FPSO-P85 não encontrado no schema brasfels.');
    projectIdCache = projects[0].id;
    return projectIdCache;
  }

  function chunksBySize(records, maxBytes = 850000, maxRows = 200) {
    const chunks = [];
    let chunk = [];
    let size = 2;
    for (const record of records) {
      const recordSize = JSON.stringify(record).length + 1;
      if (chunk.length && (chunk.length >= maxRows || size + recordSize > maxBytes)) {
        chunks.push(chunk);
        chunk = [];
        size = 2;
      }
      chunk.push(record);
      size += recordSize;
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
  }

  async function upsertChunks(path, rows, label, maxRows = 200) {
    const chunks = chunksBySize(rows, 850000, maxRows);
    let confirmed = 0;
    const startedAt = Date.now();
    for (let index = 0; index < chunks.length; index += 1) {
      if (cancelled) throw new Error('Importação cancelada.');
      const batch = chunks[index];
      progress(label, `Enviando lote ${index + 1}/${chunks.length} · ${fmt(confirmed)} de ${fmt(rows.length)} confirmados`, index, chunks.length);
      await rest(path, { method: 'POST', body: batch, timeoutMs: 45000, attempts: 3 });
      confirmed += batch.length;
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      progress(label, `${fmt(confirmed)} de ${fmt(rows.length)} confirmados · ${elapsed}s`, index + 1, chunks.length);
      await nextFrame();
    }
    return confirmed;
  }

  function spoolPayload(projectId, record) {
    const fields = ['source_key','contract','module','document','subsop','hts_sth','line','manufacturer','isometric','spool_number','spool_tag','priority','weight_kg','on_hold','spool_type','material','diameter_mm','diameter_inch','thickness_mm','specification','pipe_material','fluid','painting_condition','length_m','area_m2','total_joints','shop_joints','field_joints','manufacture_schedule_number','manufacture_schedule_date','cutting_date','fitting_date','fitup_date','welding_date','visual_inspection_date','dimensional_date','manufacture_release_date','packing_list','origin_location','sent_at','destination','received_at','received','assembly_schedule_number','assembly_schedule_date','manufacture_status','assembly_status','source_row_hash','source_data','manual_data'];
    const payload = { project_id: projectId, source_active: true, source_last_seen_at: new Date().toISOString() };
    for (const field of fields) if (record[field] !== undefined) payload[field] = record[field];
    return payload;
  }

  async function syncSpools(projectId, records) {
    if (!records.length) return { inserted: 0 };
    const rows = records.map(record => spoolPayload(projectId, record));
    await upsertChunks('/rest/v1/spools?on_conflict=project_id,source_key', rows, 'Gravando spools P85', 150);
    return { inserted: rows.length };
  }

  async function remoteSpoolIds(projectId) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await rest(`/rest/v1/spools?project_id=eq.${encode(projectId)}&source_active=eq.true&select=id,source_key&limit=1000&offset=${offset}`);
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return new Map(rows.map(record => [record.source_key, record.id]));
  }

  async function syncMaterials(projectId, records) {
    if (!records.length) return { linked: 0, unlinked: 0 };
    const ids = await remoteSpoolIds(projectId);
    const linked = [];
    let unlinked = 0;
    for (const record of records) {
      const spoolId = ids.get(record.spool_source_key);
      if (!spoolId) { unlinked += 1; continue; }
      linked.push({
        project_id: projectId,
        spool_id: spoolId,
        source_key: record.source_key,
        module: record.module,
        manufacturer_site: record.manufacturer_site,
        assembly_site: record.assembly_site,
        spool_revision: record.spool_revision,
        material_code: record.material_code,
        description: record.description,
        diameter_1: record.diameter_1,
        diameter_2: record.diameter_2,
        material_revision: record.material_revision,
        initials: record.initials,
        application: record.application,
        quantity: record.quantity,
        weight_kg: record.weight_kg,
        notes: record.notes,
        source_data: record.source_data || record,
        source_row_hash: record.source_row_hash,
        source_active: true,
        source_last_seen_at: new Date().toISOString(),
      });
    }
    if (linked.length) await upsertChunks('/rest/v1/spool_materials?on_conflict=project_id,source_key', linked, 'Gravando materiais P85', 150);
    return { linked: linked.length, unlinked };
  }

  async function completedHashes(projectId) {
    const rows = await rest(`/rest/v1/import_batches?project_id=eq.${encode(projectId)}&status=eq.completed&select=file_hash`);
    return new Set(rows.map(row => row.file_hash));
  }

  async function datasetSummary(projectId) {
    const rows = await rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(projectId)}&select=dataset_type,active_rows,source_file_name`);
    const map = new Map();
    for (const row of rows) {
      const current = map.get(row.dataset_type) || { rows: 0, files: new Set() };
      current.rows += Number(row.active_rows || 0);
      if (row.source_file_name) current.files.add(row.source_file_name);
      map.set(row.dataset_type, current);
    }
    return map;
  }

  function sourceRows(projectId, datasetType, analysis, records) {
    return records.map(record => ({
      project_id: projectId,
      dataset_type: datasetType,
      source_key: record.source_key,
      source_file_hash: analysis.hash,
      source_file_name: analysis.fileName,
      source_sheet: record.source_sheet || datasetType,
      source_row: record.source_row || null,
      source_row_hash: record.source_row_hash,
      payload: record.payload || record,
      source_active: true,
    }));
  }

  async function replaceDataset(projectId, dataset, analysis, summary) {
    const existing = summary.get(dataset.type);
    const expected = dataset.rows.length;
    if (existing && existing.rows === expected && existing.files.has(analysis.fileName)) {
      progress(`Conjunto já concluído`, `${dataset.type} · ${fmt(expected)} registros`);
      return { skipped: true, rows: expected };
    }
    progress(`Preparando ${dataset.type}`, 'Desativando a versão anterior...');
    await rest(`/rest/v1/source_records?project_id=eq.${encode(projectId)}&dataset_type=eq.${encode(dataset.type)}`, {
      method: 'PATCH',
      body: { source_active: false },
      timeoutMs: 45000,
      attempts: 3,
    });
    const rows = sourceRows(projectId, dataset.type, analysis, dataset.rows);
    if (rows.length) await upsertChunks(`/rest/v1/source_records?on_conflict=project_id,dataset_type,source_key`, rows, `Gravando ${dataset.type}`, 200);
    summary.set(dataset.type, { rows: expected, files: new Set([analysis.fileName]) });
    return { skipped: false, rows: expected };
  }

  async function saveRawMaterials(projectId, analysis, summary) {
    const dataset = {
      type: 'p85_materials_raw',
      rows: analysis.records.map(record => ({
        source_key: record.source_key,
        source_sheet: 'List',
        source_row: record.source_row,
        source_row_hash: record.source_row_hash,
        payload: record,
      })),
    };
    return replaceDataset(projectId, dataset, analysis, summary);
  }

  async function saveBatch(projectId, analysis, results) {
    const totalRows = analysis.type === 'spool_map' || analysis.type === 'spool_materials'
      ? analysis.records.length
      : analysis.rowCount;
    const batch = {
      project_id: projectId,
      source_type: analysis.type,
      file_name: analysis.fileName,
      file_hash: analysis.hash,
      sheet_name: analysis.datasets?.length ? analysis.datasets.map(dataset => dataset.sheet).join(', ').slice(0, 500) : null,
      status: 'completed',
      total_rows: totalRows,
      inserted_rows: Number(results.inserted || results.linked || totalRows || 0),
      updated_rows: Number(results.updated || 0),
      warning_rows: Number(results.unlinked || analysis.duplicates || 0),
      completed_at: new Date().toISOString(),
      error_message: null,
      validation_summary: {
        imported_by: 'excel-import-v3',
        resumed: true,
        datasets: analysis.datasets?.map(dataset => ({ type: dataset.type, sheet: dataset.sheet, rows: dataset.rows.length })) || [],
        results,
      },
    };
    await rest('/rest/v1/import_batches?on_conflict=project_id,file_hash', { method: 'POST', body: [batch] });
  }

  function mergeLocal(analysis) {
    if (analysis.type === 'spool_map') {
      const result = mergeByKey(state.spools, analysis.records);
      state.spools = result.records;
      return result;
    }
    if (analysis.type === 'spool_materials') {
      const result = mergeByKey(state.materials, analysis.records);
      state.materials = result.records;
      return result;
    }
    return { inserted: analysis.rowCount || 0, updated: 0, unchanged: 0 };
  }

  async function applyImportV3() {
    if (running) return;
    if (!state.pending?.analyses?.length) return;
    if (!state.supabase.token) { toast('Entre no painel antes de aplicar a atualização.', 'error'); return; }

    running = true;
    cancelled = false;
    const apply = document.querySelector('#applyImport');
    const cancel = document.querySelector('#cancelImport');
    const originalCancel = cancel?.onclick;
    if (apply) { apply.disabled = true; apply.textContent = 'Preparando...'; }
    if (cancel) {
      cancel.disabled = false;
      cancel.textContent = 'Cancelar processamento';
      cancel.onclick = () => {
        cancelled = true;
        activeController?.abort();
        progress('Cancelando importação', 'Aguardando o lote atual encerrar...');
      };
    }

    const applied = [];
    try {
      const projectId = await getProjectId();
      const completed = await completedHashes(projectId);
      const summary = await datasetSummary(projectId);
      for (const analysis of state.pending.analyses) {
        if (completed.has(analysis.hash)) analysis.duplicateFile = true;
      }
      const work = state.pending.analyses.filter(analysis => !analysis.duplicateFile);
      if (!work.length) {
        progress('Tudo já foi aplicado', 'Os quatro arquivos já estão concluídos no Supabase.', 1, 1);
        await sleep(900);
        document.querySelector('#importModal').hidden = true;
        toast('Nenhuma atualização pendente.');
        return;
      }

      for (let index = 0; index < work.length; index += 1) {
        if (cancelled) throw new Error('Importação cancelada.');
        const analysis = work[index];
        if (apply) apply.textContent = `Aplicando ${index + 1}/${work.length}`;
        progress(`Aplicando ${analysis.label}`, analysis.fileName, index, work.length);
        const localResult = mergeLocal(analysis);
        let remoteResult = { ...localResult };

        if (analysis.type === 'spool_map') {
          remoteResult = await syncSpools(projectId, analysis.records);
          if (state.materials.length) remoteResult.materials = await syncMaterials(projectId, state.materials);
        } else if (analysis.type === 'spool_materials') {
          await saveRawMaterials(projectId, analysis, summary);
          remoteResult = await syncMaterials(projectId, analysis.records);
        } else {
          let skipped = 0;
          let imported = 0;
          for (let datasetIndex = 0; datasetIndex < (analysis.datasets || []).length; datasetIndex += 1) {
            if (cancelled) throw new Error('Importação cancelada.');
            const dataset = analysis.datasets[datasetIndex];
            if (apply) apply.textContent = `Arquivo ${index + 1}/${work.length} · Base ${datasetIndex + 1}/${analysis.datasets.length}`;
            const result = await replaceDataset(projectId, dataset, analysis, summary);
            if (result.skipped) skipped += 1; else imported += result.rows;
          }
          remoteResult = { inserted: analysis.rowCount, datasets: analysis.datasets.length, skipped_datasets: skipped, imported_rows: imported };
        }

        await saveBatch(projectId, analysis, { ...localResult, ...remoteResult });
        completed.add(analysis.hash);
        if (!state.imports.some(item => item.hash === analysis.hash && item.status === 'completed')) {
          state.imports.push({
            date: new Date().toISOString(),
            file: analysis.fileName,
            hash: analysis.hash,
            type: analysis.label,
            status: 'completed',
            rows: analysis.type === 'spool_map' || analysis.type === 'spool_materials' ? analysis.records.length : analysis.rowCount,
            inserted: Number(remoteResult.inserted || remoteResult.linked || localResult.inserted || 0),
            updated: Number(localResult.updated || 0),
            warnings: Number(remoteResult.unlinked || analysis.duplicates || 0),
          });
        }
        applied.push(analysis);
      }

      progress('Finalizando atualização', 'Atualizando indicadores e conferindo os dados...', 1, 1);
      recalculate();
      await persist();
      renderAll();
      if (window.renderBrasfelsProduction) window.renderBrasfelsProduction();
      if (window.BrasfelsImportV2?.refresh) await window.BrasfelsImportV2.refresh();
      if (window.loadBrasfelsRemoteData && applied.some(item => item.type === 'spool_map' || item.type === 'spool_materials')) {
        await window.loadBrasfelsRemoteData({ silent: true });
      }
      const lastUpdate = document.querySelector('#lastUpdate');
      if (lastUpdate) lastUpdate.textContent = fmtDate(new Date().toISOString());
      await sleep(400);
      document.querySelector('#modalProgress').hidden = true;
      document.querySelector('#importModal').hidden = true;
      toast(`${applied.length} arquivo(s) concluídos com sucesso.`);
      showView(applied.some(item => item.mode === 'complementary') && !applied.some(item => item.mode === 'operational') ? 'source-data' : 'dashboard');
    } catch (error) {
      progress('Falha ao aplicar atualização', error.message || 'Erro desconhecido.', null, null, true);
      if (apply) { apply.disabled = false; apply.textContent = 'Retomar atualização'; }
      toast(error.message || 'Falha na importação.', 'error');
    } finally {
      running = false;
      activeController = null;
      if (cancel) {
        cancel.disabled = false;
        cancel.textContent = 'Cancelar';
        cancel.onclick = originalCancel;
      }
      if (apply && applied.length && !document.querySelector('#importModal').hidden) {
        apply.disabled = false;
        apply.textContent = 'Retomar atualização';
      }
    }
  }

  function install() {
    if (installed) return;
    if (!window.BrasfelsImportV2 || !document.querySelector('#applyImport')) {
      setTimeout(install, 300);
      return;
    }
    installed = true;
    document.querySelector('#applyImport').onclick = applyImportV3;
    window.BrasfelsImportV2.apply = applyImportV3;
  }

  window.addEventListener('load', () => setTimeout(install, 1900));
})();
