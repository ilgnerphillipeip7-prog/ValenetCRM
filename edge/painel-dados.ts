// painel-dados — retorna KPIs do funil + preview de elegíveis + resultados recentes.
// Usa service_role no servidor (dados de cliente nunca vão ao navegador com telefone completo).
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PANEL_TOKEN = Deno.env.get("PANEL_TOKEN") ?? "";
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TEMPLATE = Deno.env.get("WHATSAPP_TEMPLATE_NAME") ?? "";
const waReady = !!(Deno.env.get("WHATSAPP_TOKEN") && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") && WA_TEMPLATE);

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

function ctEq(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}

async function pg(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const auth = req.headers.get("authorization") ?? "";
  if (!PANEL_TOKEN || !ctEq(auth, `Bearer ${PANEL_TOKEN}`)) return json({ erro: "nao autorizado" }, 401);

  try {
    const funil = (await pg("vw_funil_campanha?select=*"))?.[0] ?? {};
    const elegiveis = await pg("vw_elegiveis_preview?select=*&limit=100");
    const recentes = await pg("vw_resultados_recentes?select=*&limit=50");
    const modo = (MODE === "live" && waReady) ? "live" : "simulation";
    const avisos: string[] = [];
    if (!waReady) avisos.push("WhatsApp nao configurado — disparo somente em SIMULACAO.");
    if (modo === "simulation") avisos.push("Modo SIMULACAO ativo: nenhuma mensagem real e enviada.");
    return json({
      funil,
      elegiveis,
      recentes,
      config: { modo, whatsapp_configurado: waReady, template: WA_TEMPLATE || null, meta_taxa_aceite: 20 },
      avisos,
    });
  } catch (e) {
    console.error("painel-dados:", e);
    return json({ erro: "falha ao carregar dados" }, 500);
  }
});
