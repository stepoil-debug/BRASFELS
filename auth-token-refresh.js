'use strict';

(function installBrasfelsTokenRefresh() {
  const AUTH_STORAGE_KEY = 'brasfels-partner-auth-v1';
  const nativeFetch = window.fetch.bind(window);
  let refreshPromise = null;

  function storedSession() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        const session = JSON.parse(store.getItem(AUTH_STORAGE_KEY) || 'null');
        if (session?.refresh_token) return { store, session };
      } catch {}
    }
    return null;
  }

  function isExpiredJwt(payload) {
    const message = `${payload?.message || ''} ${payload?.msg || ''} ${payload?.error || ''} ${payload?.error_description || ''}`.toLowerCase();
    return message.includes('jwt expired') || message.includes('invalid jwt') || message.includes('token has expired');
  }

  async function refreshSession() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const saved = storedSession();
      if (!saved?.session?.refresh_token) throw new Error('Sessão expirada. Entre novamente no painel.');

      const supabaseUrl = typeof CONFIG !== 'undefined' ? CONFIG.supabaseUrl : '';
      const supabaseKey = typeof CONFIG !== 'undefined' ? CONFIG.supabaseKey : '';
      const response = await nativeFetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: saved.session.refresh_token }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.access_token) throw new Error('Não foi possível renovar a sessão. Entre novamente no painel.');

      const updated = {
        ...saved.session,
        access_token: payload.access_token,
        refresh_token: payload.refresh_token || saved.session.refresh_token,
        expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
        user: payload.user || saved.session.user,
      };

      saved.store.setItem(AUTH_STORAGE_KEY, JSON.stringify(updated));
      sessionStorage.setItem('brasfels-token', updated.access_token);
      if (typeof state !== 'undefined' && state?.supabase) {
        state.supabase.token = updated.access_token;
        state.supabase.user = updated.user || state.supabase.user;
        state.supabase.email = updated.user?.email || state.supabase.email;
      }
      return updated.access_token;
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  window.fetch = async function brasfelsFetch(input, init = {}) {
    const response = await nativeFetch(input, init);
    if (response.status !== 401) return response;

    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('supabase.co') || url.includes('grant_type=refresh_token')) return response;

    const payload = await response.clone().json().catch(() => ({}));
    if (!isExpiredJwt(payload)) return response;

    try {
      const accessToken = await refreshSession();
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (input instanceof Request) return nativeFetch(new Request(input, { ...init, headers }));
      return nativeFetch(input, { ...init, headers });
    } catch {
      return response;
    }
  };

  window.refreshBrasfelsSession = refreshSession;
})();
