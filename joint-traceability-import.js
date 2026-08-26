'use strict';

(function installJointTraceabilityImport() {
  const WORKER_URL = 'joint-traceability-worker.js?v=20';
  let installed = false;
  let activeWorker = null;

  const normalizeName = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function isJointTraceabilityFile(file) {
    const name = normalizeName(file?.name);
    return name.includes('joint traceability')
      || name.includes('joint map')
      || name.includes('mapa de juntas')
      || (name.includes('piping') && name.includes('joint'));
  }

  function setProgress(title, detail, current = null, total = null, error = false) {
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

  function runWorker(file) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const worker = new Worker(WORKER_URL);
      activeWorker = worker;
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.id !== id) return;
        if (message.kind === 'progress') {
          setProgress(message.stage, message.detail, message.current, message.total);
          return;
        }
        worker.terminate();
        if (activeWorker === worker) activeWorker = null;
        if (message.kind === 'result') resolve(message.result);
        else reject(new Error(message.error || 'Falha no processador do Mapa de Juntas.'));
      };
      worker.onerror = event => {
        worker.terminate();
        if (activeWorker === worker) activeWorker = null;
        reject(new Error(event.message || 'O processador do Mapa de Juntas falhou.'));
      };
      worker.postMessage({ id, file });
    });
  }

  function analysisRows(item) {
    return item.type === 'spool_map' || item.type === 'spool_materials'
      ? Number(item.records?.length || 0)
      : Number(item.rowCount || 0);
  }

  function renderSummary(analyses, errors) {
    const summary = document.querySelector('#validationSummary');
    const apply = document.querySelector('#applyImport');
    const validate = document.querySelector('#validateImport');
    const progress = document.querySelector('#modalProgress');
    if (!summary || !apply || !validate) return;

    const spoolCount = analyses.find(item => item.type === 'spool_map')?.records?.length || 0;
    const materialCount = analyses.find(item => item.type === 'spool_materials')?.records?.length || 0;
    const jointCount = analyses
      .filter(item => item.type === 'joints')
      .reduce((sum, item) => sum + Number(item.rowCount || 0), 0);
    const complementaryRows = analyses
      .filter(item => item.mode === 'complementary' && item.type !== 'joints')
      .reduce((sum, item) => sum + analysisRows(item), 0);
    const datasetCount = analyses.reduce((sum, item) => sum + Number(item.datasets?.length || 0), 0);
    const validToApply = analyses.some(item => !item.duplicateFile && (analysisRows(item) > 0 || item.datasets?.length));

    summary.hidden = false;
    summary.innerHTML = `
      <div class="validation-grid import-v2-summary-grid">
        <div><span>Spools P85</span><strong>${fmt(spoolCount)}</strong></div>
        <div><span>Materiais P85</span><strong>${fmt(materialCount)}</strong></div>
        <div><span>Apontamentos de juntas</span><strong>${fmt(jointCount)}</strong></div>
        <div><span>Outras linhas</span><strong>${fmt(complementaryRows)}</strong></div>
      </div>
      <p class="processing-note"><strong>${fmt(datasetCount)} conjunto(s) identificado(s).</strong> O Mapa de Juntas é armazenado como base P85 versionada e passa a alimentar os gráficos diretamente.</p>
      ${errors.length ? `<p class="warn"><strong>Arquivos com problema:</strong><br>${errors.map(escapeHtml).join('<br>')}</p>` : ''}
      <div class="selected-files import-v2-results">
        ${analyses.map(item => {
          const rows = analysisRows(item);
          const detail = item.datasets?.length ? `${item.datasets.length} conjunto(s) · ${fmt(rows)} linhas` : `${fmt(rows)} linhas`;
          const extra = item.type === 'joints' && item.summary
            ? ` · ${fmt(item.summary.total_spools || 0)} spools · PIPE ${fmt(item.summary.placements?.PIPE || 0)} · CAMPO ${fmt(item.summary.placements?.CAMPO || 0)}`
            : '';
          return `<div class="file-row"><span>✓</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.fileName || item.file?.name || '')} · ${detail}${extra}</small></div>${item.duplicateFile ? '<span class="tag amber">Já aplicado</span>' : '<span class="tag green">Pronto</span>'}</div>`;
        }).join('')}
      </div>`;

    if (progress) progress.hidden = true;
    validate.hidden = true;
    validate.disabled = false;
    validate.textContent = 'Validar arquivos';
    apply.hidden = false;
    apply.disabled = !validToApply;
  }

  async function validateWithJointMap(baseValidate, button, event) {
    const originalFiles = [...(state.files || [])];
    const jointFiles = originalFiles.filter(isJointTraceabilityFile);
    if (!jointFiles.length) return baseValidate.call(button, event);

    const otherFiles = originalFiles.filter(file => !isJointTraceabilityFile(file));
    const analyses = [];
    const errors = [];
    const cancel = document.querySelector('#cancelImport');
    button.disabled = true;
    button.textContent = 'Processando apontamentos...';
    if (cancel) cancel.disabled = true;

    try {
      if (otherFiles.length) {
        state.files = otherFiles;
        await baseValidate.call(button, event);
        analyses.push(...(state.pending?.analyses || []));
        errors.push(...(state.pending?.errors || []));
      }

      state.files = originalFiles;
      for (let index = 0; index < jointFiles.length; index += 1) {
        const file = jointFiles[index];
        setProgress(`Mapa de Juntas ${index + 1}/${jointFiles.length}`, file.name);
        try {
          const result = await runWorker(file);
          result.file = file;
          result.mode = 'complementary';
          result.rowCount = Number(result.rowCount || result.datasets?.reduce((sum, dataset) => sum + dataset.rows.length, 0) || 0);
          result.duplicateFile = state.imports.some(history => history.hash === result.hash && history.status === 'completed');
          analyses.push(result);
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
        }
      }

      state.pending = { analyses, errors };
      renderSummary(analyses, errors);
    } catch (error) {
      setProgress('Falha na validação', error.message || 'Não foi possível processar os apontamentos.', null, null, true);
      button.hidden = false;
      button.disabled = false;
      button.textContent = 'Tentar novamente';
      toast(error.message || 'Falha ao processar o Mapa de Juntas.', 'error');
    } finally {
      state.files = originalFiles;
      if (cancel) cancel.disabled = false;
    }
  }

  function install() {
    if (installed) return;
    const button = document.querySelector('#validateImport');
    if (!button || typeof button.onclick !== 'function' || !window.BrasfelsImportV2) {
      setTimeout(install, 250);
      return;
    }

    const baseValidate = button.onclick;
    installed = true;
    button.onclick = event => validateWithJointMap(baseValidate, button, event);

    const hint = document.querySelector('#importModal .dropzone small');
    if (hint) hint.textContent = 'Spool Map, Spool Materials, Joint Traceability / Mapa de Juntas, Gráficos, Faturamento ou Tabela de Spools e Valores';

    const cancel = document.querySelector('#cancelImport');
    if (cancel) {
      const originalCancel = cancel.onclick;
      cancel.onclick = event => {
        if (activeWorker) {
          activeWorker.terminate();
          activeWorker = null;
          setProgress('Processamento cancelado', 'O arquivo de apontamentos não foi aplicado.', null, null, true);
          toast('Processamento do Mapa de Juntas cancelado.', 'error');
          return;
        }
        if (typeof originalCancel === 'function') originalCancel.call(cancel, event);
      };
    }
  }

  window.addEventListener('load', () => setTimeout(install, 1725));
  window.BrasfelsJointImport = { isJointTraceabilityFile };
})();
