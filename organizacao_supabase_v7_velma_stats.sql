-- ============================================================================
-- Valenet CRM v7 — Estatisticas operacionais da Velma (para o painel). Idempotente.
-- ============================================================================
create or replace function public.velma_stats()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'agrup_pending',  (select count(*) from public.fila_agrupamento where processed = false),
    'ia_pending',     (select count(*) from public.fila_ia    where status = 'pending'),
    'ia_failed',      (select count(*) from public.fila_ia    where status = 'failed'),
    'envio_pending',  (select count(*) from public.fila_envio where status in ('pending','processing')),
    'envio_failed',   (select count(*) from public.fila_envio where status = 'failed'),
    'em_humano',      (select count(*) from public.conversation_states where status = 'humano'),
    'em_velma',       (select count(*) from public.conversation_states where status = 'velma'),
    'aceites',        (select count(*) from public.conversation_states where 'aceite' = any(tags))
  );
$$;
revoke execute on function public.velma_stats() from public, anon, authenticated;
grant execute on function public.velma_stats() to service_role;
