-- ============================================================================
-- Valenet CRM — Organização da base no Supabase (schema public)
-- Gerado a partir da análise base × PRD. Idempotente (pode rodar de novo).
--
-- Regra de elegibilidade desta versão (decisões do time):
--   status_contrato = 'Ativo'
--   status_instalacao = 'ATIVADO'
--   tecnologia = 'GPON'
--   carteira = 'Varejo'
--   banda <= 500
--   qtd_tit_nao_pagos <= 1
--   meses_vigencia <= -9        (9+ meses FORA da fidelidade; sinal invertido)
--   total_mensal <= 100         (campo Total = fatura completa)
--   is_movel = true             (telefone móvel; E.164 derivado com DDI 55)
-- Oferta: FIXA "+200MB por R$12,90" (colunas de sugestão personalizada ignoradas).
-- Guardrail "corretiva em aberto": SUSPENSO nesta versão (sem fonte no dado).
-- ============================================================================

-- ---------- 1. Funções utilitárias -----------------------------------------

-- Converte valor monetário em texto pt-BR ("1.234,56" / "124,89" / "R$ 99,90") para numeric
create or replace function public.fn_norm_valor(v text)
returns numeric language sql immutable as $$
  select nullif(
    regexp_replace(
      replace(replace(coalesce(v,''), '.', ''), ',', '.'),
      '[^0-9.-]', '', 'g'
    ), ''
  )::numeric
$$;

-- Normaliza telefone (remove DDI 55 se já vier) -> DDD+numero
create or replace function public.fn_tel_digits(v bigint)
returns text language sql immutable as $$
  select case
    when v is null then null
    when length(v::text) = 13 and left(v::text,2) = '55' then substring(v::text,3)
    else v::text
  end
$$;

-- É telefone móvel? (11 díg. com 9 após DDD, ou 10 díg. antigo iniciando 6-9)
create or replace function public.fn_is_movel(v bigint)
returns boolean language sql immutable as $$
  select case
    when t is null then false
    when length(t) = 11 and substring(t,3,1) = '9' then true
    when length(t) = 10 and substring(t,3,1) in ('6','7','8','9') then true
    else false
  end
  from (select public.fn_tel_digits(v) as t) d
$$;

-- Telefone em formato E.164 para WhatsApp (55 + DDD + numero, adiciona 9º dígito quando necessário)
create or replace function public.fn_telefone_e164(v bigint)
returns text language sql immutable as $$
  select case
    when t is null then null
    when length(t) = 11 and substring(t,3,1) = '9' then '55'||t
    when length(t) = 10 and substring(t,3,1) in ('6','7','8','9') then '55'||substring(t,1,2)||'9'||substring(t,3)
    when length(t) = 10 then '55'||t   -- fixo: guarda mas não é móvel
    else null
  end
  from (select public.fn_tel_digits(v) as t) d
$$;

-- ---------- 2. Camada tipada (staging) -------------------------------------

create or replace view public.stg_clientes as
select
  "CODCLIENTE"                              as codcliente,
  "codinst"                                 as codinst,
  "CODCONTRATO"                             as codcontrato,
  "NOME"                                    as nome,
  "CIDADE"                                  as cidade,
  "RegionalComercial"                       as regional_comercial,
  "Carteira"                                as carteira,
  "StatusContrato"                          as status_contrato,
  "StatusInstalacao"                        as status_instalacao,
  "tecnologia"                              as tecnologia,
  "banda"                                   as banda,
  "BandaSugerida"                           as banda_sugerida,
  "MESESVIGENCIA"                           as meses_vigencia,
  "VIGENCIA"                                as vigencia,
  "DataAtivacao"                            as data_ativacao,
  "Qtd_Tit_Nao_Pagos"                       as qtd_tit_nao_pagos,
  case
    when upper(coalesce("Renovar?",'')) in ('VERDADEIRO','TRUE','SIM') then true
    when upper(coalesce("Renovar?",'')) in ('FALSO','FALSE','NAO','NÃO') then false
    else null
  end                                       as renovar,
  public.fn_norm_valor("HSTvalorPROD")      as hst_valor_prod,
  public.fn_norm_valor("Total")             as total_mensal,
  "telefone_cliente"                        as telefone_raw,
  public.fn_telefone_e164("telefone_cliente") as telefone_e164,
  public.fn_is_movel("telefone_cliente")      as is_movel
