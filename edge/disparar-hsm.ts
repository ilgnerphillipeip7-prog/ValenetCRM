// disparar-hsm — reserva um lote de elegíveis e envia o HSM (ou simula).
// Guardrails reforçados no banco (rpc_reservar_lote). Nasce em modo simulação.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PANEL_TOKEN = Deno.env.get("PANEL_TOKEN") ?? "";
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const WA_TEMPLATE = Deno.env.get("WHATSAPP_TEMPLATE_NAME") ?? "";
const WA_LANG = Deno.env.get("WHATSAPP_TEMPLATE_LANG") ?? "pt_BR";
const GRAPH = "https://graph.facebook.com/v21.0";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

function ctEq(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
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
  const auth = req.headers.get("authorization") ?? "";
  if (!PANEL_TOKEN || !ctEq(auth, `Bearer ${PANEL_TOKEN}`)) return json({ erro: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio ok */ }
  let limite = Number(body?.limite ?? 25);
  if (!Number.isFinite(limite) || limite < 1) limite = 25;
  limite = Math.min(limite, 200);

  const waReady = !!(WA_TOKEN && WA_PHONE_ID && WA_TEMPLATE);
  // Live só quando o servidor está em live E as credenciais existem. O corpo NÃO pode forçar live.
  const modo = (MODE === "live" && waReady) ? "live" : "simulation";

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
        const payload = {
          messaging_product: "whatsapp",
          to: row.telefone_e164,
          type: "template",
          template: { name: WA_TEMPLATE, language: { code: WA_LANG } },
        };
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
        await new Promise((res) => setTimeout(res, 300)); // throttle leve (rate limit Meta)
      }
    } catch (e) {
      falhas++;
      try { await pg("rpc/rpc_marcar_disparo", { method: "POST", body: JSON.stringify({ p_id: row.id, p_status: "falhou", p_erro: String(e).slice(0, 500), p_simulado: modo === "simulation" }) }); } catch { /* ignora */ }
      detalhes.push({ id: row.id, status: "falhou", erro: String(e).slice(0, 300) });
    }
  }
  return json({ modo, reservados: lote.length, enviados, falhas, detalhes });
});
