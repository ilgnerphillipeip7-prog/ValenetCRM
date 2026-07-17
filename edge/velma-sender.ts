// velma-sender — consome fila_envio e envia via WhatsApp Cloud API (texto).
// Registra a saida em mensagens (autor='velma'), respeita janela de 24h e faz retry.
// Auto-reschedule (como o grouper) enquanto houver itens agendados — dispensa cron.
// Worker interno: auth por header x-velma-key == VELMA_WORKER_SECRET (fallback SB_KEY).
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("VELMA_WORKER_SECRET") || SB_KEY;
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_RETRY = 3;

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fireBg(p: Promise<unknown>) {
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === "function") wu(p); else void Promise.resolve(p).catch(() => {});
}
async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null; // PostgREST devolve 201 com corpo vazio em inserts
}

// Destino real = ultimo telefone_e164 de ENTRADA do cliente (o wa_id que ele usou).
async function destino(canon: string): Promise<{ to: string; janela_aberta: boolean }> {
  try {
    const ins = await pg(`mensagens?telefone_canon=eq.${encodeURIComponent(canon)}&direcao=eq.in&select=telefone_e164,criado_em&order=criado_em.desc&limit=1`);
    const row = ins?.[0];
    const to = row?.telefone_e164 ? String(row.telefone_e164).replace(/\D/g, "") : canon;
    const aberta = !!row?.criado_em && (Date.now() - new Date(row.criado_em).getTime() < 24 * 3600 * 1000);
    return { to, janela_aberta: aberta };
  } catch { return { to: canon, janela_aberta: false }; }
}

async function enviarWhats(to: string, texto: string): Promise<{ wa_id: string | null; status: string; erro: string | null; simulado: boolean }> {
  const waReady = !!(WA_TOKEN && WA_PHONE_ID);
  if (!(MODE === "live" && waReady)) return { wa_id: `SIMOUT-${Date.now()}`, status: "enviado", erro: null, simulado: true };
  try {
    const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: texto } }),
    });
    const data = await r.json();
    if (r.ok && data?.messages?.[0]?.id) return { wa_id: data.messages[0].id, status: "enviado", erro: null, simulado: false };
    return { wa_id: null, status: "falhou", erro: JSON.stringify(data?.error ?? data).slice(0, 400), simulado: false };
  } catch (e) { return { wa_id: null, status: "falhou", erro: String(e).slice(0, 400), simulado: false }; }
}

async function processItem(item: any): Promise<void> {
  const canon = item.telefone_canon;
  const texto = (item.texto ?? "").trim();
  if (!texto) { await pg(`fila_envio?id=eq.${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "completed", sent_at: new Date().toISOString() }) }); return; }

  const { to, janela_aberta } = await destino(canon);
  if (!janela_aberta) { // fora da janela de 24h nao ha texto livre — requer template (HSM)
    await pg(`fila_envio?id=eq.${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", error_message: "janela de 24h fechada (requer template HSM)", updated_at: new Date().toISOString() }) });
    return;
  }

  const res = await enviarWhats(to, texto);
  // Registra a saida no inbox (historico da Velma)
  await pg("mensagens", { method: "POST", body: JSON.stringify({ telefone_e164: to, direcao: "out", autor: "velma", tipo: "text", texto, wa_message_id: res.wa_id, status: res.status, simulado: res.simulado }) }).catch((e) => console.error("sender inbox:", e));

  if (res.status === "enviado") {
    await pg(`fila_envio?id=eq.${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "completed", sent_at: new Date().toISOString(), wa_message_id: res.wa_id }) });
  } else {
    const n = (item.retry_count ?? 0) + 1;
    const patch = n < MAX_RETRY
      ? { status: "pending", retry_count: n, error_message: res.erro, scheduled_at: new Date(Date.now() + 30000).toISOString(), updated_at: new Date().toISOString() }
      : { status: "failed", retry_count: n, error_message: res.erro, updated_at: new Date().toISOString() };
    await pg(`fila_envio?id=eq.${item.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-velma-key") !== WORKER_SECRET) return json({ erro: "nao autorizado" }, 401);

  let items: any[] = [];
  try { items = (await pg("rpc/claim_fila_envio", { method: "POST", body: JSON.stringify({ p_limit: 10 }) })) ?? []; }
  catch (e) { console.error("claim fila_envio:", e); return json({ erro: "claim falhou" }, 500); }

  let ok = 0;
  for (const item of items) { // sequencial: preserva a ordem dos chunks e evita rajada
    try { await processItem(item); ok++; } catch (e) { console.error("sender item", item.id, e); }
  }

  // Auto-reschedule: se ainda ha itens pendentes (inclusive chunks agendados no futuro), reinvoca perto do vencimento.
  try {
    const up = await pg("fila_envio?select=scheduled_at&status=eq.pending&order=scheduled_at.asc&limit=1");
    if (up && up[0]) {
      const wait = Math.min(Math.max(new Date(up[0].scheduled_at).getTime() - Date.now(), 0) + 300, 30000);
      fireBg((async () => { await sleep(wait); await fetch(`${SB_URL}/functions/v1/velma-sender`, { method: "POST", headers: { "x-velma-key": WORKER_SECRET } }).catch(() => {}); })());
    }
  } catch (e) { console.error("sender reschedule:", e); }

  return json({ claimed: items.length, enviados: ok });
});
