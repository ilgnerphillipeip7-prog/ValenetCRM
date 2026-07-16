-- ============================================================================
-- Valenet CRM v2 — Motor de disparo (RPCs + views mascaradas). Idempotente.
-- Aplicado no Supabase via Management API. Complementa organizacao_supabase.sql.
-- ============================================================================

alter table public.campanha_resultados
  add column if not exists simulado boolean not null default false,
  add column if not exists wa_message_id text,
  add column if not exists wa_status text,
  add column if not exists erro text,
  add column if not exists resposta_texto text;

-- Impede duplo agendamento do mesmo cliente enquanto pendente/enviado
create unique index if not exists uq_campres_ativo
  on public.campanha_resultados (codcliente)
  where (status_disparo in ('pendente','enviado'));

-- Reserva um lote de elegíveis ainda não contatados (concorrência-segura)
create or replace function public.rpc_reservar_lote(p_limit int default 50)
returns setof public.campanha_resultados
language sql security definer set search_path = public as $$
  insert into public.campanha_resultados (codcliente, codinst, telefone_e164, oferta_descricao, status_disparo)
  select e.codcliente, e.codinst, e.telefone_e164, e.oferta_descricao, 'pendente'
  from public.vw_elegiveis_banda_extra e
  where not exists (select 1 from public.campanha_resultados r
                    where r.codcliente = e.codcliente and r.status_disparo in ('pendente','enviado'))
  order by e.codcliente
  limit greatest(coalesce(p_limit,0),0)
  on conflict (codcliente) where (status_disparo in ('pendente','enviado')) do nothing
  returning *;
$$;

create or replace function public.rpc_marcar_disparo(
  p_id bigint, p_status text, p_wa_message_id text default null,
  p_erro text default null, p_simulado boolean default false)
returns void language sql security definer set search_path = public as $$
  update public.campanha_resultados
  set status_disparo = p_status,
      wa_message_id = coalesce(p_wa_message_id, wa_message_id),
      erro = p_erro, simulado = p_simulado,
      data_disparo = case when p_status in ('enviado','falhou') then now() else data_disparo end
  where id = p_id;
$$;

create or replace function public.rpc_registrar_resposta(
  p_telefone text, p_resposta text, p_texto text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  select id into v_id from public.campanha_resultados
  where telefone_e164 = p_telefone and status_disparo='enviado'
  order by data_disparo desc nulls last limit 1;
  if v_id is null then return null; end if;
  update public.campanha_resultados
  set resposta = p_resposta, resposta_texto = p_texto, data_resposta = now()
  where id = v_id;
  return v_id;
end $$;

create or replace function public.rpc_atualizar_status_wa(p_wa_message_id text, p_status text)
returns void language sql security definer set search_path = public as $$
  update public.campanha_resultados
  set wa_status = p_status,
      status_disparo = case when p_status = 'failed' then 'falhou' else status_disparo end
  where wa_message_id = p_wa_message_id;
$$;

-- Views mascaradas (LGPD) para o painel
create or replace view public.vw_elegiveis_preview as
  select codcliente, nome, cidade, banda, meses_vigencia, total_mensal,
         '****'||right(telefone_e164,4) as telefone_mascarado, oferta_descricao
  from public.vw_elegiveis_banda_extra order by codcliente;

create or replace view public.vw_resultados_recentes as
  select id, codcliente, '****'||right(telefone_e164,4) as telefone_mascarado,
         status_disparo, resposta, simulado, data_disparo, data_resposta, wa_status
  from public.campanha_resultados
  order by coalesce(data_disparo, criado_em) desc;
