// templates — lista e cria templates (HSM) na conta WhatsApp Business (WABA) via Meta.
// Requer WHATSAPP_WABA_ID + token com permissão whatsapp_business_management.
// Acesso: usuário logado (Supabase Auth) na allowlist OPERADORES.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const WABA = Deno.env.get("WHATSAPP_WABA_ID") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const GRAPH = "https://graph.facebook.com/v21.0";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

async function autorizado(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
    if (!r.ok) return false;
    const u = await r.json();
    if (!u?.id) return false;
    const email = String(u.email ?? "").toLowerCase();
    if (OPERADORES.length && !OPERADORES.includes(email)) return false;
    return true;
  } catch { return false; }
}
const nVars = (t: string) => { const s = new Set<string>(); (t.match(/\{\{\s*\d+\s*\}\}/g) || []).forEach((m) => s.add(m)); return s.size; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await autorizado(req))) return json({ erro: "nao autorizado" }, 401);
  if (!WABA || !WA_TOKEN) return json({ erro: "WhatsApp/WABA nao configurado (WHATSAPP_WABA_ID + token com whatsapp_business_management)" }, 400);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const action = body?.action ?? "list";
  const authH = { Authorization: `Bearer ${WA_TOKEN}` };

  try {
    if (action === "list") {
      const r = await fetch(`${GRAPH}/${WABA}/message_templates?fields=name,status,category,language,components&limit=100`, { headers: authH });
      const d = await r.json();
      if (!r.ok) {
        if (d?.error?.code === 190) return json({ erro: "Token do WhatsApp expirou/invalido. Gere um token permanente (expiracao 'Nunca')." }, 400);
        return json({ erro: "falha ao listar templates", detalhe: d?.error?.message ?? d }, 502);
      }
      return json({ templates: d.data ?? [] });
    }

    if (action === "create") {
      const t = body?.template ?? {};
      const name = String(t.name ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
      const category = String(t.category ?? "MARKETING").toUpperCase();
      const language = String(t.language ?? "pt_BR");
      const corpo = String(t.body ?? "").trim();
      const exemplos: string[] = Array.isArray(t.exemplos) ? t.exemplos.map((x: unknown) => String(x)) : [];
      if (!name) return json({ erro: "nome do template obrigatorio" }, 400);
      if (!corpo) return json({ erro: "corpo (body) obrigatorio" }, 400);
      const qtdVars = nVars(corpo);
      if (qtdVars !== exemplos.length) return json({ erro: `o corpo tem ${qtdVars} variavel(is) {{n}}, mas foram enviados ${exemplos.length} exemplo(s). Devem bater.` }, 400);

      const components: any[] = [];
      if (t.header && String(t.header).trim()) {
        const htxt = String(t.header).trim();
        const hVars = nVars(htxt);
        const comp: any = { type: "HEADER", format: "TEXT", text: htxt };
        if (hVars === 1 && t.header_exemplo) comp.example = { header_text: [String(t.header_exemplo)] };
        components.push(comp);
      }
      const bodyComp: any = { type: "BODY", text: corpo };
      if (qtdVars > 0) bodyComp.example = { body_text: [exemplos] };
      components.push(bodyComp);
      if (t.footer && String(t.footer).trim()) components.push({ type: "FOOTER", text: String(t.footer).trim() });

      const payload = { name, category, language, components };
      const r = await fetch(`${GRAPH}/${WABA}/message_templates`, {
        method: "POST", headers: { ...authH, "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        const err = d?.error ?? {};
        if (err.code === 190) return json({ erro: "Token do WhatsApp expirou/invalido. Gere um token PERMANENTE (Usuario do Sistema, expiracao 'Nunca') com whatsapp_business_messaging + whatsapp_business_management." }, 400);
        return json({ erro: "Meta recusou o template", detalhe: err.error_user_msg ?? err.error_user_title ?? err.message ?? d }, 400);
      }
      return json({ ok: true, template: { name, category, language, id: d.id, status: d.status ?? "PENDING" }, enviado_para_aprovacao: true });
    }

    return json({ erro: "action invalida (use list ou create)" }, 400);
  } catch (e) {
    console.error("templates:", e);
    return json({ erro: "falha ao falar com a Meta" }, 500);
  }
});
