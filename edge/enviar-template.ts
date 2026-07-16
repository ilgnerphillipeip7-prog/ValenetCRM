// enviar-template — envia uma mensagem de TEMPLATE (HSM) aprovado para um número.
// Permitido FORA da janela de 24h (é assim que se reabre a conversa). Preenche variáveis.
// Acesso: usuário logado (Supabase Auth) na allowlist OPERADORES.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const WA_LANG = Deno.env.get("WHATSAPP_TEMPLATE_LANG") ?? "pt_BR";
const GRAPH = "https://graph.facebook.com/v21.0";

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
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "metodo nao permitido" }, 405);
  const user = await getUser(req);
  if (!user) return json({ erro: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const to = String(body?.telefone ?? "").replace(/\D/g, "");
  const templateName = String(body?.template_name ?? "").trim();
  const language = String(body?.language ?? WA_LANG);
  const variaveis: string[] = Array.isArray(body?.variaveis) ? body.variaveis.map((x: unknown) => String(x)) : [];
  const preview = String(body?.preview ?? "").trim();
  if (!to) return json({ erro: "telefone ausente" }, 400);
  if (!templateName) return json({ erro: "template_name ausente" }, 400);

  const texto = preview || `[template: ${templateName}]${variaveis.length ? " " + variaveis.join(" | ") : ""}`;
  const waReady = !!(WA_TOKEN && WA_PHONE_ID);
  const modo = (MODE === "live" && waReady) ? "live" : "simulation";
  let wa_id: string | null = null, status = "enviado", simulado = false, erroEnvio: string | null = null;

  if (modo === "simulation") {
    simulado = true; wa_id = `SIMTPL-${Date.now()}`;
  } else {
    const components = variaveis.length ? [{ type: "body", parameters: variaveis.map((v) => ({ type: "text", text: v })) }] : [];
    try {
      const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: language }, components } }),
      });
      const data = await r.json();
      if (r.ok && data?.messages?.[0]?.id) { wa_id = data.messages[0].id; status = "enviado"; }
      else { status = "falhou"; erroEnvio = JSON.stringify(data?.error ?? data).slice(0, 400); }
    } catch (e) { status = "falhou"; erroEnvio = String(e).slice(0, 400); }
  }

  try {
    const row = await pg("mensagens", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ telefone_e164: to, direcao: "out", tipo: "template", texto, wa_message_id: wa_id, status, simulado, operador: user.email }),
    });
    return json({ ok: status !== "falhou", modo, mensagem: row?.[0] ?? null, erro_envio: erroEnvio });
  } catch (e) {
    console.error("enviar-template persist:", e);
    return json({ erro: "falha ao registrar mensagem" }, 500);
  }
});
