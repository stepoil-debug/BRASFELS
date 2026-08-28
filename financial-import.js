'use strict';

(function installBrasfelsFinancialImport() {
  const WORKER_URL = 'financial-import-worker.js?v=21';
  let installed = false;
  let activeWorker = null;

  const normalizeName = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function isFinancialWorkbook(file) {
    const name = normalizeName(file?.name);
    return name.includes('faturamento')
      && !name.includes('tabela spools valores')
      && !name.includes('tabela de spools e valores');
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
        else reject(new Error(message.error || 'Falha no processador financeiro.'));
      };
      worker.onerror = event => {
        worker.terminate();
        if (activeWorker === worker) activeWorker = null;
        reject(new Error(event.message || 'O processador financeiro falhou.'));
      };
      worker.postMessage({ id, file });
    });
  }

  function renderSummary(analyses, errors) {
    const summary = document.querySelector('#validationSummary');
    const apply = document.querySelector('#applyImport');
    const validate = document.querySelector('#validateImport');
    const progress = document.querySelector('#modalProgress');
    if (!summary || !apply || !validate) return;

    const finance = analyses.find(item => item.type === 'p83_billing' && item.label === 'Financeiro P83');
    const financialDatasets = finance?.datasets?.filter(item => item.type !== 'p83_financial_metadata') || [];
    const financialRows = financialDatasets.reduce((sum, item) => sum + Number(item.rows?.length || 0), 0);
    const totalRows = analyses.reduce((sum, item) => sum + Number(item.rowCount || item.records?.length || 0), 0);
    const validToApply = analyses.some(item => !item.duplicateFile && (Number(item.rowCount || 0) > 0 || item.records?.length || item.datasets?.length));

    summary.hidden = false;
    summary.innerHTML = `
      <div class="validation-grid import-v2-summary-grid">
        <div><span>Abas financeiras</span><strong>${typeof fmt === 'function' ? fmt(financialDatasets.length) : financialDatasets.length}</strong></div>
        <div><span>Linhas financeiras</span><strong>${typeof fmt === 'function' ? fmt(financialRows) : financialRows}</strong></div>
        <div><span>Total processado</span><strong>${typeof fmt === 'function' ? fmt(totalRows) : totalRows}</strong></div>
        <div><span>Erros</span><strong>${errors.length}</strong></div>
      </div>
      ${finance ? '<p class="processing-note"><strong>Módulo Financeiro:</strong> as 11 abas da planilha são versionadas individualmente no Supabase e ficam disponíveis no menu Financeiro.</p>' : ''}
      ${errors.length ? `<p class="warn"><strong>Arquivos com problema:</strong><br>${errors.map(error => typeof escapeHtml === 'function' ? escapeHtml(error) : error).join('<br>')}</p>` : ''}
      <div class="selected-files import-v2-results">
        ${analyses.map(item => {
          const rows = Number(item.rowCount || item.records?.length || 0);
          const datasets = item.datasets?.length || 0;
          const fileName = item.fileName || item.file?.name || '';
          return `<div class="file-row"><span>✓</span><div><strong>${typeof escapeHtml === 'function' ? escapeHtml(item.label || item.type) : item.label || item.type}</strong><small>${typeof escapeHtml === 'function' ? escapeHtml(fileName) : fileName} · ${datasets} conjunto(s) · ${typeof fmt === 'function' ? fmt(rows) : rows} linhas</small></div>${item.duplicateFile ? '<span class="tag amber">Já aplicado</span>' : '<span class="tag green">Pronto</span>'}</div>`;
        }).join('')}
      </div>`;

    if (progress) progress.hidden = true;
    validate.hidden = true;
    validate.disabled = false;
    validate.textContent = 'Validar arquivos';
    apply.hidden = false;
    apply.disabled = !validToApply;
  }

  async function validateFinancial(baseValidate, button, event) {
    const originalFiles = [...(state.files || [])];
    const financialFiles = originalFiles.filter(isFinancialWorkbook);
    if (!financialFiles.length) return baseValidate.call(button, event);

    const otherFiles = originalFiles.filter(file => !isFinancialWorkbook(file));
    const analyses = [];
    const errors = [];
    const cancel = document.querySelector('#cancelImport');
    button.disabled = true;
    button.textContent = 'Processando financeiro...';
    if (cancel) cancel.disabled = true;

    try {
      if (otherFiles.length) {
        state.files = otherFiles;
        await baseValidate.call(button, event);
        analyses.push(...(state.pending?.analyses || []));
        errors.push(...(state.pending?.errors || []));
      }

      state.files = originalFiles;
      for (let index = 0; index < financialFiles.length; index += 1) {
        const file = financialFiles[index];
        setProgress(`Financeiro ${index + 1}/${financialFiles.length}`, file.name);
        try {
          const result = await runWorker(file);
          result.file = file;
          result.mode = 'complementary';
          result.duplicateFile = (state.imports || []).some(history => history.hash === result.hash && history.status === 'completed');
          analyses.push(result);
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
        }
      }

      state.pending = { analyses, errors };
      renderSummary(analyses, errors);
    } catch (error) {
      setProgress('Falha na validação financeira', error.message || 'Não foi possível processar a planilha.', null, null, true);
      button.hidden = false;
      button.disabled = false;
      button.textContent = 'Tentar novamente';
      if (typeof toast === 'function') toast(error.message || 'Falha ao processar a planilha financeira.', 'error');
    } finally {
      state.files = originalFiles;
      if (cancel) cancel.disabled = false;
    }
  }

  function install() {
    if (installed) return;
    const button = document.querySelector('#validateImport');
    if (!button || typeof button.onclick !== 'function') {
      setTimeout(install, 250);
      return;
    }

    const baseValidate = button.onclick;
    installed = true;
    button.onclick = event => validateFinancial(baseValidate, button, event);

    const hint = document.querySelector('#importModal .dropzone small');
    if (hint && !/Faturamento P83/i.test(hint.textContent || '')) {
      hint.textContent = `${hint.textContent || 'Planilhas Excel'} · Faturamento P83`;
    }

    const cancel = document.querySelector('#cancelImport');
    if (cancel) {
      const originalCancel = cancel.onclick;
      cancel.onclick = event => {
        if (activeWorker) {
          activeWorker.terminate();
          activeWorker = null;
          setProgress('Processamento cancelado', 'A planilha financeira não foi aplicada.', null, null, true);
          if (typeof toast === 'function') toast('Processamento financeiro cancelado.', 'error');
          return;
        }
        if (typeof originalCancel === 'function') originalCancel.call(cancel, event);
      };
    }
  }

  window.addEventListener('load', () => setTimeout(install, 2100));
  window.BrasfelsFinancialImport = { isFinancialWorkbook };
})();
