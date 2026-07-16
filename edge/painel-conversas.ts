// painel-conversas — lista de conversas ou o histórico de uma conversa (chat inbox).
// POST {}                  -> { conversas: [...] }
// POST { telefone: "..." } -> { telefone, mensagens: [...] }
// Acesso: usuário logado (Supabase Auth) na allowlist OPERADORES.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

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
async function pg(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return await r.json();
}
const canon = (p: string) => (p || "").replace(/\D/g, "").replace(/^(55\d{2})9(\d{8})$/, "$1$2");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await autorizado(req))) return json({ erro: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const tel = body?.telefone ? canon(String(body.telefone)) : null;

  try {
    if (tel) {
      const mensagens = await pg(`mensagens?telefone_canon=eq.${tel}&order=criado_em.asc&select=id,direcao,tipo,texto,status,simulado,operador,criado_em&limit=500`);
      return json({ telefone: tel, mensagens });
    }
    const conversas = await pg("vw_conversas?select=*&limit=100");
    return json({ conversas });
  } catch (e) {
    console.error("painel-conversas:", e);
    return json({ erro: "falha ao carregar conversas" }, 500);
  }
});
