// painel-dados — KPIs do funil + preview de elegíveis + resultados recentes.
// Reporta estado REAL: chat (envio de respostas) vs campanha (disparo em massa) são independentes.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const WA_TEMPLATE = Deno.env.get("WHATSAPP_TEMPLATE_NAME") ?? "";
const CAMPANHA_LIVE = (Deno.env.get("CAMPANHA_LIVE") ?? "").toLowerCase() === "true";
const chatLive = MODE === "live" && !!WA_TOKEN && !!WA_PHONE;
const campanhaLive = chatLive && CAMPANHA_LIVE; // o template e escolhido no painel a cada disparo

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
async function pg(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await autorizado(req))) return json({ erro: "nao autorizado" }, 401);
  try {
    const funil = (await pg("vw_funil_campanha?select=*"))?.[0] ?? {};
    const elegiveis = await pg("vw_elegiveis_preview?select=*&limit=100");
    const recentes = await pg("vw_resultados_recentes?select=*&limit=50");
    const avisos: string[] = [];
    if (!chatLive) avisos.push("Modo SIMULACAO: nenhuma mensagem real e enviada.");
    else avisos.push("Chat em LIVE: respostas no inbox sao enviadas de verdade pelo WhatsApp.");
    if (chatLive && !campanhaLive) avisos.push("Disparo em massa em SIMULACAO: defina CAMPANHA_LIVE=true para enviar de verdade.");
    else if (campanhaLive) avisos.push("Campanha em LIVE: o disparo em massa envia templates reais aos elegiveis.");
    return json({
      funil, elegiveis, recentes,
      config: { modo: chatLive ? "live" : "simulation", chat_live: chatLive, campanha_live: campanhaLive, whatsapp_configurado: !!(WA_TOKEN && WA_PHONE), template: WA_TEMPLATE || null, meta_taxa_aceite: 20 },
      avisos,
    });
  } catch (e) {
    console.error("painel-dados:", e);
    return json({ erro: "falha ao carregar dados" }, 500);
  }
});
