# Valenet CRM — Estrutura organizada no Supabase

Projeto `xijxklmnhoywlqqdxwvr`, schema `public`. Origem: tabela `Clientes` (1.000 linhas — **amostra**) e `MAILING - Clientes com Corretivas`.
Script fonte (idempotente): [`organizacao_supabase.sql`](organizacao_supabase.sql). Análise que embasou: [`ANALISE_base_vs_PRD.md`](ANALISE_base_vs_PRD.md).

## Objetos criados

**Funções**
| Função | Faz |
|---|---|
| `fn_norm_valor(text)` | "124,89" / "R$ 1.234,56" → `numeric` |
| `fn_tel_digits(bigint)` | normaliza telefone (remove DDI 55 se vier) |
| `fn_is_movel(bigint)` | `true` se celular (11 díg. com 9, ou 10 díg. antigo 6-9) |
| `fn_telefone_e164(bigint)` | `55`+DDD+número (adiciona 9º dígito quando falta) |
| `fn_touch_atualizado_em()` | trigger de `atualizado_em` |

**Views**
| View | Conteúdo |
|---|---|
| `stg_clientes` | camada tipada: valores numéricos, `telefone_e164`, `is_movel`, `renovar` bool |
| `vw_elegiveis_banda_extra` | elegíveis pela regra do sprint (**39** na amostra) |
| `vw_elegiveis_nao_contatados` | elegíveis ainda sem disparo `enviado` |
| `vw_funil_campanha` | KPIs: base → elegíveis → disparados → aceitos/recusas/sem_resposta/handoff + `taxa_aceite_pct` |

**Tabela** — `campanha_resultados` (RLS **ligado**; só `service_role`/`postgres` acessam)
`id, codcliente, codinst, telefone_e164, oferta_descricao, status_disparo(pendente|enviado|falhou), resposta(aceite|recusa|sem_resposta|handoff_humano), motivo_handoff, data_disparo, data_resposta, criado_em, atualizado_em`

## Regra de elegibilidade (desta versão)

`status_contrato='Ativo'` **E** `status_instalacao='ATIVADO'` **E** `tecnologia='GPON'` **E** `carteira='Varejo'` **E** `banda<=500` **E** `qtd_tit_nao_pagos<=1` **E** `meses_vigencia<=-9` **E** `total_mensal<=100` **E** `is_movel=true`.

- **Vigência:** sinal invertido — `meses_vigencia<=-9` = 9+ meses **fora** da fidelidade. _Knob:_ trocar para `<=-10` se "acima de 9" for estrito (editar `vw_elegiveis_banda_extra`).
- **Oferta:** fixa **+200MB por R$12,90** (colunas de sugestão personalizada ignoradas).
- **Guardrail "corretiva em aberto": SUSPENSO** (sem fonte no dado — a tabela MAILING é contagem de período, não "em aberto").

## Como consultar

```sql
select * from public.vw_elegiveis_banda_extra;   -- lista de elegíveis + oferta
select * from public.vw_funil_campanha;          -- KPIs do funil
```
REST (server-side, com `service_role`): `GET /rest/v1/vw_elegiveis_banda_extra?select=*`

## ⚠️ Ressalvas antes de disparar de verdade

1. **Base é amostra de 1.000** (não os ~220 mil).
2. **Telefones são placeholders:** os 39 elegíveis têm **só 2 números distintos**. **Não dispare** — é preciso base com contatos reais e únicos por cliente.
3. **Corretiva em aberto** segue sem fonte (guardrail suspenso — risco documentado).

## Próximos passos (fora desta entrega)

- Contatos reais/únicos por cliente.
- WhatsApp: número Business dedicado + **template HSM aprovado pela Meta** (categoria Marketing → custo por msg + opt-out) + **base legal LGPD**.
- Popular `campanha_resultados` no disparo e ligar dashboard em `vw_funil_campanha`.
- **Efetivação pós-aceite** (dono + SLA) — hoje só registra intenção.
- Reavaliar `Total` vs `HSTvalorPROD` no filtro de valor (impacto: 39 vs. bem mais).
- Perguntas em aberto do PRD ainda pendentes (janela de resposta/reenvio, fila de handoff, donos do projeto, acesso ao dashboard, tom/texto do HSM).
