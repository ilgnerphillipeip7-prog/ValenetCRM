// whatsapp-webhook — verificação (GET) + status/respostas (POST) da Meta.
//  - Alimenta o INBOX (tabela mensagens): grava cada mensagem recebida e atualiza status.
//  - Mantém a CAMPANHA: classifica respostas (aceite/recusa/handoff) via rpc_registrar_resposta.
//  - Assinatura HMAC (X-Hub-Signature-256) validada quando WHATSAPP_APP_SECRET existe; fail-closed em produção.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
const MODE = (Deno.env.get("DISPATCH_MODE") ?? "simulation").toLowerCase();
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CLASSIFIER_MODEL = Deno.env.get("CLASSIFIER_MODEL") ?? "claude-haiku-4-5";
const ST_MAP: Record<string, string> = { sent: "enviado", delivered: "entregue", read: "lido", failed: "falhou" };

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

  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return new Response("ok", { status: 200 }); }

  try {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const v = change?.value ?? {};
        // Status de entrega -> atualiza campanha + inbox
        for (const st of v?.statuses ?? []) {
          if (!st?.id || !st?.status) continue;
          const mapped = ST_MAP[st.status] ?? st.status;
          await pg("rpc/rpc_atualizar_status_wa", { method: "POST", body: JSON.stringify({ p_wa_message_id: st.id, p_status: st.status }) }).catch(() => {});
          await pg(`mensagens?wa_message_id=eq.${encodeURIComponent(st.id)}`, { method: "PATCH", body: JSON.stringify({ status: mapped }) }).catch(() => {});
        }
        // Mensagens recebidas -> grava no inbox + classifica p/ campanha
        for (const msg of v?.messages ?? []) {
          const from = msg?.from ? String(msg.from) : null;
          const texto = msg?.text?.body ?? msg?.button?.text ?? msg?.interactive?.button_reply?.title ?? "";
          if (!from) continue;
          const tipo = msg?.type ?? "text";
          await pg("mensagens", { method: "POST", body: JSON.stringify({ telefone_e164: from, direcao: "in", tipo, texto, wa_message_id: msg?.id ?? null, status: "recebida" }) }).catch((e) => console.error("inbox insert:", e));
          const resposta = (await classifyClaude(texto)) ?? classifyKeyword(texto);
          await pg("rpc/rpc_registrar_resposta", { method: "POST", body: JSON.stringify({ p_telefone: from, p_resposta: resposta, p_texto: texto }) }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("whatsapp-webhook:", e);
  }
  return new Response("ok", { status: 200 });
});
