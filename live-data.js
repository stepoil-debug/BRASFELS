'use strict';

(function () {
  const ZERO = {
    spools: 0,
    weight: 0,
    materials: 0,
    materialCodes: 0,
    hold: 0,
    scheduled: 0,
    divergences: 0,
    modules: {},
    statuses: {},
  };

  const yieldFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  currentSummary = function currentSummaryReal() {
    if (!state.spools.length) return { ...ZERO };
    recalculate();
    const modules = {};
    const statuses = {};
    state.spools.forEach(spool => {
      const module = spool.module || 'SEM MÓDULO';
      const status = spool.manufacture_status || 'Sem status';
      modules[module] = (modules[module] || 0) + 1;
      statuses[status] = (statuses[status] || 0) + 1;
    });
    return {
      spools: state.spools.length,
      weight: state.spools.reduce((total, item) => total + Number(item.weight_kg || 0), 0),
      materials: state.materials.length,
      materialCodes: new Set(state.materials.map(item => item.material_code).filter(Boolean)).size,
      hold: state.spools.filter(item => item.on_hold).length,
      scheduled: state.spools.filter(item => item.manufacture_schedule_number || item.manufacture_schedule_date).length,
      divergences: state.spools.filter(item => Number(item.weight_difference_pct || 0) > 1).length,
      modules,
      statuses,
    };
  };

  renderImports = function renderImportsReal() {
    if (!state.imports.length) {
      $('#importTableBody').innerHTML = '<tr><td colspan="8" class="empty-table-cell"><strong>Nenhuma atualização aplicada.</strong><span>Importe os arquivos operacionais para iniciar o histórico compartilhado.</span></td></tr>';
      return;
    }
    $('#importTableBody').innerHTML = state.imports.slice().reverse().map(item => `
      <tr>
        <td>${fmtDate(item.date)}</td>
        <td><strong>${escapeHtml(item.file)}</strong></td>
        <td>${escapeHtml(item.type)}</td>
        <td>${badge(item.status === 'completed' ? 'Concluído' : item.status === 'reference_only' ? 'Referência' : 'Validado')}</td>
        <td>${fmt(item.rows)}</td>
        <td>${fmt(item.inserted)}</td>
        <td>${fmt(item.updated)}</td>
        <td>${fmt(item.warnings)}</td>
      </tr>`).join('');
  };

  function normalizeFullSpool(value) {
    return upper(value).replace(/\s+/g, '').replace(/^CANC-/, '');
  }

  function setProgress(title, detail, failed = false) {
    $('#modalProgress').hidden = false;
    $('#modalProgress').classList.toggle('error', failed);
    $('#progressTitle').textContent = title;
    $('#progressDetail').textContent = detail || '';
  }

  function identifyFile(file) {
    const name = normHeader(file.name);
    if (name.includes('spool materials')) return 'spool_materials';
    if (name.includes('spool map')) return 'spool_map';
    if (name.includes('grafico') || name.includes('graficos')) return 'legacy_reference';
    if (name.includes('faturamento')) return 'billing_reference';
    return 'unknown';
  }

  async function parseCombinedMaterials(workbook, allowedKeys) {
    const sheetName = workbook.SheetNames.find(name => normHeader(name).includes('list')) || workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    });
    const headerRow = findHeader(rows, [['material code', 'codigo material'], ['spool']]);
    if (headerRow < 0) throw new Error('Cabeçalho da base de materiais não encontrado.');

    const map = headerMap(rows[headerRow]);
    const idx = {
      module: col(map, [/^module$/]),
      manufacturer: col(map, [/manufacturer site/, /fabricante/]),
      assembly: col(map, [/assembly site/, /montagem/]),
      spool: col(map, [/^spool$/]),
      spoolRevision: col(map, [/^revision$/]),
      code: col(map, [/material code/, /codigo material/, /^code$/]),
      description: col(map, [/description/, /descricao/]),
      diameter1: col(map, [/diameter 1/, /diametro 1/]),
      diameter2: col(map, [/diameter 2/, /diametro 2/]),
      materialRevision: col(map, [/material revision/, /revisao material/]),
      initials: col(map, [/initials/, /iniciais/]),
      application: col(map, [/application/, /aplicacao/]),
      quantity: col(map, [/quantity/, /quantidade/, /^qty$/]),
      weight: col(map, [/^weight$/, /weight kg/, /peso/]),
      notes: col(map, [/notes/, /observacao/]),
    };
    if (idx.spool < 0 || idx.code < 0) throw new Error('As colunas Spool e Material Code são obrigatórias.');

    const occurrences = new Map();
    const records = [];
    let ignoredRows = 0;

    for (let rowIndex = headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const spoolKey = normalizeFullSpool(cell(row, idx.spool));
      const code = clean(cell(row, idx.code));
      if (!spoolKey || !code) continue;
      if (!allowedKeys.has(spoolKey)) {
        ignoredRows += 1;
        continue;
      }

      const application = clean(cell(row, idx.application));
      const base = `${spoolKey}|${upper(code)}|${upper(application)}`;
      const occurrence = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, occurrence);

      const record = {
        source_key: `${base}|${occurrence}`,
        spool_source_key: spoolKey,
        module: upper(cell(row, idx.module)),
        manufacturer_site: clean(cell(row, idx.manufacturer)),
        assembly_site: clean(cell(row, idx.assembly)),
        spool_revision: clean(cell(row, idx.spoolRevision)),
        material_code: code,
        description: clean(cell(row, idx.description)),
        diameter_1: clean(cell(row, idx.diameter1)),
        diameter_2: clean(cell(row, idx.diameter2)),
        material_revision: clean(cell(row, idx.materialRevision)),
        initials: clean(cell(row, idx.initials)),
        application,
        quantity: number(cell(row, idx.quantity)),
        weight_kg: number(cell(row, idx.weight)),
        notes: clean(cell(row, idx.notes)),
        source_row: rowIndex + 1,
      };
      record.source_row_hash = stableHash(record);
      records.push(record);

      if (rowIndex % 5000 === 0) {
        setProgress('Filtrando materiais', `${fmt(rowIndex)} de ${fmt(rows.length)} linhas · ${fmt(records.length)} vinculadas ao P85`);
        await yieldFrame();
      }
    }
    return { sheetName, records, duplicates: 0, ignoredRows };
  }

  async function analyzeOperational(file, type, allowedKeys) {
    setProgress('Abrindo planilha', file.name);
    await yieldFrame();
    const [hash, buffer] = await Promise.all([fileHash(file), file.arrayBuffer()]);
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
      setProgress('Validando Spool Map', 'Lendo status, programação e etapas de produção...');
      await yieldFrame();
      const parsed = parseSpoolMap(workbook);
      return { file, hash, type, label: 'Spool Map P85', ...parsed, mode: 'operational' };
    }

    setProgress('Validando materiais', 'Relacionando a base ao Isométrico + Spool...');
    await yieldFrame();
    const parsed = await parseCombinedMaterials(workbook, allowedKeys);
    return { file, hash, type, label: 'Spool Materials P85', ...parsed, mode: 'operational' };
  }

  async function validateFilesReal() {
    if (!state.files.length) return;
    if (!window.XLSX) {
      toast('A biblioteca Excel ainda não carregou. Atualize a página.', 'error');
      return;
    }

    const validate = $('#validateImport');
    const apply = $('#applyImport');
    const cancel = $('#cancelImport');
    validate.disabled = true;
    validate.textContent = 'Validando...';
    validate.hidden = false;
    apply.hidden = true;
    apply.disabled = true;
    cancel.disabled = true;
    $('#validationSummary').hidden = true;

    const order = { spool_map: 0, spool_materials: 1, legacy_reference: 2, billing_reference: 3, unknown: 4 };
    const selected = state.files.map(file => ({ file, type: identifyFile(file) })).sort((a, b) => order[a.type] - order[b.type]);
    const analyses = [];
    const errors = [];
    const allowedKeys = new Set(state.spools.map(item => item.source_key));

    try {
      for (let index = 0; index < selected.length; index += 1) {
        const { file, type } = selected[index];
        setProgress(`Arquivo ${index + 1} de ${selected.length}`, file.name);
        await yieldFrame();

        try {
          let analysis;
          if (type === 'legacy_reference' || type === 'billing_reference') {
            analysis = {
              file,
              hash: `reference-${stableHash(`${file.name}:${file.size}:${file.lastModified}`)}`,
              type,
              label: type === 'legacy_reference' ? 'Gráficos Brasfels P83' : 'Faturamento P83',
              records: [],
              sheetName: null,
              mode: 'reference',
              optimizedReference: true,
            };
            setProgress('Referência identificada', `${file.name} será registrada sem leitura completa.`);
            await yieldFrame();
          } else if (type === 'spool_map' || type === 'spool_materials') {
            analysis = await analyzeOperational(file, type, allowedKeys);
            if (type === 'spool_map') analysis.records.forEach(item => allowedKeys.add(item.source_key));
          } else {
            throw new Error('Modelo não reconhecido.');
          }
          analysis.duplicateFile = state.imports.some(item => item.hash === analysis.hash && item.status === 'completed');
          analyses.push(analysis);
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
        }
      }

      state.pending = { analyses, errors };
      const operational = analyses.filter(item => item.mode === 'operational');
      const totalRows = operational.reduce((total, item) => total + item.records.length, 0);
      const spoolCount = analyses.find(item => item.type === 'spool_map')?.records.length || 0;
      const materialCount = analyses.find(item => item.type === 'spool_materials')?.records.length || 0;

      $('#validationSummary').hidden = false;
      $('#validationSummary').innerHTML = `
        <div class="validation-grid">
          <div><span>Spools identificados</span><strong>${fmt(spoolCount)}</strong></div>
          <div><span>Materiais vinculados</span><strong>${fmt(materialCount)}</strong></div>
          <div><span>Linhas operacionais</span><strong>${fmt(totalRows)}</strong></div>
          <div><span>Erros</span><strong>${fmt(errors.length)}</strong></div>
        </div>
        ${errors.length ? `<p class="warn">${errors.map(escapeHtml).join('<br>')}</p>` : ''}
        <div class="selected-files">${analyses.map(item => `
          <div class="file-row"><span>✓</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.file.name)} · ${fmt(item.records.length)} linhas${item.optimizedReference ? ' · referência sem leitura completa' : ''}</small></div>${item.duplicateFile ? '<span class="tag amber">Já aplicado</span>' : '<span class="tag green">Pronto</span>'}</div>`).join('')}</div>`;

      $('#modalProgress').hidden = true;
      validate.hidden = true;
      apply.hidden = false;
      apply.disabled = !operational.some(item => !item.duplicateFile) || errors.some(error => /Spool Map|Spool Materials/.test(error));
    } catch (error) {
      setProgress('Falha na validação', error.message || 'Não foi possível concluir.', true);
      validate.textContent = 'Tentar novamente';
      validate.disabled = false;
      apply.hidden = true;
      toast(error.message || 'Falha na validação.', 'error');
    } finally {
      cancel.disabled = false;
      if (!validate.hidden && validate.textContent === 'Validando...') {
        validate.textContent = 'Validar arquivos';
        validate.disabled = false;
      }
    }
  }

  function ensureAuthGate() {
    if ($('#brasfelsAuthGate')) return;
    const gate = document.createElement('div');
    gate.id = 'brasfelsAuthGate';
    gate.className = 'auth-gate';
    gate.innerHTML = `
      <div class="auth-card">
        <div class="auth-brand"><div class="brand-mark">B</div><div><strong>BRASFELS</strong><span>Base operacional compartilhada</span></div></div>
        <p class="eyebrow">ACESSO PROTEGIDO</p>
        <h2>Entrar no painel</h2>
        <p>Os dados industriais ficam protegidos no Supabase. Entre para carregar e atualizar a base compartilhada.</p>
        <label>E-mail<input id="gateEmail" type="email" value="douglas.tabella@step-og.com" autocomplete="username"></label>
        <label>Senha<input id="gatePassword" type="password" autocomplete="current-password" placeholder="Sua senha do painel"></label>
        <button class="button primary" id="gateLogin">Entrar e carregar dados</button>
        <div class="auth-message" id="gateMessage"></div>
      </div>`;
    document.body.appendChild(gate);

    $('#gateLogin').onclick = async () => {
      const button = $('#gateLogin');
      button.disabled = true;
      button.textContent = 'Entrando...';
      $('#supabaseEmail').value = clean($('#gateEmail').value);
      $('#supabasePassword').value = $('#gatePassword').value;
      await loginSupabase();
      if (state.supabase.token) {
        gate.classList.add('hidden');
        $('#gateMessage').textContent = 'Conectado. Carregando a base...';
        if (window.loadBrasfelsRemoteData) await window.loadBrasfelsRemoteData({ silent: false });
      } else {
        $('#gateMessage').textContent = 'Não foi possível entrar. Confira e-mail e senha.';
      }
      button.disabled = false;
      button.textContent = 'Entrar e carregar dados';
    };
  }

  function requireLoginForImport() {
    if (state.supabase.token) {
      openImport();
      return;
    }
    ensureAuthGate();
    $('#brasfelsAuthGate').classList.remove('hidden');
    $('#gateMessage').textContent = 'Entre antes de importar para que a atualização seja gravada no Supabase.';
  }

  async function applyAndSync() {
    if (!state.supabase.token) {
      toast('Entre no painel antes de aplicar a atualização.', 'error');
      requireLoginForImport();
      return;
    }
    const button = $('#applyImport');
    button.disabled = true;
    button.textContent = 'Aplicando localmente...';
    await applyImport();
    button.textContent = 'Gravando no Supabase...';
    await syncSupabase();
    if (window.loadBrasfelsRemoteData) await window.loadBrasfelsRemoteData({ silent: true });
    renderAll();
    if (window.renderBrasfelsProduction) window.renderBrasfelsProduction();
    toast('Atualização aplicada e compartilhada no Supabase.');
    button.textContent = 'Aplicar atualização';
  }

  function install() {
    ensureAuthGate();
    if (state.supabase.token) {
      $('#brasfelsAuthGate').classList.add('hidden');
      if (window.loadBrasfelsRemoteData) window.loadBrasfelsRemoteData({ silent: true });
    }

    $('#openImport').onclick = requireLoginForImport;
    $$('.import-shortcut').forEach(button => { button.onclick = requireLoginForImport; });
    $('#validateImport').onclick = validateFilesReal;
    $('#applyImport').onclick = applyAndSync;

    const originalOpen = openImport;
    openImport = function openImportReset() {
      originalOpen();
      $('#validateImport').textContent = 'Validar arquivos';
      $('#validateImport').disabled = true;
      $('#applyImport').textContent = 'Aplicar atualização';
      $('#modalProgress').classList.remove('error');
    };

    renderAll();
  }

  window.addEventListener('load', () => setTimeout(install, 700));
})();
