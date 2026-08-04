'use strict';

(function installBrasfelsIntranetAccessMode() {
  let scheduled = false;

  function applyAccessMode() {
    scheduled = false;

    const accessView = document.querySelector('#view-access-management');
    if (accessView) {
      const intro = accessView.querySelector('.section-intro p:not(.eyebrow)');
      if (intro) {
        intro.textContent = 'Selecione o perfil do colaborador. O acesso usa automaticamente o mesmo login e a mesma senha da Intranet STEP One.';
      }

      const formCard = accessView.querySelector('.access-form-card');
      if (formCard) {
        const description = formCard.querySelector('h3 + p');
        if (description) {
          description.textContent = 'Informe o colaborador e o perfil. Não é necessário criar senha, enviar convite ou confirmar e-mail.';
        }

        const passwordInput = formCard.querySelector('#accessPassword');
        const passwordLabel = passwordInput?.closest('label');
        if (passwordLabel) passwordLabel.hidden = true;
        if (passwordInput) passwordInput.value = '';

        const createButton = formCard.querySelector('#accessCreateButton');
        if (createButton && !createButton.disabled) createButton.textContent = 'Liberar acesso pela Intranet';
      }

      const usersCard = accessView.querySelector('.access-users-card');
      if (usersCard) {
        const eyebrow = usersCard.querySelector('.eyebrow');
        const title = usersCard.querySelector('h3');
        const description = usersCard.querySelector('h3 + p');
        if (eyebrow) eyebrow.textContent = 'USUÁRIOS DA INTRANET STEP ONE';
        if (title) title.textContent = 'Colaboradores e acessos';
        if (description) description.textContent = 'Escolha Visualização, Operador ou Administrador. A autorização é imediata e não envia e-mail do Supabase.';
      }

      accessView.querySelectorAll('[data-password-user]').forEach(button => {
        button.hidden = true;
        button.setAttribute('aria-hidden', 'true');
      });

      const feedback = accessView.querySelector('#accessFeedback');
      if (feedback && /usuário criado e acesso liberado|acesso associado/i.test(feedback.textContent || '')) {
        feedback.textContent = 'Acesso liberado. O colaborador já pode entrar com o mesmo login e senha da Intranet STEP One.';
      }
    }

    const loginCard = document.querySelector('.partner-login-card');
    if (loginCard) {
      const note = loginCard.querySelector('.partner-access-note span');
      if (note) {
        note.innerHTML = '<b>Acesso integrado</b>Após o administrador liberar o perfil, entre com o mesmo login e senha da Intranet STEP One. Não é necessário confirmar e-mail do Supabase.';
      }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(applyAccessMode);
  }

  window.addEventListener('load', () => {
    schedule();
    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => mutation.addedNodes.length || mutation.removedNodes.length)) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
