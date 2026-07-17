// velma-analyze — memoria de longo prazo por cliente. Assincrono (nao bloqueia a resposta).
// Disparado pelo orquestrador ao fim de cada turno (body {telefone_canon}). Usa o modelo
// barato (classificacao) para extrair inteligencia e faz merge em client_memory (JSONB).
// Worker interno: auth por header x-velma-key == VELMA_WORKER_SECRET (fallback SB_KEY).
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("VELMA_WORKER_SECRET") || SB_KEY;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

const DEFAULT_MEMORY = {
  last_updated: null,
  lead_profile: { interests: [], lead_stage: "new", objections: [], communication_style: "unknown", qualification_score: 0 },
  sales_intelligence: { pain_points: [], next_best_action: "qualify", budget_indication: "unknown" },
  interaction_summary: { last_contact_reason: "", total_conversations: 0 },
  conversation_history: [] as any[],
};

const TOOL = {
  name: "update_memory_insights",
  description: "Registra a inteligencia de vendas extraida da conversa mais recente com o cliente.",
  input_schema: {
    type: "object",
    properties: {
      interests: { type: "array", items: { type: "string" }, description: "Interesses do cliente (max 5)." },
      pain_points: { type: "array", items: { type: "string" }, description: "Dores/problemas citados (max 5)." },
      objections: { type: "array", items: { type: "string" }, description: "Objecoes levantadas (max 5)." },
      qualification_score: { type: "integer", description: "0-100: quao pronto para aceitar a oferta." },
      lead_stage: { type: "string", enum: ["new", "engaged", "qualified", "customer", "lost"] },
      communication_style: { type: "string", enum: ["direct", "formal", "casual", "unknown"] },
      budget_indication: { type: "string", enum: ["unknown", "low", "medium", "high"] },
      next_best_action: { type: "string", enum: ["qualify", "offer", "followup", "close", "nurture", "handoff"] },
      last_contact_reason: { type: "string", description: "Motivo do ultimo contato (max 100 chars)." },
      user_summary: { type: "string", description: "Resumo do que o cliente disse (max 200 chars)." },
      ai_action: { type: "string", description: "Resumo do que a Velma respondeu/fez (max 200 chars)." },
    },
    required: ["qualification_score", "user_summary", "ai_action"],
    additionalProperties: false,
  },
};

const uni = (a: any[], b: any[], cap: number) =>
  [...new Set([...(a || []), ...(b || [])].map((s) => String(s).trim()).filter(Boolean))].slice(0, cap);

Deno.serve(async (req) => {
  if (req.headers.get("x-velma-key") !== WORKER_SECRET) return json({ erro: "nao autorizado" }, 401);
  if (!ANTHROPIC_KEY) return json({ skipped: "sem ANTHROPIC_API_KEY" });

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const canon = String(body?.telefone_canon ?? "").replace(/\D/g, "");
  if (!canon) return json({ erro: "telefone_canon ausente" }, 400);

  try {
    const cfg = (await pg("velma_settings?select=model_classificacao&limit=1"))?.[0] ?? {};
    const model = cfg.model_classificacao || "claude-haiku-4-5";

    const hist = (await pg(`mensagens?telefone_canon=eq.${encodeURIComponent(canon)}&select=autor,direcao,texto,criado_em&order=criado_em.desc&limit=12`)) ?? [];
    hist.reverse();
    if (!hist.length) return json({ skipped: "sem historico" });
    const convo = hist.map((m: any) => `${(m.autor === "cliente" || m.direcao === "in") ? "CLIENTE" : "VELMA"}: ${(m.texto || "").trim()}`).join("\n");

    const prevRow = (await pg(`client_memory?telefone_canon=eq.${encodeURIComponent(canon)}&select=memory&limit=1`))?.[0];
    const prev = prevRow?.memory ?? DEFAULT_MEMORY;

    // Extrai insights (tool forcada)
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 700,
        tool_choice: { type: "tool", name: "update_memory_insights" },
        tools: [TOOL],
        system: "Voce analisa uma conversa de WhatsApp entre a atendente Velma (Valenet) e um cliente e extrai inteligencia de vendas para memoria interna. Seja conservador: se nao houver evidencia, use listas vazias ou 'unknown'. Responda SEMPRE chamando a tool update_memory_insights.",
        messages: [{ role: "user", content: `MEMORIA ATUAL:\n${JSON.stringify(prev)}\n\nCONVERSA RECENTE:\n${convo}` }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return json({ erro: "anthropic", detalhe: JSON.stringify(data?.error ?? data).slice(0, 200) }, 502);
    const use = (data?.content ?? []).find((b: any) => b?.type === "tool_use");
    const ins = use?.input ?? {};

    // Merge
    const lp = { ...(prev.lead_profile || {}) };
    lp.interests = uni(lp.interests, ins.interests, 8);
    lp.objections = uni(lp.objections, ins.objections, 8);
    if (typeof ins.qualification_score === "number") lp.qualification_score = Math.max(0, Math.min(100, ins.qualification_score));
    if (ins.communication_style) lp.communication_style = ins.communication_style;
    lp.lead_stage = ins.lead_stage || (lp.qualification_score > 70 ? "qualified" : lp.qualification_score > 40 ? "engaged" : "new");

    const si = { ...(prev.sales_intelligence || {}) };
    si.pain_points = uni(si.pain_points, ins.pain_points, 8);
    if (ins.next_best_action) si.next_best_action = ins.next_best_action;
    if (ins.budget_indication) si.budget_indication = ins.budget_indication;

    const is_ = { ...(prev.interaction_summary || {}) };
    is_.total_conversations = (is_.total_conversations || 0) + 1;
    if (ins.last_contact_reason) is_.last_contact_reason = String(ins.last_contact_reason).slice(0, 100);

    const histArr = [...(prev.conversation_history || [])];
    histArr.push({ timestamp: new Date().toISOString(), user_summary: String(ins.user_summary || "").slice(0, 200), ai_action: String(ins.ai_action || "").slice(0, 200) });

    const memory = { last_updated: new Date().toISOString(), lead_profile: lp, sales_intelligence: si, interaction_summary: is_, conversation_history: histArr.slice(-10) };

    await pg("client_memory", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ telefone_canon: canon, memory, updated_at: new Date().toISOString() }) });
    return json({ ok: true, canon, lead_stage: lp.lead_stage, score: lp.qualification_score });
  } catch (e) {
    console.error("velma-analyze:", e);
    return json({ erro: "falha", detalhe: String(e).slice(0, 300) }, 500);
  }
});
