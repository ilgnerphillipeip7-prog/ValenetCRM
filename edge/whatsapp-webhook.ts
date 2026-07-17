// whatsapp-webhook — verificação (GET) + status/respostas (POST) da Meta.
//  - Inbox (mensagens) + classificação da campanha + fan-out + assinatura HMAC.
//  - Ingestão da Velma: enfileira em fila_agrupamento (debounce) quando a IA está ligada,
//    o telefone está na base (Clientes) e a conversa está em modo 'velma'.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("VELMA_WORKER_SECRET") || SB_KEY;
const VERIFY = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CLASSIFIER_MODEL = Deno.env.get("CLASSIFIER_MODEL") ?? "claude-haiku-4-5";
const ST_MAP: Record<string, string> = { sent: "enviado", delivered: "entregue", read: "lido", failed: "falhou" };
const FANOUT = (Deno.env.get("WEBHOOK_FANOUT_URLS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function ctEq(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}
async function verifySig(raw: string, header: string | null): Promise<boolean> {
  if (!APP_SECRET || !header || !header.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const hex = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return ctEq(hex, header);
}
function fireBg(p: Promise<unknown>) {
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === "function") wu(p); else void Promise.resolve(p).catch(() => {});
}
const canon = (p: string) => (p || "").replace(/\D/g, "").replace(/^(55\d{2})9(\d{8})$/, "$1$2");
async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : await r.json();
}
async function velmaCfg(): Promise<{ is_active: boolean; debounce_seconds: number }> {
  try { const s = await pg("velma_settings?select=is_active,debounce_seconds&limit=1"); const r = s?.[0]; return { is_active: !!r?.is_active, debounce_seconds: r?.debounce_seconds ?? 10 }; }
  catch { return { is_active: false, debounce_seconds: 10 }; }
}

function classifyKeyword(text: string): string {
  const t = (text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const handoff = /(cancel|portab|reclam|problema|piora|lenta|caiu|sem sinal|nao funciona|negoci|desconto|barat|outro valor|humano|atendente|advogad|processo|ligar|telefone|duvida|nao entendi|nao sei|sei nao|talvez|depois|nao decidi)/;
  const recusa = /\b(nao|nao quero|nao tenho interesse|sem interesse|recuso|dispenso|pare|parar|sair)\b/;
  const aceite = /\b(sim|quero|aceito|aceita|aceitar|ok|pode|pode ativar|bora|confirmo|tenho interesse|interesse|ativa|ativar)\b/;
  if (handoff.test(t)) return "handoff_humano";
  if (recusa.test(t)) return "recusa";
  if (aceite.test(t)) return "aceite";
  return "handoff_humano";
}
async function classifyClaude(text: string): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  const sys = "Você classifica a resposta de um cliente a uma oferta de internet (+200MB por R$12,90) por WhatsApp. Responda APENAS uma palavra: ACEITE, RECUSA ou HANDOFF (dúvida, reclamação, cancelamento, negociação, ou qualquer coisa que não seja sim/não objetivo).";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: CLASSIFIER_MODEL, max_tokens: 16, system: sys, messages: [{ role: "user", content: text }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const out = String(d?.content?.[0]?.text ?? "").toUpperCase();
    if (out.includes("ACEITE")) return "aceite";
    if (out.includes("RECUSA")) return "recusa";
    if (out.includes("HANDOFF")) return "handoff_humano";
    return null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY && ctEq(token, VERIFY)) return new Response(challenge ?? "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (APP_SECRET) {
    if (!(await verifySig(raw, sig))) return new Response("assinatura invalida", { status: 403 });
  } else if (MODE === "live") {
    return new Response("webhook exige WHATSAPP_APP_SECRET em producao", { status: 403 });
  }

  if (FANOUT.length) {
    const fwd = async () => {
      await Promise.allSettled(FANOUT.map((u) =>
        fetch(u, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) }, body: raw, signal: AbortSignal.timeout(8000) })
          .catch((e) => console.error("fanout", u, String(e)))));
    };
    const wu = (globalThis as any).EdgeRuntime?.waitUntil;
    if (typeof wu === "function") wu(fwd()); else await fwd();
  }

  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return new Response("ok", { status: 200 }); }

  const vcfg = await velmaCfg();
  let enfileirou = false;

  try {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const v = change?.value ?? {};
        for (const st of v?.statuses ?? []) {
          if (!st?.id || !st?.status) continue;
          const mapped = ST_MAP[st.status] ?? st.status;
          await pg("rpc/rpc_atualizar_status_wa", { method: "POST", body: JSON.stringify({ p_wa_message_id: st.id, p_status: st.status }) }).catch(() => {});
          await pg(`mensagens?wa_message_id=eq.${encodeURIComponent(st.id)}`, { method: "PATCH", body: JSON.stringify({ status: mapped }) }).catch(() => {});
        }
        for (const msg of v?.messages ?? []) {
          const from = msg?.from ? String(msg.from) : null;
          const texto = msg?.text?.body ?? msg?.button?.text ?? msg?.interactive?.button_reply?.title ?? "";
          if (!from) continue;
          const tipo = msg?.type ?? "text";
          await pg("mensagens", { method: "POST", body: JSON.stringify({ telefone_e164: from, direcao: "in", autor: "cliente", tipo, texto, wa_message_id: msg?.id ?? null, status: "recebida" }) }).catch((e) => console.error("inbox insert:", e));
          const resposta = (await classifyClaude(texto)) ?? classifyKeyword(texto);
          await pg("rpc/rpc_registrar_resposta", { method: "POST", body: JSON.stringify({ p_telefone: from, p_resposta: resposta, p_texto: texto }) }).catch(() => {});

          // --- Ingestão da Velma (só se ligada, na base e conversa em modo velma) ---
          if (vcfg.is_active) {
            try {
              const c = canon(from);
              const cod = await pg("rpc/cliente_por_telefone_canon", { method: "POST", body: JSON.stringify({ p_canon: c }) });
              if (cod) {
                const status = await pg("rpc/velma_conv_status", { method: "POST", body: JSON.stringify({ p_canon: c }) });
                if (status === "velma") {
                  const pa = new Date(Date.now() + (vcfg.debounce_seconds || 10) * 1000).toISOString();
                  await pg(`fila_agrupamento?telefone_canon=eq.${encodeURIComponent(c)}&processed=eq.false`, { method: "PATCH", body: JSON.stringify({ process_after: pa }) }).catch(() => {});
                  await pg("fila_agrupamento", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ wa_message_id: msg?.id ?? null, telefone_canon: c, texto, tipo, message_data: msg, process_after: pa }) });
                  enfileirou = true;
                }
              }
            } catch (e) { console.error("velma enqueue:", e); }
          }
        }
      }
    }
  } catch (e) {
    console.error("whatsapp-webhook:", e);
  }

  if (enfileirou) fireBg(fetch(`${SB_URL}/functions/v1/velma-grouper`, { method: "POST", headers: { "x-velma-key": WORKER_SECRET } }).catch(() => {}));
  return new Response("ok", { status: 200 });
});
