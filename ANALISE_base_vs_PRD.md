# Análise da Base Real × PRD — Valenet CRM (Fidelização)

_Gerado a partir de conexão direta ao Supabase (projeto `xijxklmnhoywlqqdxwvr`), schema `public`._

## 1. Panorama da base

| Item | Valor |
|---|---|
| Tabelas | `Clientes` (89 colunas) e `MAILING - Clientes com Corretivas` (9 colunas) |
| Linhas em `Clientes` | **1.000** (amostra/extrato — não os ~220 mil da empresa) |
| Chave | `Clientes.CODCLIENTE` (PK); junção com MAILING por `codinst` |
| `Renovar?` | **VERDADEIRO em 100%** → base já pré-filtrada para renovação |
| `Carteira` | **Varejo em 100%** |

## 2. Funil de elegibilidade (critérios "limpos" via contagem real)

| Critério (PRD Seção 7) | Coluna | Passam |
|---|---|---:|
| Status contrato = Ativo | `StatusContrato` | 994 |
| Status instalação = ATIVADO | `StatusInstalacao` | 944 |
| Tecnologia = GPON | `tecnologia` | 931 |
| Carteira = Varejo | `Carteira` | 1000 |
| Velocidade ≤ 500 | `banda` | 638 (362 têm > 500) |
| Títulos não pagos ≤ 1 | `Qtd_Tit_Nao_Pagos` | 988 (12 têm > 1) |
| **Combinação dos acima** | — | **569** |

Faltam aplicar (não dá para filtrar direto na base como está): **valor ≤ R$100**, **telefone móvel + DDI** e **corretiva em aberto**.

## 3. Divergências críticas PRD × dados (precisam de decisão de negócio)

### 3.1 `MESESVIGENCIA` — a regra ">9 meses" zera a base
- Significado confirmado: **meses até o fim da vigência/fidelidade**. `0` = fidelidade acaba este mês; negativo = já acabou há N meses.
- Distribuição: `> 9` → **0** | `0 a 9` → 26 | `< 0` → 974 | mín/máx = **−230 / 0**.
- A base inteira está **≤ 0**. Aplicar ">9" literalmente = **0 elegíveis**.
- **Interpretação provável:** o alvo de renovação é quem **saiu/está saindo da fidelidade** (`MESESVIGENCIA ≤ 0`). Com os critérios limpos + `MESES < 0` → **556**.

### 3.2 Oferta: PRD (fixa) × banco (personalizada)
- PRD: oferta única "Banda Extra 200MB por R$12,90".
- Banco: `IDSugerido`, `PlanoSugerido` (R$119,99–149,99), `BandaSugerida` (200→1000MB; maioria 600/700/1000) — **upgrade de plano por cliente**, não um add-on de R$12,90.
- São **campanhas diferentes**. Definir qual é a real.

### 3.3 Valor "≤ R$100" — qual campo?
- `HSTvalorPROD` (só internet): min/méd/máx = 0,00 / 106,67 / 209,90 → **457 ≤ 100**.
- `Total` (fatura cheia c/ TV, telefone, add-ons): 0,00 / 136,88 / 274,84 → **141 ≤ 100**.
- Valores são **texto com vírgula decimal** ("124,89") → exigem conversão para número.

### 3.4 "Corretiva em aberto" (guardrail nº1) sem fonte
- Tabela MAILING = **contagem** de corretivas no período `2026-04-01 a 2026-06-25`, **inclui zeros** → não é "em aberto agora".
- Sem campo de "corretiva aberta" na base. Opções: usar `CORRETIVAS > 0` no período como **proxy**, buscar dado real (Helpdesk) ou suspender o guardrail nesta versão.

### 3.5 Telefone para WhatsApp
- `telefone_cliente` e `Telefone` são **idênticas** (redundância).
- 500 com **11 dígitos** (celular c/ 9º dígito) e 500 com **10 dígitos** (fixo ou celular antigo — suspeitos).
- **Nenhum tem DDI (+55)** → é preciso derivar formato E.164 (`55` + DDD + número) e validar "móvel". Risco de perder ~50% se os de 10 dígitos forem tratados como não-móvel.

## 4. Plano de organização proposto (após decisões)

1. **Camada tipada (staging)** — view que limpa a base:
   - `HSTvalorPROD`/`Total` texto → `numeric`.
   - `telefone` → `telefone_e164` (`55`+DDD+num) + `is_movel` (bool).
   - junta contagem de corretivas por `codinst` (proxy).
2. **View de elegíveis** — `vw_elegiveis_renovacao` aplicando a regra final (com as decisões 3.1–3.4).
3. **Tabela de resultados da campanha** — `campanha_resultados` (envio, resposta, handoff, timestamps).
4. **Views de dashboard** — funil (base → elegíveis → disparados → aceitos).

## 5. Decisões pendentes (bloqueiam a montagem)
- **A.** `MESESVIGENCIA`: alvo = fidelidade encerrada (`≤ 0`)? ou "tempo de casa > 9 meses"? ou outro limiar?
- **B.** Oferta: personalizada (`PlanoSugerido`) ou fixa (+200MB/R$12,90)?
- **C.** Valor ≤ R$100: sobre `HSTvalorPROD` ou `Total`?
- **D.** Corretiva em aberto: proxy (`CORRETIVAS>0`), dado real, ou suspender?