from public."Clientes";

comment on view public.stg_clientes is
  'Camada tipada de Clientes: valores texto->numeric, telefone->E.164 + flag móvel.';

-- ---------- 3. Elegíveis da campanha (regra final) -------------------------

create or replace view public.vw_elegiveis_banda_extra as
select
  s.*,
  200                    as oferta_banda_extra_mb,
  12.90                  as oferta_valor,
  '+200MB por R$12,90'   as oferta_descricao
from public.stg_clientes s
where s.status_contrato   = 'Ativo'
  and s.status_instalacao = 'ATIVADO'
  and s.tecnologia        = 'GPON'
  and s.carteira          = 'Varejo'
  and s.banda            <= 500
  and s.qtd_tit_nao_pagos <= 1
  and s.meses_vigencia   <= -9      -- ajuste aqui se "acima de 9" for estrito (<= -10)
  and s.total_mensal     <= 100
  and s.is_movel          = true;

comment on view public.vw_elegiveis_banda_extra is
  'Clientes elegíveis à oferta +200MB/R$12,90 (regra do sprint). Corretiva em aberto: guardrail suspenso.';

-- ---------- 4. Tabela de resultados da campanha ----------------------------

create table if not exists public.campanha_resultados (
  id               bigint generated always as identity primary key,
  codcliente       bigint not null,
  codinst          bigint,
  telefone_e164    text,
  oferta_descricao text default '+200MB por R$12,90',
  status_disparo   text not null default 'pendente'
                     check (status_disparo in ('pendente','enviado','falhou')),
  resposta         text
                     check (resposta is null or resposta in ('aceite','recusa','sem_resposta','handoff_humano')),
  motivo_handoff   text,
  data_disparo     timestamptz,
  data_resposta    timestamptz,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);

create index if not exists ix_campres_codcliente on public.campanha_resultados(codcliente);
create index if not exists ix_campres_status     on public.campanha_resultados(status_disparo);
create index if not exists ix_campres_resposta   on public.campanha_resultados(resposta);

-- RLS ligado sem policies: só service_role/postgres acessam (dashboard server-side).
alter table public.campanha_resultados enable row level security;

-- Atualiza atualizado_em em cada update
create or replace function public.fn_touch_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end $$;

drop trigger if exists trg_touch_campres on public.campanha_resultados;
create trigger trg_touch_campres before update on public.campanha_resultados
for each row execute function public.fn_touch_atualizado_em();

-- ---------- 5. Views de dashboard ------------------------------------------

create or replace view public.vw_elegiveis_nao_contatados as
select e.*
from public.vw_elegiveis_banda_extra e
left join public.campanha_resultados r
  on r.codcliente = e.codcliente and r.status_disparo = 'enviado'
where r.id is null;

comment on view public.vw_elegiveis_nao_contatados is
  'Elegíveis que ainda não receberam disparo enviado.';

create or replace view public.vw_funil_campanha as
select
  (select count(*) from public.stg_clientes)                                            as base_total,
  (select count(*) from public.vw_elegiveis_banda_extra)                                as elegiveis,
  (select count(*) from public.campanha_resultados where status_disparo = 'enviado')    as disparados,
  (select count(*) from public.campanha_resultados where resposta = 'aceite')           as aceitos,
  (select count(*) from public.campanha_resultados where resposta = 'recusa')           as recusas,
  (select count(*) from public.campanha_resultados where resposta = 'sem_resposta')     as sem_resposta,
  (select count(*) from public.campanha_resultados where resposta = 'handoff_humano')   as handoff_humano,
  case
    when (select count(*) from public.campanha_resultados where status_disparo = 'enviado') > 0
    then round(100.0 * (select count(*) from public.campanha_resultados where resposta = 'aceite')
              / (select count(*) from public.campanha_resultados where status_disparo = 'enviado'), 1)
    else 0
  end                                                                                   as taxa_aceite_pct;

comment on view public.vw_funil_campanha is
  'Funil da campanha: base -> elegíveis -> disparados -> aceitos/recusas/sem_resposta/handoff + taxa de aceite.';
