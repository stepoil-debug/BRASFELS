'use strict';

(function () {
  let lastToken = '';

  async function resolveOwnRole() {
    if (!state?.supabase?.token || !state?.supabase?.user?.id) return;
    try {
      const projects = await api(`/rest/v1/projects?code=eq.${CONFIG.projectCode}&select=id`);
      if (!projects.length) return;
      const memberships = await api(`/rest/v1/project_members?project_id=eq.${projects[0].id}&user_id=eq.${state.supabase.user.id}&select=role`);
      const role = memberships[0]?.role || 'viewer';
      state.supabase.role = role;
      const canWrite = role === 'operator' || role === 'admin';
      const openImport = $('#openImport');
      const sync = $('#syncSupabase');
      if (openImport) { openImport.hidden = !canWrite; openImport.disabled = !canWrite; }
      if (sync) { sync.hidden = !canWrite; sync.disabled = !canWrite; }
      $$('.import-shortcut').forEach(button => { button.hidden = !canWrite; });
      const chipRole = $('#partnerUserChip small');
      if (chipRole) chipRole.textContent = role === 'admin' ? 'Administrador' : role === 'operator' ? 'Operador' : 'Visualização';
    } catch (error) {
      console.warn('Não foi possível resolver o perfil BRASFELS:', error);
    }
  }

  function watch() {
    const token = state?.supabase?.token || '';
    if (token && token !== lastToken) {
      lastToken = token;
      void resolveOwnRole();
    }
    if (!token) lastToken = '';
  }

  window.addEventListener('load', () => {
    setTimeout(watch, 1200);
    setInterval(watch, 1200);
  });
})();
