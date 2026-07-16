# Valenet CRM — Painel + Disparo WhatsApp (integrado ao Supabase)

Painel HTML que **visualiza o funil** e **dispara a oferta HSM** (+200MB/R$12,90) pela **API oficial do WhatsApp (Meta Cloud API)**, com o motor todo no Supabase.

> **Estado atual: MODO SIMULAÇÃO.** Nada é enviado a clientes reais. Ver "Ir para produção".

## Arquitetura

```
dashboard.html (local)  --Bearer PANEL_TOKEN-->  Edge Functions (Supabase)  -->  Postgres (RPCs, views)
                                                       |                                  ^
                                                       +--(live) Meta Cloud API           |
Meta  --webhook (status + respostas)-->  whatsapp-webhook  --classifica-->  rpc_registrar_resposta
```

- **`painel-dados`** (Edge Function) — retorna KPIs do funil + preview de elegíveis (telefone mascarado) + resultados recentes. Exige `PANEL_TOKEN`.
- **`disparar-hsm`** (Edge Function) — reserva um lote de elegíveis (via `rpc_reservar_lote`, concorrência-segura) e envia o HSM (ou simula). Exige `PANEL_TOKEN`. Live só quando `DISPATCH_MODE=live` **e** os secrets do WhatsApp existem.
- **`whatsapp-webhook`** (Edge Function, pública) — recebe verificação (GET) e status/respostas (POST) da Meta; classifica **SIM=aceite / NÃO=recusa / resto=handoff_humano** (palavra-chave, com Claude opcional).
- **Banco:** `vw_elegiveis_banda_extra` (regra), `campanha_resultados` (RLS on), RPCs, e views mascaradas `vw_elegiveis_preview` / `vw_resultados_recentes`. Ver [organizacao_supabase.sql](organizacao_supabase.sql) e [organizacao_supabase_v2.sql](organizacao_supabase_v2.sql).

## Como usar o painel (agora, em simulação)

1. Abra **[painel/dashboard.html](painel/dashboard.html)** no navegador (duplo-clique; é um arquivo local).
2. Em **Conexão**, preencha:
   - **URL base:** `https://xijxklmnhoywlqqdxwvr.supabase.co/functions/v1`
   - **Panel token:** o valor de `PANEL_TOKEN` (está em [supabase.local.env](supabase.local.env)).
3. **Salvar e carregar** → vê o funil. Botão **Disparar lote** simula o envio para N elegíveis e atualiza o funil.

> O painel guarda URL+token só no `localStorage` do seu navegador. O token **não** fica embutido no HTML — se você compartilhar o arquivo, o token não vai junto.

## Valores e endpoints (em `supabase.local.env`)

| Item | Onde |
|---|---|
| `PANEL_TOKEN` | linha `PANEL_TOKEN=` |
| Webhook URL (p/ Meta) | `https://xijxklmnhoywlqqdxwvr.supabase.co/functions/v1/whatsapp-webhook` |
| Verify token (p/ Meta) | linha `WHATSAPP_VERIFY_TOKEN=` |

## Ir para produção (go-live WhatsApp) — checklist

1. **Meta / WhatsApp Cloud API:** ter WABA + **Phone Number ID**, **token permanente** (System User) e um **template HSM aprovado** (categoria Marketing → custo por msg + opt-out).
2. **Configurar os secrets** no Supabase (Dashboard → Edge Functions → Secrets, ou Management API):
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME`, (opcional) `WHATSAPP_TEMPLATE_LANG` (default `pt_BR`).
3. **Registrar o webhook** no app da Meta: URL acima + o `WHATSAPP_VERIFY_TOKEN`; assinar os eventos `messages`.
4. **Assinatura do webhook (segurança):** configurar `WHATSAPP_APP_SECRET` e habilitar a verificação de `X-Hub-Signature-256` (item de segurança — ver revisão).
5. **LGPD:** definir base legal e mecanismo de **opt-out** antes de qualquer disparo real.
6. **Dados reais:** a base atual é amostra com **telefones placeholder** (2 números distintos entre os 39 elegíveis). Trocar por contatos reais/únicos.
7. **Virar a chave:** setar `DISPATCH_MODE=live`. Só então o `disparar-hsm` envia de verdade (e o painel exige confirmação explícita).

### Classificação por Claude (opcional, alinhado à stack do PRD)
Setar `ANTHROPIC_API_KEY` (e opcional `CLASSIFIER_MODEL`, default `claude-haiku-4-5`) faz o webhook usar Claude para classificar respostas nuançadas ("não sei" → handoff), com fallback automático para palavra-chave.

## Deploy / re-deploy

Functions foram publicadas via Management API (porta 5432 do Postgres está bloqueada neste ambiente; só HTTPS passa). Código-fonte em [edge/](edge/). Para atualizar uma function, reenviar o `body` via `POST/PATCH /v1/projects/{ref}/functions[/{slug}]`.

## Segurança (revisão adversarial — hardening aplicado)

Uma revisão adversarial multi-agente apontou 12 pontos; os acionáveis foram corrigidos e re-deployados:

| Item | Sev | Status |
|---|---|---|
| `Clientes`/views/RPCs acessíveis pela **anon key** (PII via PostgREST) | Crítico | ✅ `REVOKE` de anon/authenticated; RPCs só `service_role` (validado: anon → HTTP 404 em `Clientes`) |
| Webhook sem assinatura **X-Hub-Signature-256** (POST forjável) | Alto | ✅ HMAC validado quando `WHATSAPP_APP_SECRET` existe; **fail-closed** em produção |
| Matching de telefone sem **9º dígito** (respostas BR perdidas) | Alto | ✅ normalização no `rpc_registrar_resposta` (validado) |
| Classificador: "não sei"→recusa; "para" falso-positivo | Médio | ✅ "não sei/talvez/…"→handoff; removido token "para" |
| Comparação de tokens não timing-safe | Baixo | ✅ comparação de tempo constante nas 3 functions |
| Detalhe de erro exposto ao cliente | Baixo | ✅ mensagem genérica; detalhe só nos logs |
| Linhas `pendente` órfãs travando recontato | Médio | ✅ reciclagem (>15 min) no `rpc_reservar_lote` |
| CORS `*` / service_role / token no HTML | Info | ✔ verificado seguro (auth por header; service_role não vaza; token não embutido) |

Migração aplicada: [organizacao_supabase_v3.sql](organizacao_supabase_v3.sql).

**Ainda para produção:** definir `WHATSAPP_APP_SECRET` (obrigatório p/ go-live — o webhook passa a exigir assinatura); rotacionar `PANEL_TOKEN`; opcional: tokens separados leitura×disparo e rate-limit por IP.

## ⚠️ Ressalvas
- **Não dispare em produção** sem: dados reais, template aprovado, LGPD e a verificação de assinatura do webhook.
- Rotacione as credenciais (service_role, senha do banco, PAT, PANEL_TOKEN) ao fim do sprint.
