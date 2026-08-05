'use strict';

(function () {
  const INTRANET_URL = 'https://intranet-stepone.netlify.app';
  const OFFICIAL_STEP_LOGO = 'assets/step-one-official-transparent.png?v=19';
  const MIGRATION_ENDPOINT = `${CONFIG.supabaseUrl}/functions/v1/brasfels-partner-login`;
  const BRANDING_FLAG = 'brasfelsOfficialBranding';
  let scheduled = false;

  const normalize = value => String(value || '').trim().toLowerCase();

  function translateAuthMessage(message) {
    const text = String(message || '').trim();
    const lower = text.toLowerCase();
    if (!text) return '';
    if (lower.includes('invalid login credentials')) return 'E-mail, login ou senha inválidos.';
    if (lower.includes('email not confirmed')) return 'O e-mail ainda não foi confirmado.';
    if (lower.includes('user not found')) return 'Usuário não encontrado.';
    if (lower.includes('not authorized') || lower.includes('sem acesso')) return 'Seu usuário ainda não foi liberado para o painel BRASFELS.';
    if (lower.includes('rate limit') || lower.includes('too many')) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    if (lower.includes('failed to fetch') || lower.includes('network')) return 'Não foi possível conectar ao serviço de autenticação.';
    return text;
  }

  function showMessage(message, mode = 'error') {
    const box = document.querySelector('#partnerLoginError');
    if (!box) return;
    const translated = translateAuthMessage(message);
    if (box.textContent !== translated) box.textContent = translated;
    box.classList.toggle('visible', Boolean(translated));
    box.classList.toggle('info', mode === 'info');
  }

  function setButton(label, disabled) {
    const button = document.querySelector('#partnerSubmit');
    if (!button) return;
    button.disabled = Boolean(disabled);
    const span = button.querySelector('span');
    if (span && span.textContent !== label) span.textContent = label;
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

  function setOfficialLogo(image) {
    if (!image) return;
    image.dataset.officialLogo = '1';
    if (!image.src.includes('/assets/step-one-official-transparent.png')) image.src = OFFICIAL_STEP_LOGO;
    image.alt = 'STEP One';
    image.removeAttribute('referrerpolicy');
  }

  function removeLogoSeparators(container) {
    if (!container) return;
    container.querySelectorAll('.partner-x, :scope > span').forEach(element => element.remove());
  }

  function installOfficialBranding() {
    const gate = document.querySelector('#brasfelsAuthGate');
    if (!gate) return false;

    const logoComposition = gate.querySelector('.partner-logo-composition');
    if (logoComposition) {
      setOfficialLogo(logoComposition.querySelector('img:first-child'));
      removeLogoSeparators(logoComposition);
    }

    const card = gate.querySelector('.partner-login-card');
    if (!card) return false;

    let cardLogos = card.querySelector('.partner-card-logos');
    if (!cardLogos) {
      cardLogos = document.createElement('div');
      cardLogos.className = 'partner-card-logos';
      cardLogos.innerHTML = `
        <img data-official-logo="1" src="${OFFICIAL_STEP_LOGO}" alt="STEP One">
        <img src="assets/brasfels-logo.svg?v=19" alt="BrasFELS">`;
      card.insertBefore(cardLogos, card.firstChild);
    } else {
      setOfficialLogo(cardLogos.querySelector('img:first-child'));
      const brasfels = cardLogos.querySelector('img:last-child');
      if (brasfels && !brasfels.src.includes('/assets/brasfels-logo.svg')) brasfels.src = 'assets/brasfels-logo.svg?v=19';
      removeLogoSeparators(cardLogos);
    }

    if (card.dataset[BRANDING_FLAG] !== '1') {
      card.dataset[BRANDING_FLAG] = '1';

      const intro = card.querySelector(':scope > p');
      const introText = 'Use o mesmo login e a mesma senha da Intranet STEP One. No primeiro acesso, a credencial será vinculada automaticamente ao painel BRASFELS.';
      if (intro && intro.textContent !== introText) intro.textContent = introText;

      const identifier = card.querySelector('#partnerEmail');
      if (identifier) {
        identifier.type = 'text';
        identifier.placeholder = 'E-mail corporativo ou login da Intranet';
        identifier.autocomplete = 'username';
        const label = identifier.closest('label');
        const firstNode = label?.firstChild;
        if (firstNode && firstNode.nodeType === Node.TEXT_NODE) firstNode.nodeValue = 'E-mail ou login\n                ';
      }

      const accessNote = card.querySelector('.partner-access-note span');
      if (accessNote) {
        accessNote.innerHTML = '<b>Acesso integrado</b>A senha não é exibida nem copiada. Ela é validada de forma segura pela Intranet STEP One e vinculada ao Supabase no primeiro acesso.';
      }
    }

    return true;
  }

  function installForgotPassword() {
    const forgot = document.querySelector('#partnerForgot');
    if (!forgot || forgot.dataset.bridgeInstalled === '1') return;
    forgot.dataset.bridgeInstalled = '1';
    forgot.onclick = () => {
      showMessage('A senha é a mesma da Intranet STEP One. Caso não lembre, solicite a redefinição ao administrador da Intranet.', 'info');
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
        await originalSubmit.call(form, { preventDefault() {} });
      } catch (error) {
        const status = Number(error.status || 0);
        const canTryExistingSupabasePassword = identifier.includes('@') && (status === 401 || status === 503 || status === 0);

        if (canTryExistingSupabasePassword) {
          setButton('Verificando acesso existente...', true);
          await originalSubmit.call(form, { preventDefault() {} });
          window.setTimeout(() => {
            const box = document.querySelector('#partnerLoginError');
            if (box?.textContent) box.textContent = translateAuthMessage(box.textContent);
          }, 350);
          return;
        }

        showMessage(error.message || 'Não foi possível entrar.');
        setButton('Entrar e carregar dados', false);
      }
    };

    return true;
  }

  function install() {
    scheduled = false;
    installOfficialBranding();
    installForgotPassword();
    installLoginBridge();
  }

  function scheduleInstall() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(install);
  }

  window.addEventListener('load', () => {
    scheduleInstall();

    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
        scheduleInstall();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
