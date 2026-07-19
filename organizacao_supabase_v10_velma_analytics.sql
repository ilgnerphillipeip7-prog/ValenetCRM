-- ============================================================================
-- Valenet CRM v10 — Analytics da Velma p/ o painel (volume, estados, desfechos,
-- latencia). Idempotente.
-- ============================================================================
create or replace function public.velma_analytics()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'estados', (
      select coalesce(jsonb_agg(jsonb_build_object('label',
        case status when 'velma' then 'IA (Velma)' when 'humano' then 'Humano' when 'fechado' then 'Fechado' else status end,
        'n', n) order by n desc), '[]'::jsonb)
      from (select status, count(*) n from public.conversation_states group by 1) x
    ),
    'desfechos', (
      select jsonb_build_object(
        'aceites',      (select count(*) from public.conversation_states where 'aceite' = any(tags)),
        'humano',       (select count(*) from public.conversation_states where status = 'humano' or 'handoff' = any(tags)),
        'em_andamento', (select count(*) from public.conversation_states where status = 'velma')
      )
    ),
    'volume', (
      select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'recebidas', recebidas, 'enviadas', enviadas) order by ord), '[]'::jsonb)
      from (
        select extract(epoch from d)::bigint ord,
               to_char(d, 'DD/MM') dia,
               count(*) filter (where m.autor = 'cliente') recebidas,
               count(*) filter (where m.autor = 'velma') enviadas
        from generate_series(((now() at time zone 'America/Sao_Paulo')::date - interval '13 days'),
                             ((now() at time zone 'America/Sao_Paulo')::date), interval '1 day') d
        left join public.mensagens m
          on (m.criado_em at time zone 'America/Sao_Paulo')::date = d::date
         and m.autor in ('cliente','velma')
        group by d order by d
      ) v
    ),
    'latencia', (
      select jsonb_build_object(
        'amostras', count(*),
        'media_ms', coalesce(round(avg(ia_ms))::int, 0),
        'max_ms',   coalesce(max(ia_ms), 0)
      ) from public.mensagens where ia_ms is not null and autor = 'velma'
    )
  );
$$;
revoke execute on function public.velma_analytics() from public, anon, authenticated;
grant execute on function public.velma_analytics() to service_role;
