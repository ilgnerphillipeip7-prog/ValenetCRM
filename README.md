# Valenet CRM — Fidelização da base

Painel + motor de **disparo de oferta (HSM) via WhatsApp** (Meta Cloud API), integrado ao **Supabase**. Oferta: +200MB por R$12,90 para clientes elegíveis.

- **Backend** (já implantado no Supabase, projeto `xijxklmnhoywlqqdxwvr`): 3 Edge Functions + RPCs + views. Ver [`supabase-backend`](#backend-supabase-já-implantado).
- **Front**: painel estático (`painel/dashboard.html`) — hospedado na **Vercel**.
- **Estado atual: SIMULAÇÃO** (nenhuma mensagem real é enviada).

> ⚠️ **Segredos não estão neste repositório.** `service_role`, senha do banco, PAT e `PANEL_TOKEN` ficam em `supabase.local.env` (no `.gitignore`). Nunca faça commit deles.

## Estrutura

```
painel/dashboard.html          # front (Vercel serve isto em "/")
edge/*.ts                      # código das Edge Functions (deploy no Supabase)
organizacao_supabase*.sql      # migrações (v1 base, v2 motor, v3 hardening)
docs/ (READMEs, análise)       # README_Painel_WhatsApp.md, README_Supabase_CRM.md, ANALISE_base_vs_PRD.md
vercel.json                    # rewrite: "/" -> painel/dashboard.html
```
(Os READMEs e a análise estão na raiz junto com os .sql; ver links abaixo.)

## Hospedar o front na Vercel

1. Faça o `git push` deste repo para o GitHub (ver abaixo).
2. Em **vercel.com/new**, importe `ilgnerphillipeip7-prog/ValenetCRM`.
3. **Framework Preset: Other** (é estático, sem build). Deixe build/output vazios.
4. Deploy. A `vercel.json` faz `/` abrir o painel.
5. Abra a URL da Vercel e **faça login** com seu e-mail e senha de operador. O dashboard aparece após o login.

> Acesso por **login (Supabase Auth)**: só e-mails na allowlist `OPERADORES` (secret no Supabase) entram; as Edge Functions rejeitam (401) quem não está logado ou não é operador. Nenhum segredo fica no front (só a *anon key*, que é pública por natureza). A sessão expira sozinha.

## Backend (Supabase, já implantado)

- Functions: `painel-dados`, `disparar-hsm`, `whatsapp-webhook` (código em [`edge/`](edge/)).
- SQL/migrações: [`organizacao_supabase.sql`](organizacao_supabase.sql) → [`_v2`](organizacao_supabase_v2.sql) → [`_v3`](organizacao_supabase_v3.sql) (hardening de segurança).
- Detalhes de uso e **go-live do WhatsApp**: [`README_Painel_WhatsApp.md`](README_Painel_WhatsApp.md).
- Organização da base e regra de elegibilidade: [`README_Supabase_CRM.md`](README_Supabase_CRM.md) e [`ANALISE_base_vs_PRD.md`](ANALISE_base_vs_PRD.md).

## Segurança / produção

- Segredos ficam como **Edge Function secrets** no Supabase (e em `supabase.local.env` localmente) — nunca no Git nem no front.
- Antes de disparo real: `WHATSAPP_APP_SECRET` (assinatura do webhook), template HSM aprovado, base legal LGPD/opt-out, dados reais, e `DISPATCH_MODE=live`.
- Rotacione as credenciais periodicamente.
