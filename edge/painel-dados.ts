// painel-dados — KPIs do funil + preview de elegíveis + resultados recentes.
// Acesso: exige usuário logado (Supabase Auth) cujo e-mail esteja em OPERADORES.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
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

// Autoriza somente usuários logados (Supabase Auth) presentes na allowlist OPERADORES.
async function usuarioAutorizado(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const u = await r.json();
    if (!u?.id) return false;
    const email = String(u.email ?? "").toLowerCase();
    if (OPERADORES.length && !OPERADORES.includes(email)) return false; // fora da lista -> nega
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
  if (!(await usuarioAutorizado(req))) return json({ erro: "nao autorizado" }, 401);
  try {
    const funil = (await pg("vw_funil_campanha?select=*"))?.[0] ?? {};
    const elegiveis = await pg("vw_elegiveis_preview?select=*&limit=100");
    const recentes = await pg("vw_resultados_recentes?select=*&limit=50");
    const modo = (MODE === "live" && waReady) ? "live" : "simulation";
    const avisos: string[] = [];
    if (!waReady) avisos.push("WhatsApp nao configurado — disparo somente em SIMULACAO.");
    if (modo === "simulation") avisos.push("Modo SIMULACAO ativo: nenhuma mensagem real e enviada.");
    return json({ funil, elegiveis, recentes, config: { modo, whatsapp_configurado: waReady, template: WA_TEMPLATE || null, meta_taxa_aceite: 20 }, avisos });
  } catch (e) {
    console.error("painel-dados:", e);
    return json({ erro: "falha ao carregar dados" }, 500);
  }
});
