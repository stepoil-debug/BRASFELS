'use strict';

(function () {
  const AUTH_STORAGE_KEY = 'brasfels-partner-auth-v1';
  const PRIMARY_ADMIN = 'douglas.tabella@step-og.com';
  let accessContext = null;
  let accessSearch = '';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalizeEmail = value => String(value || '').trim().toLowerCase();

  function sessionStores() {
    return [localStorage, sessionStorage];
  }

  function clearStoredAuth() {
    sessionStores().forEach(store => {
      store.removeItem(AUTH_STORAGE_KEY);
      store.removeItem('brasfels-token');
    });
    sessionStorage.removeItem('brasfels-token');
  }

  function readStoredAuth() {
    for (const store of sessionStores()) {
      try {
        const value = JSON.parse(store.getItem(AUTH_STORAGE_KEY) || 'null');
        if (value?.access_token) return { ...value, persistent: store === localStorage };
      } catch {}
    }
    return null;
  }

  function saveAuthSession(payload, persistent) {
    clearStoredAuth();
    const store = persistent ? localStorage : sessionStorage;
    store.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload));
    sessionStorage.setItem('brasfels-token', payload.access_token);
  }

  async function refreshSession(saved) {
    if (!saved?.refresh_token) return null;
    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: CONFIG.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: saved.refresh_token }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
      user: data.user,
    };
    saveAuthSession(session, saved.persistent);
    return session;
  }

  async function validateSession(saved) {
    if (!saved?.access_token) return null;
    if (saved.expires_at && Number(saved.expires_at) < Date.now() + 60000) {
      return refreshSession(saved);
    }
    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${saved.access_token}` },
    });
    if (response.ok) {
      const user = await response.json();
      return { ...saved, user };
    }
    return refreshSession(saved);
  }

  function applySession(session) {
    state.supabase.url = CONFIG.supabaseUrl;
    state.supabase.key = CONFIG.supabaseKey;
    state.supabase.token = session.access_token;
    state.supabase.user = session.user;
    state.supabase.email = session.user?.email || '';
    sessionStorage.setItem('brasfels-token', session.access_token);
    const emailInput = $('#supabaseEmail');
    if (emailInput) emailInput.value = state.supabase.email;
    const connection = $('#connectionState');
    if (connection) {
      connection.classList.add('connected');
      const label = connection.querySelector('strong');
      if (label) label.textContent = `Conectado: ${state.supabase.email}`;
    }
  }

  function partnershipLoginMarkup() {
    return `
      <main class="partner-login-page">
        <section class="partner-login-visual" aria-label="Parceria STEP One e BrasFELS">
          <div class="partner-background" aria-hidden="true"></div>
          <div class="partner-sheen" aria-hidden="true"></div>
          <div class="partner-orbit partner-orbit-one" aria-hidden="true"></div>
          <div class="partner-orbit partner-orbit-two" aria-hidden="true"></div>
          <div class="partner-logo-stage">
            <div class="partner-logo-composition">
              <img src="assets/step-one-logo.svg?v=5" alt="STEP One">
              <span class="partner-x">×</span>
              <img src="assets/brasfels-logo.svg?v=5" alt="BrasFELS">
            </div>
          </div>
          <div class="partner-visual-copy">
            <span class="partner-kicker">STEP One + BrasFELS</span>
            <h1>Produção e controle industrial em um único ambiente.</h1>
            <p>Acompanhe spools, materiais, etapas produtivas, divergências e atualizações com acesso definido para cada integrante da parceria.</p>
            <div class="partner-features">
              <span><i>✓</i> Acesso por perfil</span>
              <span><i>✓</i> Dados protegidos</span>
              <span><i>✓</i> Atualização por Excel</span>
            </div>
          </div>
          <div class="partner-security">Ambiente protegido</div>
        </section>
        <section class="partner-login-panel">
          <div class="partner-login-card">
            <div class="partner-login-heading"><span>◆</span><div><small>Bem-vindo à parceria</small><h2>Acessar painel</h2></div></div>
            <p>Entre com o usuário autorizado no Supabase para carregar a base operacional compartilhada.</p>
            <form class="partner-form" id="partnerLoginForm">
              <label>E-mail
                <div class="partner-input-wrap"><span class="partner-input-icon">＠</span><input id="partnerEmail" type="email" autocomplete="username" value="${escapeHtml(state.supabase.email || PRIMARY_ADMIN)}" placeholder="nome.sobrenome@step-og.com" required></div>
              </label>
              <label>Senha
                <div class="partner-input-wrap"><span class="partner-input-icon">●</span><input id="partnerPassword" type="password" autocomplete="current-password" placeholder="Senha" required><button id="partnerTogglePassword" type="button" aria-label="Mostrar senha">◉</button></div>
              </label>
              <div class="partner-form-meta"><label><input id="partnerRemember" type="checkbox" checked> <span>Manter conectado</span></label><button type="button" id="partnerForgot">Esqueci minha senha</button></div>
              <button class="partner-submit" id="partnerSubmit" type="submit"><span>Entrar e carregar dados</span><b>→</b></button>
              <div class="partner-login-error" id="partnerLoginError"></div>
            </form>
            <div class="partner-access-note"><i>◆</i><span><b>Acesso controlado</b>Novos usuários são criados e liberados pelo administrador principal dentro do próprio painel.</span></div>
            <div class="partner-palette"><i></i><i></i><i></i><i></i><i></i><span>Identidade STEP One × BrasFELS</span></div>
          </div>
        </section>
      </main>`;
  }

  function buildPartnerGate() {
    let gate = $('#brasfelsAuthGate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'brasfelsAuthGate';
      document.body.appendChild(gate);
    }
    gate.className = 'auth-gate partner-auth-gate';
    gate.innerHTML = partnershipLoginMarkup();

    const form = $('#partnerLoginForm');
    const toggle = $('#partnerTogglePassword');
    const password = $('#partnerPassword');
    toggle.onclick = () => {
      const visible = password.type === 'text';
      password.type = visible ? 'password' : 'text';
      toggle.textContent = visible ? '◉' : '⊘';
      toggle.setAttribute('aria-label', visible ? 'Mostrar senha' : 'Ocultar senha');
    };
    $('#partnerForgot').onclick = () => showLoginError('Solicite ao administrador principal a redefinição da sua senha.');
    form.onsubmit = event => {
      event.preventDefault();
      void signInPartner();
    };
    return gate;
  }

  function showLoginError(message) {
    const box = $('#partnerLoginError');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('visible', Boolean(message));
  }

  async function signInPartner() {
    const email = normalizeEmail($('#partnerEmail')?.value);
    const password = $('#partnerPassword')?.value || '';
    const persistent = Boolean($('#partnerRemember')?.checked);
    const button = $('#partnerSubmit');
    if (!email || !password) return showLoginError('Informe e-mail e senha.');

    button.disabled = true;
    button.querySelector('span').textContent = 'Validando acesso...';
    showLoginError('');
    try {
      const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: CONFIG.supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error_description || data.msg || 'E-mail ou senha inválidos.');
      const session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
        user: data.user,
      };
      saveAuthSession(session, persistent);
      applySession(session);
      $('#brasfelsAuthGate').classList.add('hidden');
      await afterAuthenticated();
      toast('Acesso autorizado. Base compartilhada carregada.');
    } catch (error) {
      showLoginError(error.message || 'Não foi possível entrar.');
    } finally {
      button.disabled = false;
      button.querySelector('span').textContent = 'Entrar e carregar dados';
    }
  }

  async function callAccessAdmin(body) {
    const response = await fetch(`${CONFIG.supabaseUrl}/functions/v1/brasfels-user-admin`, {
      method: body ? 'POST' : 'GET',
      headers: {
        apikey: CONFIG.supabaseKey,
        Authorization: `Bearer ${state.supabase.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Falha ao gerenciar acessos (${response.status}).`);
    return data;
  }

  async function loadAccessContext() {
    try {
      accessContext = await callAccessAdmin();
      state.supabase.role = accessContext.current_user?.role || 'admin';
      installAccessManagement();
      renderAccessManagement();
      applyRolePermissions();
    } catch (error) {
      accessContext = null;
      state.supabase.role = 'viewer';
      removeAccessManagement();
      applyRolePermissions();
      if (error.message && !/Somente administradores/.test(error.message)) console.warn(error);
    }
  }

  function applyRolePermissions() {
    const role = state.supabase.role || 'viewer';
    const canWrite = role === 'operator' || role === 'admin';
    ['openImport', 'syncSupabase'].forEach(id => {
      const element = $(`#${id}`);
      if (element) {
        element.hidden = !canWrite;
        element.disabled = !canWrite;
      }
    });
    $$('.import-shortcut').forEach(button => { button.hidden = !canWrite; });
  }

  async function afterAuthenticated() {
    installUserChip();
    if (window.loadBrasfelsRemoteData) await window.loadBrasfelsRemoteData({ silent: true });
    await loadAccessContext();
    renderAll();
    if (window.renderBrasfelsProduction) window.renderBrasfelsProduction();
  }

  function installUserChip() {
    const actions = $('.top-actions');
    if (!actions) return;
    let chip = $('#partnerUserChip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'partnerUserChip';
      chip.className = 'partner-user-chip';
      actions.appendChild(chip);
    }
    const email = state.supabase.user?.email || state.supabase.email || '';
    chip.innerHTML = `<div><strong>${escapeHtml(email)}</strong><small>${state.supabase.role === 'admin' ? 'Administrador' : state.supabase.role === 'operator' ? 'Operador' : 'Visualização'}</small></div><button id="partnerLogout" title="Sair">↪</button>`;
    $('#partnerLogout').onclick = () => void logoutPartner();
  }

  async function logoutPartner() {
    try {
      if (state.supabase.token) {
        await fetch(`${CONFIG.supabaseUrl}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${state.supabase.token}` },
        });
      }
    } catch {}
    clearStoredAuth();
    state.supabase.token = '';
    state.supabase.user = null;
    state.supabase.role = null;
    state.spools = [];
    state.materials = [];
    state.imports = [];
    accessContext = null;
    try { await dbClear(); } catch {}
    renderAll();
    $('#partnerUserChip')?.remove();
    buildPartnerGate().classList.remove('hidden');
    removeAccessManagement();
  }

  function installAccessManagement() {
    const nav = $('.nav');
    if (!nav || $('#accessManagementNav')) return;
    const settings = nav.querySelector('[data-view="settings"]');
    const button = document.createElement('button');
    button.id = 'accessManagementNav';
    button.className = 'nav-item';
    button.dataset.view = 'access-management';
    button.innerHTML = '<span>♙</span> Gestão de acessos <b id="accessUserCount">0</b>';
    nav.insertBefore(button, settings);
    button.onclick = showAccessManagement;

    const section = document.createElement('section');
    section.id = 'view-access-management';
    section.className = 'view access-management-view';
    section.innerHTML = `
      <div class="section-intro"><div><p class="eyebrow">ADMINISTRAÇÃO</p><h2>Gestão de acessos</h2><p>Crie usuários, defina perfis e controle quem pode visualizar ou atualizar o painel BRASFELS.</p></div><span class="access-admin-badge">Administrador principal protegido</span></div>
      <div class="access-kpis" id="accessKpis"></div>
      <div class="access-layout">
        <article class="panel access-form-card">
          <p class="eyebrow">NOVO ACESSO</p><h3>Criar ou liberar usuário</h3><p>Se o e-mail já existir no Supabase, o acesso será apenas associado ao projeto. Para um novo usuário, informe uma senha temporária.</p>
          <form id="accessCreateForm">
            <div class="access-form-grid">
              <label class="wide">Nome completo<input id="accessFullName" placeholder="Nome do colaborador" maxlength="160"></label>
              <label class="wide">E-mail<input id="accessEmail" type="email" placeholder="nome@empresa.com" required></label>
              <label>Perfil<select id="accessRole"><option value="viewer">Visualização</option><option value="operator">Operador</option><option value="admin">Administrador</option></select></label>
              <label>Senha temporária<input id="accessPassword" type="password" minlength="8" placeholder="Somente para novo usuário"></label>
            </div>
            <div class="access-form-actions"><button class="button primary" id="accessCreateButton" type="submit">Criar e liberar acesso</button><button class="button secondary" id="accessRefreshButton" type="button">Atualizar lista</button></div>
            <div class="access-form-feedback" id="accessFeedback"></div>
          </form>
        </article>
        <article class="panel access-users-card">
          <p class="eyebrow">USUÁRIOS DO SUPABASE</p><h3>Acessos disponíveis</h3><p>Usuários sem perfil continuam cadastrados no Supabase, mas não conseguem abrir os dados deste painel.</p>
          <div class="access-search"><input id="accessSearch" placeholder="Pesquisar nome ou e-mail"></div>
          <div class="access-users-list" id="accessUsersList"></div>
        </article>
      </div>`;
    $('.main').appendChild(section);

    $('#accessCreateForm').onsubmit = event => { event.preventDefault(); void createOrGrantUser(); };
    $('#accessRefreshButton').onclick = () => void refreshAccessUsers();
    $('#accessSearch').oninput = event => { accessSearch = normalizeEmail(event.target.value); renderAccessUsers(); };
  }

  function removeAccessManagement() {
    $('#accessManagementNav')?.remove();
    $('#view-access-management')?.remove();
  }

  function showAccessManagement() {
    $$('.view').forEach(view => view.classList.remove('active'));
    $('#view-access-management')?.classList.add('active');
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'accessManagementNav'));
    $('#pageTitle').textContent = 'Gestão de acessos';
    $('#sidebar').classList.remove('open');
    renderAccessManagement();
  }

  function roleLabel(role) {
    return role === 'admin' ? 'Administrador' : role === 'operator' ? 'Operador' : role === 'viewer' ? 'Visualização' : 'Sem acesso';
  }

  function renderAccessManagement() {
    if (!accessContext || !$('#view-access-management')) return;
    const users = accessContext.users || [];
    const active = users.filter(user => user.role).length;
    const admins = users.filter(user => user.role === 'admin').length;
    const operators = users.filter(user => user.role === 'operator').length;
    const viewers = users.filter(user => user.role === 'viewer').length;
    $('#accessUserCount').textContent = fmt(active);
    $('#accessKpis').innerHTML = `
      <article class="access-kpi"><span>Usuários no Supabase</span><strong>${fmt(users.length)}</strong><small>Cadastros encontrados</small></article>
      <article class="access-kpi"><span>Com acesso</span><strong>${fmt(active)}</strong><small>Associados ao FPSO P85</small></article>
      <article class="access-kpi"><span>Administradores</span><strong>${fmt(admins)}</strong><small>Acesso total</small></article>
      <article class="access-kpi"><span>Operação / leitura</span><strong>${fmt(operators + viewers)}</strong><small>${fmt(operators)} operadores · ${fmt(viewers)} leitores</small></article>`;
    renderAccessUsers();
    installUserChip();
  }

  function renderAccessUsers() {
    if (!accessContext || !$('#accessUsersList')) return;
    const users = (accessContext.users || []).filter(user => {
      if (!accessSearch) return true;
      return normalizeEmail(`${user.email} ${user.full_name}`).includes(accessSearch);
    });
    if (!users.length) {
      $('#accessUsersList').innerHTML = '<div class="empty-access-list">Nenhum usuário encontrado.</div>';
      return;
    }
    $('#accessUsersList').innerHTML = users.map(user => {
      const initial = String(user.full_name || user.email || '?').trim().charAt(0).toUpperCase();
      const primary = user.primary_admin;
      const roleControl = primary
        ? '<span class="access-role-label">Administrador principal</span>'
        : `<select data-role-user="${user.id}"><option value="">Sem acesso</option><option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>Visualização</option><option value="operator" ${user.role === 'operator' ? 'selected' : ''}>Operador</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrador</option></select>`;
      return `<div class="access-user-row ${primary ? 'primary' : ''}">
        <div class="access-user-identity"><span class="access-avatar">${escapeHtml(initial)}</span><div><strong>${escapeHtml(user.full_name || user.email || 'Usuário')}</strong><small>${escapeHtml(user.email || '')} · ${roleLabel(user.role)}</small></div></div>
        ${roleControl}
        <div class="access-user-actions"><button class="access-mini-button" data-password-user="${user.id}" ${primary ? '' : ''}>Senha</button><button class="access-mini-button danger" data-revoke-user="${user.id}" ${primary || user.current_user || !user.role ? 'disabled' : ''}>Revogar</button></div>
      </div>`;
    }).join('');

    $$('[data-role-user]').forEach(select => {
      select.onchange = () => void changeUserRole(select.dataset.roleUser, select.value);
    });
    $$('[data-revoke-user]').forEach(button => {
      button.onclick = () => void revokeUser(button.dataset.revokeUser);
    });
    $$('[data-password-user]').forEach(button => {
      button.onclick = () => void resetUserPassword(button.dataset.passwordUser);
    });
  }

  function setAccessFeedback(message, type = '') {
    const element = $('#accessFeedback');
    if (!element) return;
    element.textContent = message || '';
    element.className = `access-form-feedback ${type}`;
  }

  async function createOrGrantUser() {
    const email = normalizeEmail($('#accessEmail').value);
    const fullName = clean($('#accessFullName').value);
    const role = $('#accessRole').value;
    const password = $('#accessPassword').value;
    const button = $('#accessCreateButton');
    if (!email) return setAccessFeedback('Informe o e-mail do usuário.', 'error');
    button.disabled = true;
    button.textContent = 'Salvando acesso...';
    setAccessFeedback('');
    try {
      const result = await callAccessAdmin({ action: 'create_or_grant', email, full_name: fullName, role, password });
      setAccessFeedback(result.created ? 'Usuário criado e acesso liberado.' : 'Acesso associado ao usuário existente.', 'success');
      $('#accessCreateForm').reset();
      $('#accessRole').value = 'viewer';
      await refreshAccessUsers(false);
    } catch (error) {
      setAccessFeedback(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Criar e liberar acesso';
    }
  }

  async function refreshAccessUsers(showToast = true) {
    try {
      accessContext = await callAccessAdmin();
      renderAccessManagement();
      if (showToast) toast('Lista de acessos atualizada.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function changeUserRole(userId, role) {
    try {
      if (!role) {
        await callAccessAdmin({ action: 'revoke', user_id: userId });
      } else {
        await callAccessAdmin({ action: 'set_role', user_id: userId, role });
      }
      await refreshAccessUsers(false);
      toast('Perfil atualizado.');
    } catch (error) {
      toast(error.message, 'error');
      await refreshAccessUsers(false);
    }
  }

  async function revokeUser(userId) {
    if (!confirm('Remover o acesso deste usuário ao painel BRASFELS?')) return;
    try {
      await callAccessAdmin({ action: 'revoke', user_id: userId });
      await refreshAccessUsers(false);
      toast('Acesso revogado.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function resetUserPassword(userId) {
    const password = prompt('Informe a nova senha temporária (mínimo de 8 caracteres):');
    if (password === null) return;
    if (password.length < 8) return toast('A senha precisa ter no mínimo 8 caracteres.', 'error');
    try {
      await callAccessAdmin({ action: 'reset_password', user_id: userId, password });
      toast('Senha atualizada.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function secureImport() {
    const role = state.supabase.role || 'viewer';
    if (!state.supabase.token) return buildPartnerGate().classList.remove('hidden');
    if (role !== 'operator' && role !== 'admin') return toast('Seu perfil permite somente visualização.', 'error');
    openImport();
  }

  async function restoreAuthentication() {
    const saved = readStoredAuth();
    if (!saved) return false;
    try {
      const valid = await validateSession(saved);
      if (!valid) throw new Error('Sessão expirada');
      saveAuthSession(valid, saved.persistent);
      applySession(valid);
      return true;
    } catch {
      clearStoredAuth();
      return false;
    }
  }

  async function install() {
    document.title = 'STEP One × BrasFELS | Controle Operacional';
    const gate = buildPartnerGate();
    const restored = await restoreAuthentication();
    if (restored) {
      gate.classList.add('hidden');
      await afterAuthenticated();
    } else {
      gate.classList.remove('hidden');
    }

    $('#openImport').onclick = secureImport;
    $$('.import-shortcut').forEach(button => { button.onclick = secureImport; });
  }

  async function waitForCore() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (typeof state !== 'undefined' && typeof CONFIG !== 'undefined' && typeof renderAll === 'function' && $('#brasfelsAuthGate')) {
        await install();
        return;
      }
      await sleep(150);
    }
    console.error('BRASFELS: núcleo do painel não ficou disponível para o login de parceria.');
  }

  window.addEventListener('load', () => void waitForCore());
})();
