// velma-grouper — debounce + agrupamento das mensagens recebidas -> fila_ia.
// Worker interno: exige Authorization: Bearer <service_role>. Disparado pelo webhook e/ou cron.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Segredo de autenticação worker->worker (header x-velma-key). Fallback p/ SB_KEY p/ não travar caso não configurado.
const WORKER_SECRET = Deno.env.get("VELMA_WORKER_SECRET") || SB_KEY;
// const STT_ENABLED: hook de transcrição de áudio (implementado na Fase 5, hoje desligado por settings).

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
  if (!r.ok) throw new Error(`pg ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : await r.json();
}

Deno.serve(async (req) => {
  if (req.headers.get("x-velma-key") !== WORKER_SECRET) return json({ erro: "nao autorizado" }, 401);

  // 1) Reivindica as linhas cujo debounce venceu (marca processed=true atomicamente)
  let rows: any[] = [];
  try { rows = (await pg("rpc/claim_fila_agrupamento", { method: "POST", body: JSON.stringify({ p_limit: 200 }) })) ?? []; }
  catch (e) { console.error("claim agrupamento:", e); return json({ erro: "claim falhou" }, 500); }

  let grupos = 0;
  if (rows.length) {
    // 2) Agrupa por telefone
    const porTel: Record<string, any[]> = {};
    for (const r of rows) (porTel[r.telefone_canon] ||= []).push(r);

    for (const [canon, items] of Object.entries(porTel)) {
      try {
        // 3) Se um humano assumiu a conversa no meio, não promove para a IA
        const status = await pg("rpc/velma_conv_status", { method: "POST", body: JSON.stringify({ p_canon: canon }) });
        if (status && status !== "velma") continue;
        // 4) Combina o conteúdo (STT entraria aqui quando habilitado)
        items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const combined = items.map((i) => (i.texto || "[áudio]")).join("\n");
        const tipo = items.some((i) => i.tipo === "audio") ? "audio" : "text";
        // 5) Promove para a fila da IA
        await pg("fila_ia", { method: "POST", body: JSON.stringify({ telefone_canon: canon, context_data: { combined_content: combined, grouped_count: items.length, tipo } }) });
        grupos++;
      } catch (e) { console.error("grouper grupo", canon, e); }
    }
    // 6) Dispara o orquestrador (existe a partir da Fase 2; ignora erro se ainda não deployado)
    if (grupos) fireBg(fetch(`${SB_URL}/functions/v1/velma-orchestrator`, { method: "POST", headers: { "x-velma-key": WORKER_SECRET, "content-type": "application/json" }, body: "{}" }).then(() => {}).catch(() => {}));
  }

  // 7) Auto-reschedule: se há debounce ainda em contagem, reinvoca este worker perto do vencimento
  try {
    const up = await pg("fila_agrupamento?select=process_after&processed=eq.false&order=process_after.asc&limit=1");
    if (up && up[0]) {
      const wait = Math.min(new Date(up[0].process_after).getTime() - Date.now() + 500, 30000);
      if (wait > 0) fireBg((async () => { await sleep(wait); await fetch(`${SB_URL}/functions/v1/velma-grouper`, { method: "POST", headers: { "x-velma-key": WORKER_SECRET } }).catch(() => {}); })());
    }
  } catch (e) { console.error("reschedule:", e); }

  return json({ claimed: rows.length, grupos });
});
