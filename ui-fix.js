'use strict';

window.addEventListener('load', () => {
  const resetImportButtons = () => {
    const validate = document.querySelector('#validateImport');
    const apply = document.querySelector('#applyImport');
    const progress = document.querySelector('#modalProgress');
    if (validate) {
      validate.textContent = 'Validar arquivos';
      validate.disabled = !(window.state?.files?.length);
    }
    if (apply) {
      apply.hidden = true;
      apply.disabled = true;
    }
    if (progress) {
      progress.hidden = true;
      progress.classList.remove('error');
    }
  };

  setTimeout(() => {
    document.querySelectorAll('#openImport, .import-shortcut').forEach(button => {
      button.addEventListener('click', () => setTimeout(resetImportButtons, 0));
    });
  }, 500);
});
