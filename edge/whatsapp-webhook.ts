// whatsapp-webhook — verificação (GET) + status/respostas (POST) da Meta.
// Valida assinatura HMAC (X-Hub-Signature-256) quando WHATSAPP_APP_SECRET existe;
// em produção (DISPATCH_MODE=live) exige o secret (fail-closed).
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CLASSIFIER_MODEL = Deno.env.get("CLASSIFIER_MODEL") ?? "claude-haiku-4-5";

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

async function pg(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : await r.json();
}

// Classificação por palavra-chave (sempre disponível, sem dependência).
function classifyKeyword(text: string): string {
  const t = (text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  // Guardrail do PRD: cancelamento/reclamação/negociação/dúvida -> humano (testado primeiro).
  const handoff = /(cancel|portab|reclam|problema|piora|lenta|caiu|sem sinal|nao funciona|negoci|desconto|barat|outro valor|humano|atendente|advogad|processo|ligar|telefone|duvida|nao entendi|nao sei|sei nao|talvez|depois|nao decidi)/;
  const recusa = /\b(nao|nao quero|nao tenho interesse|sem interesse|recuso|dispenso|pare|parar|sair)\b/;
  const aceite = /\b(sim|quero|aceito|aceita|aceitar|ok|pode|pode ativar|bora|confirmo|tenho interesse|interesse|ativa|ativar)\b/;
  if (handoff.test(t)) return "handoff_humano";
  if (recusa.test(t)) return "recusa";
  if (aceite.test(t)) return "aceite";
  return "handoff_humano"; // não classificável -> humano (regra do PRD)
}

// Classificação opcional via Claude (Haiku por padrão) se ANTHROPIC_API_KEY existir.
// Só é chamada em produção quando a assinatura já foi validada, evitando abuso de custo.
async function classifyClaude(text: string): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  const sys = "Você classifica a resposta de um cliente a uma oferta de internet (+200MB por R$12,90) enviada por WhatsApp. Responda APENAS uma palavra: ACEITE (o cliente quer/aceita), RECUSA (não quer, sem interesse), ou HANDOFF (dúvida, reclamação, pedido de cancelamento, negociação de outro valor, ou qualquer coisa que não seja sim/não objetivo).";
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

  // Verificação do webhook (Meta faz GET com hub.challenge)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY && ctEq(token, VERIFY)) return new Response(challenge ?? "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  // Autenticidade do POST: assinatura HMAC da Meta
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (APP_SECRET) {
    if (!(await verifySig(raw, sig))) return new Response("assinatura invalida", { status: 403 });
  } else if (MODE === "live") {
    // Produção sem app secret = recusa (fail-closed). Configure WHATSAPP_APP_SECRET.
    return new Response("webhook exige WHATSAPP_APP_SECRET em producao", { status: 403 });
  }

  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return new Response("ok", { status: 200 }); }

  try {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const v = change?.value ?? {};
        for (const st of v?.statuses ?? []) {
          if (st?.id && st?.status) {
            await pg("rpc/rpc_atualizar_status_wa", { method: "POST", body: JSON.stringify({ p_wa_message_id: st.id, p_status: st.status }) });
          }
        }
        for (const msg of v?.messages ?? []) {
          const from = msg?.from ? String(msg.from) : null;
          const text = msg?.text?.body ?? msg?.button?.text ?? msg?.interactive?.button_reply?.title ?? "";
          if (!from) continue;
          const resposta = (await classifyClaude(text)) ?? classifyKeyword(text);
          await pg("rpc/rpc_registrar_resposta", { method: "POST", body: JSON.stringify({ p_telefone: from, p_resposta: resposta, p_texto: text }) });
        }
      }
    }
  } catch (e) {
    console.error("whatsapp-webhook:", e); // sempre 200 p/ a Meta não reenviar em loop
  }
  return new Response("ok", { status: 200 });
});
