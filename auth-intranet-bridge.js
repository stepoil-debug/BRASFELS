'use strict';

(function () {
  const INTRANET_URL = 'https://intranet-stepone.netlify.app';
  const OFFICIAL_STEP_LOGO = `${INTRANET_URL}/api/branding/step-one-logo.webp?v=20260803-brasfels`;
  const MIGRATION_ENDPOINT = `${CONFIG.supabaseUrl}/functions/v1/brasfels-partner-login`;
  let installed = false;

  const normalize = value => String(value || '').trim().toLowerCase();

  function translateAuthMessage(message) {
    const text = String(message || '').trim();
    const lower = text.toLowerCase();
    if (!text) return '';
    if (lower.includes('invalid login credentials')) return 'E-mail, login ou senha inválidos.';
    if (lower.includes('email not confirmed')) return 'O e-mail ainda não foi confirmado.';
    if (lower.includes('user not found')) return 'Usuário não encontrado.';
    if (lower.includes('rate limit') || lower.includes('too many')) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    if (lower.includes('failed to fetch') || lower.includes('network')) return 'Não foi possível conectar ao serviço de autenticação.';
    return text;
  }

  function showMessage(message, mode = 'error') {
    const box = document.querySelector('#partnerLoginError');
    if (!box) return;
    box.textContent = translateAuthMessage(message);
    box.classList.toggle('visible', Boolean(message));
    box.classList.toggle('info', mode === 'info');
  }

  function setButton(label, disabled) {
    const button = document.querySelector('#partnerSubmit');
    if (!button) return;
    button.disabled = disabled;
    const span = button.querySelector('span');
    if (span) span.textContent = label;
  }

  async function linkIntranetCredential(identifier, password) {
    const response = await fetch(MIGRATION_ENDPOINT, {
      method: 'POST',
      headers: {
        apikey: CONFIG.supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ identifier, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'Não foi possível validar o acesso na Intranet STEP One.');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function installOfficialBranding() {
    const logoComposition = document.querySelector('.partner-logo-composition');
    if (logoComposition) {
      const stepLogo = logoComposition.querySelector('img:first-child');
      if (stepLogo) {
        stepLogo.src = OFFICIAL_STEP_LOGO;
        stepLogo.alt = 'STEP One';
        stepLogo.referrerPolicy = 'no-referrer';
      }
    }

    const card = document.querySelector('.partner-login-card');
    if (card && !card.querySelector('.partner-card-logos')) {
      const logos = document.createElement('div');
      logos.className = 'partner-card-logos';
      logos.innerHTML = `
        <img src="${OFFICIAL_STEP_LOGO}" alt="STEP One" referrerpolicy="no-referrer">
        <span>×</span>
        <img src="assets/brasfels-logo.svg?v=6" alt="BrasFELS">`;
      card.insertBefore(logos, card.firstChild);
    }

    const intro = card?.querySelector(':scope > p');
    if (intro) intro.textContent = 'Use o mesmo login e a mesma senha da Intranet STEP One. No primeiro acesso, a credencial será vinculada automaticamente ao painel BRASFELS.';

    const identifier = document.querySelector('#partnerEmail');
    if (identifier) {
      identifier.type = 'text';
      identifier.placeholder = 'E-mail corporativo ou login da Intranet';
      identifier.autocomplete = 'username';
      const label = identifier.closest('label');
      if (label && label.firstChild) label.firstChild.textContent = 'E-mail ou login\n                ';
    }

    const accessNote = document.querySelector('.partner-access-note span');
    if (accessNote) accessNote.innerHTML = '<b>Acesso integrado</b>A senha não é copiada nem exibida. Ela é validada com segurança na Intranet STEP One e vinculada ao Supabase no primeiro acesso.';
  }

  function installErrorTranslator() {
    const box = document.querySelector('#partnerLoginError');
    if (!box || box.dataset.translatorInstalled === '1') return;
    box.dataset.translatorInstalled = '1';
    const observer = new MutationObserver(() => {
      const translated = translateAuthMessage(box.textContent);
      if (translated && translated !== box.textContent) box.textContent = translated;
    });
    observer.observe(box, { childList: true, characterData: true, subtree: true });
  }

  function installForgotPassword() {
    const forgot = document.querySelector('#partnerForgot');
    if (!forgot) return;
    forgot.onclick = () => {
      showMessage('A senha deste painel é a mesma da Intranet STEP One. Caso não lembre, solicite a redefinição ao administrador da Intranet.', 'info');
    };
  }

  function installLoginBridge() {
    const form = document.querySelector('#partnerLoginForm');
    if (!form || form.dataset.intranetBridge === '1') return false;
    const originalSubmit = form.onsubmit;
    if (typeof originalSubmit !== 'function') return false;

    form.dataset.intranetBridge = '1';
    form.onsubmit = async event => {
      event.preventDefault();
      const identifierInput = document.querySelector('#partnerEmail');
      const passwordInput = document.querySelector('#partnerPassword');
      const identifier = normalize(identifierInput?.value);
      const password = String(passwordInput?.value || '');

      if (!identifier || !password) {
        showMessage('Informe o e-mail ou login e a senha.');
        return;
      }

      showMessage('');
      setButton('Validando na Intranet STEP One...', true);

      try {
        const linked = await linkIntranetCredential(identifier, password);
        if (linked.email && identifierInput) identifierInput.value = linked.email;
        setButton('Entrando no painel...', true);
        originalSubmit.call(form, { preventDefault() {} });
      } catch (error) {
        const status = Number(error.status || 0);
        const canTryExistingSupabasePassword = identifier.includes('@') && (status === 401 || status === 503 || status === 0);
        if (canTryExistingSupabasePassword) {
          setButton('Verificando acesso existente...', true);
          originalSubmit.call(form, { preventDefault() {} });
          window.setTimeout(() => {
            const box = document.querySelector('#partnerLoginError');
            if (box?.textContent) box.textContent = translateAuthMessage(box.textContent);
          }, 500);
          return;
        }
        showMessage(error.message || 'Não foi possível entrar.');
        setButton('Entrar e carregar dados', false);
      }
    };
    return true;
  }

  function install() {
    installOfficialBranding();
    installForgotPassword();
    installErrorTranslator();
    if (installLoginBridge()) installed = true;
  }

  window.addEventListener('load', () => {
    const observer = new MutationObserver(() => install());
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(() => {
      install();
      if (installed && document.querySelector('.partner-card-logos')) window.clearInterval(timer);
    }, 250);
    window.setTimeout(() => window.clearInterval(timer), 15000);
  });
})();
