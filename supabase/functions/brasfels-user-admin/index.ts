import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const PRIMARY_ADMIN_EMAIL = "douglas.tabella@step-og.com";
const PROJECT_CODE = "FPSO-P85";
const PANEL_URL = "https://stepoil-debug.github.io/BRASFELS/";
const ALLOWED_ROLES = new Set(["viewer", "operator", "admin"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Configuração administrativa indisponível." }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Sessão não informada." }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const currentUser = userData.user;
  if (userError || !currentUser) return json({ error: "Sessão inválida ou expirada." }, 401);

  const { data: project, error: projectError } = await admin.schema("brasfels").from("projects").select("id,code,name").eq("code", PROJECT_CODE).single();
  if (projectError || !project) return json({ error: "Projeto BRASFELS não encontrado." }, 404);

  const { data: membership } = await admin.schema("brasfels").from("project_members").select("role").eq("project_id", project.id).eq("user_id", currentUser.id).maybeSingle();
  const currentEmail = normalizeEmail(currentUser.email);
  const isPrimary = currentEmail === PRIMARY_ADMIN_EMAIL;
  if (membership?.role !== "admin" && !isPrimary) return json({ error: "Somente administradores podem gerenciar acessos." }, 403);

  const { data: authList, error: authListError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authListError) return json({ error: authListError.message }, 500);

  const { data: intranetUsers, error: intranetError } = await admin.from("users").select("id,username,name,email,sector,role,active,can_manage_access").eq("active", true).not("email", "is", null);
  if (intranetError) return json({ error: intranetError.message }, 500);

  const authById = new Map(authList.users.map(user => [user.id, user]));
  const authByEmail = new Map(authList.users.map(user => [normalizeEmail(user.email), user]));
  const intranetById = new Map((intranetUsers || []).map(user => [String(user.id), user]));
  const intranetByEmail = new Map((intranetUsers || []).map(user => [normalizeEmail(user.email), user]));

  const { data: memberships, error: membershipsError } = await admin.schema("brasfels").from("project_members").select("user_id,role,created_at").eq("project_id", project.id);
  if (membershipsError) return json({ error: membershipsError.message }, 500);
  const roleByUser = new Map((memberships || []).map(item => [item.user_id, item]));

  if (req.method === "GET") {
    const combined = new Map<string, Record<string, unknown>>();
    for (const user of authList.users) {
      const email = normalizeEmail(user.email);
      const member = roleByUser.get(user.id);
      const intranet = intranetByEmail.get(email);
      combined.set(email || user.id, {
        id: user.id,
        auth_id: user.id,
        intranet_id: intranet?.id || null,
        email: user.email,
        full_name: user.user_metadata?.full_name || user.user_metadata?.name || intranet?.name || "",
        username: intranet?.username || "",
        sector: intranet?.sector || "",
        intranet_role: intranet?.role || "",
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
        email_confirmed_at: user.email_confirmed_at,
        role: member?.role || null,
        access_created_at: member?.created_at || null,
        primary_admin: email === PRIMARY_ADMIN_EMAIL,
        current_user: user.id === currentUser.id,
        source: intranet ? "auth+intranet" : "auth",
        needs_account: false,
      });
    }
    for (const intranet of intranetUsers || []) {
      const email = normalizeEmail(intranet.email);
      if (!email || combined.has(email)) continue;
      combined.set(email, {
        id: `candidate:${intranet.id}`,
        auth_id: null,
        intranet_id: intranet.id,
        email: intranet.email,
        full_name: intranet.name || "",
        username: intranet.username || "",
        sector: intranet.sector || "",
        intranet_role: intranet.role || "",
        created_at: null,
        last_sign_in_at: null,
        email_confirmed_at: null,
        role: null,
        access_created_at: null,
        primary_admin: email === PRIMARY_ADMIN_EMAIL,
        current_user: false,
        source: "intranet",
        needs_account: true,
      });
    }
    const users = [...combined.values()].sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email), "pt-BR"));
    return json({
      project,
      current_user: { id: currentUser.id, email: currentUser.email, role: "admin", primary_admin: isPrimary },
      totals: { auth_users: authList.users.length, intranet_users: (intranetUsers || []).length, candidates: users.filter(user => user.needs_account).length },
      users,
    });
  }

  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Corpo da requisição inválido." }, 400); }
  const action = String(body.action || "");
  const role = String(body.role || "viewer");
  if ((action === "create_or_grant" || action === "set_role") && !ALLOWED_ROLES.has(role)) return json({ error: "Perfil inválido." }, 400);

  const rawUserId = String(body.user_id || "");
  let target = rawUserId && !rawUserId.startsWith("candidate:") ? authById.get(rawUserId) : undefined;
  let candidate = rawUserId.startsWith("candidate:") ? intranetById.get(rawUserId.replace("candidate:", "")) : undefined;
  let targetEmail = normalizeEmail(body.email || candidate?.email || target?.email);
  if (!target && targetEmail) target = authByEmail.get(targetEmail);
  if (!candidate && targetEmail) candidate = intranetByEmail.get(targetEmail);

  async function ensureAuthUser(allowInvite: boolean) {
    if (target) return { user: target, created: false, invited: false };
    if (!targetEmail || !targetEmail.includes("@")) throw new Error("E-mail válido não encontrado para este cadastro.");
    const password = String(body.password || "");
    const fullName = String(body.full_name || candidate?.name || "").trim();
    if (password.length >= 8) {
      const { data, error } = await admin.auth.admin.createUser({
        email: targetEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, created_for: "BRASFELS", intranet_user_id: candidate?.id || null },
      });
      if (error || !data.user) throw new Error(error?.message || "Não foi possível criar o usuário.");
      target = data.user;
      return { user: data.user, created: true, invited: false };
    }
    if (!allowInvite) throw new Error("Informe uma senha temporária com no mínimo 8 caracteres.");
    const { data, error } = await admin.auth.admin.inviteUserByEmail(targetEmail, {
      redirectTo: PANEL_URL,
      data: { full_name: fullName, created_for: "BRASFELS", intranet_user_id: candidate?.id || null },
    });
    if (error || !data.user) throw new Error(error?.message || "Não foi possível enviar o convite.");
    target = data.user;
    return { user: data.user, created: true, invited: true };
  }

  if (action === "create_or_grant") {
    targetEmail = normalizeEmail(body.email || targetEmail);
    try {
      const ensured = await ensureAuthUser(false);
      const targetRole = normalizeEmail(ensured.user.email) === PRIMARY_ADMIN_EMAIL ? "admin" : role;
      const { error } = await admin.schema("brasfels").from("project_members").upsert({ project_id: project.id, user_id: ensured.user.id, role: targetRole }, { onConflict: "project_id,user_id" });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, created: ensured.created, invited: ensured.invited, user: { id: ensured.user.id, email: ensured.user.email, role: targetRole } });
    } catch (error) { return json({ error: error.message }, 400); }
  }

  if (action === "set_role") {
    try {
      const ensured = await ensureAuthUser(true);
      if (normalizeEmail(ensured.user.email) === PRIMARY_ADMIN_EMAIL && role !== "admin") return json({ error: "O administrador principal não pode ser rebaixado." }, 400);
      const { error } = await admin.schema("brasfels").from("project_members").upsert({ project_id: project.id, user_id: ensured.user.id, role }, { onConflict: "project_id,user_id" });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, invited: ensured.invited, user: { id: ensured.user.id, email: ensured.user.email, role } });
    } catch (error) { return json({ error: error.message }, 400); }
  }

  if (!target) return json({ error: "Este cadastro ainda não possui conta Auth. Libere um perfil ou crie-o com senha temporária." }, 404);
  const normalizedTargetEmail = normalizeEmail(target.email);

  if (action === "revoke") {
    if (normalizedTargetEmail === PRIMARY_ADMIN_EMAIL || target.id === currentUser.id) return json({ error: "Este administrador não pode remover o próprio acesso principal." }, 400);
    const { error } = await admin.schema("brasfels").from("project_members").delete().eq("project_id", project.id).eq("user_id", target.id);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  if (action === "reset_password") {
    const password = String(body.password || "");
    if (password.length < 8) return json({ error: "A nova senha precisa ter no mínimo 8 caracteres." }, 400);
    const { error } = await admin.auth.admin.updateUserById(target.id, { password });
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  return json({ error: "Ação não reconhecida." }, 400);
});
