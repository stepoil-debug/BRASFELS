'use strict';

(function installScopeImportBridge() {
  const scopePattern = /(?:tabela.*spools.*valor|spools.*valores|tabela.*escopo)/i;
  let installed = false;

  function isScopeFile(file) {
    const name = String(file?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return scopePattern.test(name);
  }

  function compatibleFile(file) {
    if (!isScopeFile(file)) return file;
    return new File(
      [file],
      `faturamento tabela spools valores - ${file.name}`,
      { type: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: file.lastModified },
    );
  }

  function install() {
    if (installed) return;
    const button = document.querySelector('#validateImport');
    if (!button || typeof button.onclick !== 'function') {
      window.setTimeout(install, 300);
      return;
    }

    const baseValidate = button.onclick;
    installed = true;
    button.onclick = async event => {
      const originalFiles = state.files;
      const hasScope = originalFiles.some(isScopeFile);
      if (!hasScope) return baseValidate.call(button, event);

      state.files = originalFiles.map(compatibleFile);
      try {
        await baseValidate.call(button, event);
      } finally {
        state.files = originalFiles;
      }
    };

    const hint = document.querySelector('#importModal .dropzone small');
    if (hint) hint.textContent = 'Spool Map, Spool Materials, Gráficos, Faturamento ou Tabela de Spools e Valores';
  }

  window.addEventListener('load', () => window.setTimeout(install, 1500));
})();
