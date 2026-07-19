-- ============================================================================
-- Valenet CRM v9 — Analytics do painel (funil de elegibilidade, diagnostico de
-- telefone, perfil dos elegiveis) + lista cheia + reserva por selecao. Idempotente.
-- ============================================================================

-- Lista cheia de elegiveis (com telefone real; painel interno autenticado)
create or replace view public.vw_elegiveis_full as
select codcliente, nome, cidade, banda, meses_vigencia, total_mensal, telefone_e164
from public.vw_elegiveis_banda_extra;

-- Agregados para os graficos do painel (um unico jsonb)
create or replace function public.painel_analytics()
returns jsonb language sql security definer set search_path = public as $$
  with s as (select * from public.stg_clientes),
       e as (select * from public.vw_elegiveis_banda_extra)
  select jsonb_build_object(
    'funil', (
      select jsonb_agg(jsonb_build_object('label', label, 'n', n) order by ord) from (
        select 1 ord, 'Base total' label, count(*) n from s
        union all select 2, 'Vigencia +9 meses', count(*) filter (where meses_vigencia <= -9) from s
        union all select 3, '+ Contrato Ativo', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo') from s
        union all select 4, '+ Instalacao Ativada', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO') from s
        union all select 5, '+ Tecnologia GPON', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO' and tecnologia = 'GPON') from s
        union all select 6, '+ Carteira Varejo', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO' and tecnologia = 'GPON' and carteira = 'Varejo') from s
        union all select 7, '+ Banda <= 500', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO' and tecnologia = 'GPON' and carteira = 'Varejo' and banda <= 500) from s
        union all select 8, '+ Mensalidade <= 100', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO' and tecnologia = 'GPON' and carteira = 'Varejo' and banda <= 500 and total_mensal <= 100) from s
        union all select 9, '+ Celular valido', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO' and tecnologia = 'GPON' and carteira = 'Varejo' and banda <= 500 and total_mensal <= 100 and is_movel = true) from s
        union all select 10, '+ Titulos <= 1 (elegiveis)', count(*) filter (where meses_vigencia <= -9 and status_contrato = 'Ativo' and status_instalacao = 'ATIVADO' and tecnologia = 'GPON' and carteira = 'Varejo' and banda <= 500 and total_mensal <= 100 and is_movel = true and qtd_tit_nao_pagos <= 1) from s
      ) q
    ),
    'diagnostico', (
      select jsonb_build_object(
        'total', count(*),
        'movel_9', count(*) filter (where is_movel = true and length(public.fn_tel_digits(telefone_raw)) >= 11),
        'movel_norm', count(*) filter (where is_movel = true and length(public.fn_tel_digits(telefone_raw)) = 10),
        'fixo', count(*) filter (where coalesce(is_movel, false) = false)
      ) from s
    ),
    'por_cidade', (
      select coalesce(jsonb_agg(jsonb_build_object('label', cidade, 'n', n) order by n desc), '[]'::jsonb) from (
        select coalesce(cidade, '(sem cidade)') cidade, count(*) n from e group by 1 order by n desc limit 6
      ) c
    ),
    'por_velocidade', (
      select jsonb_agg(jsonb_build_object('label', label, 'n', n) order by ord) from (
        select 1 ord, '<= 100' label, count(*) n from e where banda <= 100
        union all select 2, '101-200', count(*) from e where banda > 100 and banda <= 200
        union all select 3, '201-300', count(*) from e where banda > 200 and banda <= 300
        union all select 4, '301-400', count(*) from e where banda > 300 and banda <= 400
        union all select 5, '401-500', count(*) from e where banda > 400 and banda <= 500
      ) v
    ),
    'por_mensalidade', (
      select jsonb_agg(jsonb_build_object('label', label, 'n', n) order by ord) from (
        select 1 ord, '<= R$80' label, count(*) n from e where total_mensal <= 80
        union all select 2, 'R$80-95', count(*) from e where total_mensal > 80 and total_mensal <= 95
        union all select 3, 'R$95-100', count(*) from e where total_mensal > 95 and total_mensal <= 100
      ) m
    ),
    'resumo', (
      select jsonb_build_object(
        'elegiveis', count(*),
        'cidades', count(distinct cidade),
        'ticket_medio', round(avg(total_mensal)::numeric, 2),
        'banda_media', round(avg(banda)::numeric)
      ) from e
    )
  );
$$;

-- Reserva de disparo por SELECAO (codclientes escolhidos no painel)
create or replace function public.rpc_reservar_selecionados(p_ids bigint[])
returns setof public.campanha_resultados language sql security definer set search_path = public as $$
  insert into public.campanha_resultados (codcliente, codinst, telefone_e164, oferta_descricao, status_disparo)
  select e.codcliente, e.codinst, e.telefone_e164, e.oferta_descricao, 'pendente'
  from public.vw_elegiveis_banda_extra e
  where e.codcliente = any(p_ids)
    and not exists (select 1 from public.campanha_resultados r where r.codcliente = e.codcliente and r.status_disparo in ('pendente','enviado'))
  on conflict (codcliente) where (status_disparo in ('pendente','enviado')) do nothing
  returning *;
$$;

-- Seguranca
revoke select on public.vw_elegiveis_full from anon, authenticated;
grant select on public.vw_elegiveis_full to service_role;
revoke execute on function public.painel_analytics(), public.rpc_reservar_selecionados(bigint[]) from public, anon, authenticated;
grant execute on function public.painel_analytics(), public.rpc_reservar_selecionados(bigint[]) to service_role;
