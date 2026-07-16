// enviar-mensagem — envia texto livre (sessão) para uma conversa via WhatsApp Cloud API.
// Regra da Meta: texto livre só dentro da janela de 24h desde a última mensagem do cliente.
// Acesso: usuário logado (Supabase Auth) na allowlist OPERADORES.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
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
const canon = (p: string) => (p || "").replace(/\D/g, "").replace(/^(55\d{2})9(\d{8})$/, "$1$2");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "metodo nao permitido" }, 405);
  const user = await getUser(req);
  if (!user) return json({ erro: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const to = String(body?.telefone ?? "").replace(/\D/g, "");
  const texto = String(body?.texto ?? "").trim();
  if (!to) return json({ erro: "telefone ausente" }, 400);
  if (!texto) return json({ erro: "texto vazio" }, 400);
  const c = canon(to);

  // Janela de 24h: precisa de uma mensagem recebida do cliente nas últimas 24h.
  let aberta = false;
  try {
    const ins = await pg(`mensagens?telefone_canon=eq.${c}&direcao=eq.in&order=criado_em.desc&limit=1&select=criado_em`);
    const last = ins?.[0]?.criado_em;
    aberta = !!last && (Date.now() - new Date(last).getTime() < 24 * 3600 * 1000);
  } catch (_e) { aberta = false; }
  if (!aberta) return json({ erro: "janela de 24h fechada — inicie o contato por um template (HSM), pois o WhatsApp nao permite texto livre fora dela." }, 409);

  const waReady = !!(WA_TOKEN && WA_PHONE_ID);
  const modo = (MODE === "live" && waReady) ? "live" : "simulation";
  let wa_id: string | null = null, status = "enviado", simulado = false, erroEnvio: string | null = null;

  if (modo === "simulation") {
    simulado = true; wa_id = `SIMOUT-${Date.now()}`;
  } else {
    try {
      const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: texto } }),
      });
      const data = await r.json();
      if (r.ok && data?.messages?.[0]?.id) { wa_id = data.messages[0].id; status = "enviado"; }
      else { status = "falhou"; erroEnvio = JSON.stringify(data?.error ?? data).slice(0, 400); }
    } catch (e) { status = "falhou"; erroEnvio = String(e).slice(0, 400); }
  }

  try {
    const row = await pg("mensagens", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ telefone_e164: to, direcao: "out", tipo: "text", texto, wa_message_id: wa_id, status, simulado, operador: user.email }),
    });
    return json({ ok: status !== "falhou", modo, mensagem: row?.[0] ?? null, erro_envio: erroEnvio });
  } catch (e) {
    console.error("enviar-mensagem persist:", e);
    return json({ erro: "falha ao registrar mensagem" }, 500);
  }
});
