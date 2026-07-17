// velma-config — painel operacional da Velma (IA). Acesso: usuario logado na allowlist OPERADORES.
//   action 'get'      -> settings + anthropic_ready + stats das filas
//   action 'save'     -> atualiza campos permitidos (bloqueia ligar sem ANTHROPIC_API_KEY)
//   action 'takeover' -> muda o status da conversa (humano/velma/fechado)
//   action 'conv_status' -> status atual da conversa (para o botao de takeover)
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const ANTHROPIC_READY = !!(Deno.env.get("ANTHROPIC_API_KEY") ?? "");

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

async function getUser(req: Request): Promise<{ email: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u?.id) return null;
    const email = String(u.email ?? "").toLowerCase();
    if (OPERADORES.length && !OPERADORES.includes(email)) return null;
    return { email };
  } catch { return null; }
}
async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null; // PostgREST devolve 201 com corpo vazio em inserts
}
const canon = (p: string) => (p || "").replace(/\D/g, "").replace(/^(55\d{2})9(\d{8})$/, "$1$2");
const clampInt = (v: unknown, lo: number, hi: number, def: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "metodo nao permitido" }, 405);
  const user = await getUser(req);
  if (!user) return json({ erro: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const action = String(body?.action ?? "get");

  try {
    if (action === "get") {
      const s = (await pg("velma_settings?select=*&limit=1"))?.[0] ?? null;
      const stats = await pg("rpc/velma_stats", { method: "POST", body: "{}" }).catch(() => ({}));
      return json({ settings: s, anthropic_ready: ANTHROPIC_READY, stats });
    }

    if (action === "save") {
      const p = body?.patch ?? {};
      const ativar = p.is_active === true;
      if (ativar && !ANTHROPIC_READY) return json({ erro: "Configure a ANTHROPIC_API_KEY (secret do Supabase) antes de ativar a Velma." }, 400);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("is_active" in p) patch.is_active = !!p.is_active;
      if ("message_breaking_enabled" in p) patch.message_breaking_enabled = !!p.message_breaking_enabled;
      if ("persona_nome" in p) patch.persona_nome = String(p.persona_nome ?? "").slice(0, 60) || "Velma";
      if ("tom" in p) patch.tom = String(p.tom ?? "").slice(0, 120);
      if ("debounce_seconds" in p) patch.debounce_seconds = clampInt(p.debounce_seconds, 1, 120, 10);
      if ("response_delay_min" in p) patch.response_delay_min = clampInt(p.response_delay_min, 0, 15000, 1000);
      if ("response_delay_max" in p) patch.response_delay_max = clampInt(p.response_delay_max, 0, 20000, 3000);
      if ("system_prompt_override" in p) { const v = String(p.system_prompt_override ?? "").trim(); patch.system_prompt_override = v ? v.slice(0, 12000) : null; }
      if ("kb" in p) patch.kb = String(p.kb ?? "").slice(0, 20000);
      const row = (await pg("velma_settings?id=eq.1", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }))?.[0] ?? null;
      return json({ ok: true, settings: row });
    }

    if (action === "conv_status") {
      const c = canon(String(body?.telefone ?? ""));
      if (!c) return json({ erro: "telefone ausente" }, 400);
      // somente leitura: nao cria linha de estado so por abrir a conversa no painel
      const r = await pg(`conversation_states?telefone_canon=eq.${encodeURIComponent(c)}&select=status&limit=1`);
      return json({ telefone_canon: c, status: r?.[0]?.status ?? "velma" });
    }

    if (action === "takeover") {
      const c = canon(String(body?.telefone ?? ""));
      const modo = String(body?.modo ?? "");
      if (!c) return json({ erro: "telefone ausente" }, 400);
      if (!["humano", "velma", "fechado"].includes(modo)) return json({ erro: "modo invalido" }, 400);
      await pg("rpc/velma_set_status", { method: "POST", body: JSON.stringify({ p_canon: c, p_status: modo, p_action: `painel:${user.email}` }) });
      return json({ ok: true, telefone_canon: c, status: modo });
    }

    return json({ erro: "action desconhecida" }, 400);
  } catch (e) {
    console.error("velma-config:", e);
    return json({ erro: "falha", detalhe: String(e).slice(0, 300) }, 500);
  }
});
