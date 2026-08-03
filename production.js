'use strict';

(function () {
  const PRODUCTION_STAGES = [
    { key: 'schedule', label: 'Programação', short: 'Programação' },
    { key: 'cutting', label: 'Corte', short: 'Corte' },
    { key: 'fitup', label: 'Acoplamento / Fit-up', short: 'Acoplamento' },
    { key: 'welding', label: 'Soldagem', short: 'Soldagem' },
    { key: 'visual', label: 'Inspeção visual', short: 'Visual' },
    { key: 'dimensional', label: 'Inspeção dimensional', short: 'Dimensional' },
    { key: 'release', label: 'Liberação de fabricação', short: 'Liberação' },
    { key: 'packing', label: 'Romaneio', short: 'Romaneio' },
    { key: 'shipping', label: 'Expedição', short: 'Expedição' },
    { key: 'receiving', label: 'Recebimento / Montagem', short: 'Recebimento' },
  ];

  const idleFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  function fileTypeFromName(file) {
    const name = normHeader(file.name);
    if (name.includes('spool materials')) return 'spool_materials';
    if (name.includes('spool map')) return 'spool_map';
    if (name.includes('grafico') || name.includes('graficos')) return 'legacy_reference';
    if (name.includes('faturamento')) return 'billing_reference';
    return 'unknown';
  }

  function setProgress(title, detail, error = false) {
    const progress = $('#modalProgress');
    progress.hidden = false;
    progress.classList.toggle('error', error);
    $('#progressTitle').textContent = title;
    $('#progressDetail').textContent = detail || '';
  }

  async function parseMaterialsForSpools(workbook, allowedSpoolKeys) {
    if (!allowedSpoolKeys.size) {
      throw new Error('Importe ou selecione o Spool Map antes da base de materiais.');
    }

    const sheetName = workbook.SheetNames.find(name => normHeader(name).includes('spool materials')) || workbook.SheetNames[0];
    if (!sheetName) throw new Error('A planilha de materiais não possui abas legíveis.');

    setProgress('Lendo materiais', `Abrindo a aba ${sheetName}...`);
    await idleFrame();

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    });

    const headerRow = findHeader(rows, [
      ['material code', 'codigo material'],
      ['spool'],
      ['isometric', 'isometrico'],
    ]);
    if (headerRow < 0) throw new Error('Cabeçalho da base de materiais não encontrado.');

    const map = headerMap(rows[headerRow]);
    const idx = {
      iso: col(map, [/^isometric$/, /^isometrico$/, /isometric number/]),
      spool: col(map, [/^spool$/, /spool number/, /numero spool/]),
      code: col(map, [/material code/, /codigo material/, /^code$/]),
      description: col(map, [/description/, /descricao/]),
      quantity: col(map, [/quantity/, /quantidade/, /^qty$/]),
      weight: col(map, [/weight kg/, /^weight$/, /peso/]),
      application: col(map, [/application/, /aplicacao/]),
      manufacturer: col(map, [/manufacturer site/, /fabricante/]),
      assembly: col(map, [/assembly site/, /montagem/]),
      revision: col(map, [/material revision/, /revisao/]),
      diameter1: col(map, [/diameter 1/, /diametro 1/]),
      diameter2: col(map, [/diameter 2/, /diametro 2/]),
      notes: col(map, [/notes/, /observacao/]),
      module: col(map, [/^module$/, /^modulo$/]),
    };

    if (idx.iso < 0 || idx.spool < 0 || idx.code < 0) {
      throw new Error('As colunas Isometric, Spool e Material Code são obrigatórias.');
    }

    const occurrences = new Map();
    const records = [];
    let ignored = 0;

    for (let rowIndex = headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const iso = cell(row, idx.iso);
      const spool = cell(row, idx.spool);
      const code = cell(row, idx.code);
      if (!clean(iso) || !clean(spool) || !clean(code)) continue;

      const spoolKey = sourceKey(iso, spool);
      if (!allowedSpoolKeys.has(spoolKey)) {
        ignored += 1;
        continue;
      }

      const base = `${spoolKey}|${upper(code)}|${upper(cell(row, idx.application))}`;
      const occurrence = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, occurrence);

      const record = {
        source_key: `${base}|${occurrence}`,
        spool_source_key: spoolKey,
        isometric: normalizeIso(iso),
        spool_number: padSpool(spool),
        module: upper(cell(row, idx.module)),
        material_code: clean(code),
        description: clean(cell(row, idx.description)),
        quantity: number(cell(row, idx.quantity)),
        weight_kg: number(cell(row, idx.weight)),
        application: clean(cell(row, idx.application)),
        manufacturer_site: clean(cell(row, idx.manufacturer)),
        assembly_site: clean(cell(row, idx.assembly)),
        material_revision: clean(cell(row, idx.revision)),
        diameter_1: clean(cell(row, idx.diameter1)),
        diameter_2: clean(cell(row, idx.diameter2)),
        notes: clean(cell(row, idx.notes)),
        source_row: rowIndex + 1,
      };
      record.source_row_hash = stableHash(record);
      records.push(record);

      if (rowIndex % 5000 === 0) {
        setProgress('Filtrando materiais', `${fmt(rowIndex)} de ${fmt(rows.length)} linhas · ${fmt(records.length)} vinculadas ao P85`);
        await idleFrame();
      }
    }

    return { sheetName, records, duplicates: 0, ignoredRows: ignored };
  }

  async function analyzeOperationalFile(file, type, allowedSpoolKeys) {
    setProgress('Preparando arquivo', file.name);
    await idleFrame();

    const hash = await fileHash(file);
    const buffer = await file.arrayBuffer();
    setProgress('Abrindo planilha', `${file.name} · ${fmt(file.size / 1024, 1)} KB`);
    await idleFrame();

    const workbook = XLSX.read(buffer, {
      type: 'array',
      cellDates: true,
      cellStyles: false,
      cellHTML: false,
      cellNF: false,
      bookVBA: false,
      bookFiles: false,
    });

    if (type === 'spool_map') {
      setProgress('Validando Spool Map', 'Conferindo chaves, status e etapas de fabricação...');
      await idleFrame();
      const parsed = parseSpoolMap(workbook);
      return { file, hash, type, label: 'Spool Map P85', ...parsed, mode: 'operational' };
    }

    const parsed = await parseMaterialsForSpools(workbook, allowedSpoolKeys);
    return { file, hash, type, label: 'Spool Materials P85', ...parsed, mode: 'operational' };
  }

  async function validateImportOptimized() {
    if (!window.XLSX) {
      toast('A biblioteca de leitura Excel ainda não carregou. Atualize a página e tente novamente.', 'error');
      return;
    }
    if (!state.files.length) return;

    const validateButton = $('#validateImport');
    const applyButton = $('#applyImport');
    const cancelButton = $('#cancelImport');

    validateButton.disabled = true;
    validateButton.hidden = false;
    validateButton.textContent = 'Validando...';
    applyButton.hidden = true;
    applyButton.disabled = true;
    cancelButton.disabled = true;
    $('#validationSummary').hidden = true;
    setProgress('Iniciando validação', 'Organizando os arquivos por tipo...');

    const order = { spool_map: 0, spool_materials: 1, legacy_reference: 2, billing_reference: 3, unknown: 4 };
    const files = state.files
      .map(file => ({ file, type: fileTypeFromName(file) }))
      .sort((a, b) => order[a.type] - order[b.type]);

    const analyses = [];
    const errors = [];
    const allowedSpoolKeys = new Set(state.spools.map(item => item.source_key));

    try {
      for (let index = 0; index < files.length; index += 1) {
        const { file, type } = files[index];
        setProgress(`Arquivo ${index + 1} de ${files.length}`, file.name);
        await idleFrame();

        try {
          let analysis;
          if (type === 'legacy_reference' || type === 'billing_reference') {
            const label = type === 'legacy_reference' ? 'Gráficos Brasfels P83' : 'Faturamento P83';
            analysis = {
              file,
              hash: `reference-${stableHash(`${file.name}:${file.size}:${file.lastModified}`)}`,
              type,
              label,
              records: [],
              sheetName: null,
              mode: 'reference',
              sheets: null,
              optimizedReference: true,
            };
            setProgress('Arquivo de referência identificado', `${file.name} não será varrido célula por célula.`);
            await idleFrame();
          } else if (type === 'spool_map' || type === 'spool_materials') {
            analysis = await analyzeOperationalFile(file, type, allowedSpoolKeys);
            if (type === 'spool_map') {
              analysis.records.forEach(item => allowedSpoolKeys.add(item.source_key));
            }
          } else {
            throw new Error('Modelo de arquivo não reconhecido.');
          }

          if (state.imports.some(item => item.hash === analysis.hash)) analysis.duplicateFile = true;
          analyses.push(analysis);
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
        }
      }

      state.pending = { analyses, errors };
      const totalRows = analyses.reduce((sum, item) => sum + item.records.length, 0);
      const operational = analyses.filter(item => item.mode === 'operational').length;
      const references = analyses.filter(item => item.mode === 'reference').length;
      const duplicates = analyses.filter(item => item.duplicateFile).length;
      const ignored = analyses.reduce((sum, item) => sum + (item.ignoredRows || 0), 0);

      $('#validationSummary').hidden = false;
      $('#validationSummary').innerHTML = `
        <div class="validation-grid">
          <div><span>Arquivos válidos</span><strong>${analyses.length}</strong></div>
          <div><span>Linhas P85</span><strong>${fmt(totalRows)}</strong></div>
          <div><span>Operacionais</span><strong>${operational}</strong></div>
          <div><span>Referências</span><strong>${references}</strong></div>
        </div>
        ${ignored ? `<p class="processing-note">${fmt(ignored)} linhas de materiais de outros spools foram ignoradas. Somente materiais vinculados ao P85 serão importados.</p>` : ''}
        ${duplicates ? `<p class="warn">${duplicates} arquivo(s) já processado(s) serão ignorados.</p>` : ''}
        ${errors.length ? `<p class="warn">${errors.map(escapeHtml).join('<br>')}</p>` : ''}
        <div class="selected-files">
          ${analyses.map(item => `
            <div class="file-row">
              <span>✓</span>
              <div>
                <strong>${escapeHtml(item.label)}</strong>
                <small>${escapeHtml(item.file.name)} · ${fmt(item.records.length)} linhas${item.optimizedReference ? ' · referência registrada sem leitura completa' : ''}</small>
              </div>
              ${item.duplicateFile ? '<span class="tag amber">Duplicado</span>' : '<span class="tag green">Pronto</span>'}
            </div>`).join('')}
        </div>`;

      $('#modalProgress').hidden = true;
      validateButton.hidden = true;
      applyButton.hidden = false;
      applyButton.disabled = !analyses.some(item => !item.duplicateFile);
    } catch (error) {
      setProgress('Falha na validação', error.message || 'Não foi possível concluir a leitura.', true);
      validateButton.hidden = false;
      validateButton.disabled = false;
      validateButton.textContent = 'Tentar novamente';
      applyButton.hidden = true;
      toast(error.message || 'Falha na validação.', 'error');
    } finally {
      cancelButton.disabled = false;
      if (!validateButton.hidden && validateButton.textContent === 'Validando...') {
        validateButton.textContent = 'Validar arquivos';
        validateButton.disabled = false;
      }
    }
  }

  function completedStageIndex(spool) {
    const completed = [
      Boolean(spool.manufacture_schedule_number || spool.manufacture_schedule_date),
      Boolean(spool.cutting_date),
      Boolean(spool.fitting_date || spool.fitup_date),
      Boolean(spool.welding_date),
      Boolean(spool.visual_inspection_date),
      Boolean(spool.dimensional_date),
      Boolean(spool.manufacture_release_date),
      Boolean(spool.packing_list),
      Boolean(spool.sent_at),
      Boolean(spool.received || spool.received_at || upper(spool.assembly_status).includes('COMPLET')),
    ];
    let highest = -1;
    completed.forEach((value, index) => { if (value) highest = index; });
    return highest;
  }

  function productionPosition(spool) {
    if (spool.on_hold || upper(spool.manufacture_status).includes('HOLD')) {
      return { index: -1, progress: 0, label: 'On Hold', hold: true, completed: false };
    }

    const status = upper(spool.manufacture_status);
    if (status.includes('WAITING COUPLING')) {
      return { index: 2, progress: 20, label: PRODUCTION_STAGES[2].label, hold: false, completed: false };
    }

    const highest = completedStageIndex(spool);
    if (highest >= PRODUCTION_STAGES.length - 1) {
      return { index: 9, progress: 100, label: 'Concluído / Recebido', hold: false, completed: true };
    }

    const current = Math.max(0, highest + 1);
    return {
      index: current,
      progress: Math.round((Math.max(0, highest) / (PRODUCTION_STAGES.length - 1)) * 100),
      label: PRODUCTION_STAGES[current].label,
      hold: false,
      completed: false,
    };
  }

  function injectProductionView() {
    if ($('#view-production')) return;

    const nav = $('.nav');
    const materialsButton = nav.querySelector('[data-view="materials"]');
    const navButton = document.createElement('button');
    navButton.className = 'nav-item';
    navButton.dataset.view = 'production';
    navButton.innerHTML = '<span>⇥</span> Fluxo de produção <b id="navProductionCount">0</b>';
    nav.insertBefore(navButton, materialsButton);

    const section = document.createElement('section');
    section.className = 'view production-view';
    section.id = 'view-production';
    section.innerHTML = `
      <div class="section-intro">
        <div>
          <p class="eyebrow">ACOMPANHAMENTO OPERACIONAL</p>
          <h2>Fluxo de produção</h2>
          <p>Cada spool é posicionado automaticamente pela última etapa concluída no Spool Map.</p>
        </div>
        <div class="production-legend">
          <span><i class="blue"></i> Etapa atual</span>
          <span><i class="green"></i> Concluído</span>
          <span><i class="amber"></i> Aguardando</span>
          <span><i class="red"></i> On Hold</span>
        </div>
      </div>
      <div class="production-summary" id="productionSummary"></div>
      <div class="production-flow-panel">
        <div class="production-flow-head">
          <div><p class="eyebrow">LINHA DE PRODUÇÃO</p><h3>Spools por etapa atual</h3><p>Os números representam onde cada spool está aguardando ou sendo executado.</p></div>
          <strong id="productionVisibleCount">0 spools</strong>
        </div>
        <div class="flow-track" id="productionFlowTrack"></div>
      </div>
      <div class="production-toolbar">
        <div class="search"><span>⌕</span><input id="productionSearch" placeholder="Pesquisar spool, isométrico, documento ou linha"></div>
        <select id="productionModule"><option value="">Todos os módulos</option></select>
        <select id="productionStage"><option value="">Todas as etapas</option></select>
        <label class="check-filter"><input type="checkbox" id="productionIncludeHold" checked> Mostrar hold</label>
      </div>
      <div class="panel table-panel production-table" id="productionTablePanel">
        <div class="table-meta"><strong id="productionResultCount">0 registros</strong><span>Exibindo até 300 registros; use os filtros para refinar.</span></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Spool</th><th>Módulo</th><th>Etapa atual</th><th>Avanço</th><th>Programação</th><th>Status</th><th>Hold</th></tr></thead>
            <tbody id="productionTableBody"></tbody>
          </table>
        </div>
      </div>
      <div class="production-empty" id="productionEmpty" hidden><strong>Nenhum spool carregado.</strong><p>Importe o Spool Map para montar o fluxo de produção.</p></div>`;

    $('#view-materials').parentNode.insertBefore(section, $('#view-materials'));

    navButton.addEventListener('click', () => {
      $$('.view').forEach(view => view.classList.remove('active'));
      section.classList.add('active');
      $$('.nav-item').forEach(item => item.classList.toggle('active', item === navButton));
      $('#pageTitle').textContent = 'Fluxo de produção';
      $('#sidebar').classList.remove('open');
      renderProduction();
    });

    ['productionSearch', 'productionModule', 'productionStage', 'productionIncludeHold'].forEach(id => {
      $(`#${id}`).addEventListener('input', renderProduction);
      $(`#${id}`).addEventListener('change', renderProduction);
    });
  }

  function filteredProductionRows() {
    const search = upper($('#productionSearch')?.value || '');
    const module = $('#productionModule')?.value || '';
    const stage = $('#productionStage')?.value || '';
    const includeHold = $('#productionIncludeHold')?.checked ?? true;

    return state.spools
      .map(spool => ({ spool, position: productionPosition(spool) }))
      .filter(({ spool, position }) => {
        if (!includeHold && position.hold) return false;
        if (module && spool.module !== module) return false;
        if (stage === 'hold' && !position.hold) return false;
        if (stage && stage !== 'hold' && String(position.index) !== stage) return false;
        if (search && !upper(`${spool.spool_tag} ${spool.source_key} ${spool.isometric} ${spool.document} ${spool.line}`).includes(search)) return false;
        return true;
      });
  }

  function renderProduction() {
    if (!$('#view-production')) return;

    const rows = state.spools.map(spool => ({ spool, position: productionPosition(spool) }));
    const active = rows.filter(item => !item.position.hold && !item.position.completed).length;
    const completed = rows.filter(item => item.position.completed).length;
    const hold = rows.filter(item => item.position.hold).length;
    const notStarted = rows.filter(item => !item.position.hold && item.position.index <= 1 && completedStageIndex(item.spool) <= 0).length;
    const released = rows.filter(item => completedStageIndex(item.spool) >= 6).length;

    $('#navProductionCount').textContent = fmt(state.spools.length);
    $('#productionSummary').innerHTML = `
      <article class="stage-card waiting"><span>Aguardando início</span><strong>${fmt(notStarted)}</strong><small>Programação ou corte</small></article>
      <article class="stage-card"><span>Em produção</span><strong>${fmt(active)}</strong><small>Entre corte e recebimento</small></article>
      <article class="stage-card done"><span>Liberados</span><strong>${fmt(released)}</strong><small>Liberação ou etapa posterior</small></article>
      <article class="stage-card done"><span>Concluídos</span><strong>${fmt(completed)}</strong><small>Recebidos ou montagem concluída</small></article>
      <article class="stage-card hold"><span>On Hold</span><strong>${fmt(hold)}</strong><small>Fora da demanda normal</small></article>`;

    const stageCounts = PRODUCTION_STAGES.map((_, index) => rows.filter(item => !item.position.hold && item.position.index === index).length);
    $('#productionFlowTrack').innerHTML = PRODUCTION_STAGES.map((stage, index) => `
      <div class="flow-stage">
        <b>${fmt(stageCounts[index])}</b>
        <span>${escapeHtml(stage.short)}</span>
        <small>${fmt(state.spools.length ? stageCounts[index] / state.spools.length * 100 : 0, 1)}%</small>
      </div>`).join('');

    const moduleSelect = $('#productionModule');
    const selectedModule = moduleSelect.value;
    moduleSelect.innerHTML = '<option value="">Todos os módulos</option>' + [...new Set(state.spools.map(item => item.module).filter(Boolean))]
      .sort()
      .map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    moduleSelect.value = selectedModule;

    const stageSelect = $('#productionStage');
    const selectedStage = stageSelect.value;
    stageSelect.innerHTML = '<option value="">Todas as etapas</option>' + PRODUCTION_STAGES
      .map((stage, index) => `<option value="${index}">${index + 1}. ${escapeHtml(stage.label)}</option>`).join('') + '<option value="hold">On Hold</option>';
    stageSelect.value = selectedStage;

    const filtered = filteredProductionRows();
    $('#productionVisibleCount').textContent = `${fmt(filtered.length)} spools`;
    $('#productionResultCount').textContent = `${fmt(filtered.length)} registros`;
    $('#productionEmpty').hidden = state.spools.length > 0;
    $('#productionTablePanel').hidden = state.spools.length === 0;

    $('#productionTableBody').innerHTML = filtered.slice(0, 300).map(({ spool, position }) => {
      const indexLabel = position.hold ? '!' : position.index + 1;
      const stageLabel = position.label;
      return `<tr data-key="${escapeHtml(spool.source_key)}">
        <td><strong>${escapeHtml(spool.spool_tag || spool.source_key)}</strong><small>${escapeHtml(spool.isometric || '')}</small></td>
        <td>${escapeHtml(spool.module || '—')}</td>
        <td><div class="stage-name"><span class="stage-index">${indexLabel}</span>${escapeHtml(stageLabel)}</div></td>
        <td class="progress-cell"><strong>${position.hold ? 'Pausado' : `${position.progress}%`}</strong><div class="mini-progress"><i style="width:${position.hold ? 0 : position.progress}%"></i></div></td>
        <td>${escapeHtml(spool.manufacture_schedule_number || spool.manufacture_schedule_date || '—')}</td>
        <td>${badge(spool.manufacture_status)}</td>
        <td>${position.hold ? '<span class="tag red">HOLD</span>' : '—'}</td>
      </tr>`;
    }).join('');

    $$('#productionTableBody tr').forEach(row => row.addEventListener('click', () => openDrawer(row.dataset.key)));
  }

  function install() {
    injectProductionView();

    const validateButton = $('#validateImport');
    if (validateButton) validateButton.onclick = validateImportOptimized;

    const applyButton = $('#applyImport');
    if (applyButton && applyButton.onclick) {
      const originalApply = applyButton.onclick;
      applyButton.onclick = async event => {
        await originalApply.call(applyButton, event);
        renderProduction();
      };
    }

    renderProduction();
  }

  window.renderBrasfelsProduction = renderProduction;
  window.addEventListener('load', () => setTimeout(install, 300));
})();
