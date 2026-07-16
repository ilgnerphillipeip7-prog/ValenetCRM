// disparar-hsm — reserva um lote de elegíveis e envia o HSM (ou simula).
// Acesso: exige usuário logado (Supabase Auth) cujo e-mail esteja em OPERADORES.
// Guardrails no banco (rpc_reservar_lote). Nasce em modo simulação.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPERADORES = (Deno.env.get("OPERADORES") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const WA_TEMPLATE = Deno.env.get("WHATSAPP_TEMPLATE_NAME") ?? "";
const WA_LANG = Deno.env.get("WHATSAPP_TEMPLATE_LANG") ?? "pt_BR";
// Trava extra do disparo EM MASSA: mesmo com DISPATCH_MODE=live, só envia de verdade
// se CAMPANHA_LIVE=true. Protege contra disparo acidental na base (ex.: dados de teste).
const CAMPANHA_LIVE = (Deno.env.get("CAMPANHA_LIVE") ?? "").toLowerCase() === "true";
const GRAPH = "https://graph.facebook.com/v21.0";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

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
    if (OPERADORES.length && !OPERADORES.includes(email)) return false;
    return true;
  } catch { return false; }
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
  if (!(await usuarioAutorizado(req))) return json({ erro: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio ok */ }
  let limite = Number(body?.limite ?? 25);
  if (!Number.isFinite(limite) || limite < 1) limite = 25;
  limite = Math.min(limite, 200);

  const waReady = !!(WA_TOKEN && WA_PHONE_ID && WA_TEMPLATE);
  const modo = (MODE === "live" && waReady && CAMPANHA_LIVE) ? "live" : "simulation";

  let lote: any[] = [];
  try {
    lote = (await pg("rpc/rpc_reservar_lote", { method: "POST", body: JSON.stringify({ p_limit: limite }) })) ?? [];
  } catch (e) {
    console.error("disparar-hsm reservar:", e);
    return json({ erro: "falha ao reservar lote" }, 500);
  }

  let enviados = 0, falhas = 0;
  const detalhes: any[] = [];
  for (const row of lote) {
    try {
      if (modo === "simulation") {
        const fake = `SIM-${row.id}-${row.codcliente}`;
        await pg("rpc/rpc_marcar_disparo", { method: "POST", body: JSON.stringify({ p_id: row.id, p_status: "enviado", p_wa_message_id: fake, p_erro: null, p_simulado: true }) });
        enviados++; detalhes.push({ id: row.id, codcliente: row.codcliente, status: "enviado", simulado: true });
      } else {
        const payload = { messaging_product: "whatsapp", to: row.telefone_e164, type: "template", template: { name: WA_TEMPLATE, language: { code: WA_LANG } } };
        const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (r.ok && data?.messages?.[0]?.id) {
          await pg("rpc/rpc_marcar_disparo", { method: "POST", body: JSON.stringify({ p_id: row.id, p_status: "enviado", p_wa_message_id: data.messages[0].id, p_erro: null, p_simulado: false }) });
          enviados++; detalhes.push({ id: row.id, codcliente: row.codcliente, status: "enviado", wa_id: data.messages[0].id });
        } else {
          const err = JSON.stringify(data?.error ?? data).slice(0, 500);
          await pg("rpc/rpc_marcar_disparo", { method: "POST", body: JSON.stringify({ p_id: row.id, p_status: "falhou", p_wa_message_id: null, p_erro: err, p_simulado: false }) });
          falhas++; detalhes.push({ id: row.id, codcliente: row.codcliente, status: "falhou", erro: err });
        }
        await new Promise((res) => setTimeout(res, 300));
      }
    } catch (e) {
      falhas++;
      try { await pg("rpc/rpc_marcar_disparo", { method: "POST", body: JSON.stringify({ p_id: row.id, p_status: "falhou", p_erro: String(e).slice(0, 500), p_simulado: modo === "simulation" }) }); } catch { /* ignora */ }
      detalhes.push({ id: row.id, status: "falhou", erro: String(e).slice(0, 300) });
    }
  }
  return json({ modo, reservados: lote.length, enviados, falhas, detalhes });
});
