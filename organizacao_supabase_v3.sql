-- ============================================================================
-- Valenet CRM v3 — Hardening de segurança (revisão adversarial). Idempotente.
--  1) Fecha exposição das tabelas/views/RPCs à anon key (PostgREST).
--  2) rpc_registrar_resposta: normaliza 9º dígito BR (evita perder respostas).
--  3) rpc_reservar_lote: recicla linhas 'pendente' presas (>15 min).
-- ============================================================================

-- (2) Matching de telefone tolerante ao 9º dígito (Meta às vezes envia sem o 9)
create or replace function public.rpc_registrar_resposta(
  p_telefone text, p_resposta text, p_texto text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_canon text;
begin
  v_canon := regexp_replace(regexp_replace(coalesce(p_telefone,''), '\D', '', 'g'),
                            '^(55\d{2})9(\d{8})$', '\1\2');
  select id into v_id from public.campanha_resultados
  where regexp_replace(telefone_e164, '^(55\d{2})9(\d{8})$', '\1\2') = v_canon
    and status_disparo = 'enviado'
  order by data_disparo desc nulls last limit 1;
  if v_id is null then return null; end if;
  update public.campanha_resultados
  set resposta = p_resposta, resposta_texto = p_texto, data_resposta = now()
  where id = v_id;
  return v_id;
end $$;

-- (3) Reserva reciclando pendentes órfãos (crash entre reservar e enviar)
create or replace function public.rpc_reservar_lote(p_limit int default 50)
returns setof public.campanha_resultados
language sql security definer set search_path = public as $$
  update public.campanha_resultados
    set status_disparo = 'falhou', erro = coalesce(erro, 'timeout: pendente reciclado')
    where status_disparo = 'pendente' and criado_em < now() - interval '15 minutes';
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

-- (1) Fechar acesso da anon key / authenticated a dados pessoais e views
revoke select on public."Clientes" from anon, authenticated;
revoke select on public."MAILING - Clientes com Corretivas" from anon, authenticated;
revoke select on public.stg_clientes from anon, authenticated;
revoke select on public.vw_elegiveis_banda_extra from anon, authenticated;
revoke select on public.vw_elegiveis_nao_contatados from anon, authenticated;
revoke select on public.vw_elegiveis_preview from anon, authenticated;
revoke select on public.vw_resultados_recentes from anon, authenticated;
revoke select on public.vw_funil_campanha from anon, authenticated;
revoke select on public.campanha_resultados from anon, authenticated;

-- RPCs: somente service_role (as Edge Functions usam service_role)
revoke execute on function public.rpc_reservar_lote(int) from public, anon, authenticated;
revoke execute on function public.rpc_marcar_disparo(bigint,text,text,text,boolean) from public, anon, authenticated;
revoke execute on function public.rpc_registrar_resposta(text,text,text) from public, anon, authenticated;
revoke execute on function public.rpc_atualizar_status_wa(text,text) from public, anon, authenticated;

-- Garantir que o service_role continua com tudo que as functions precisam
grant select on public.stg_clientes, public.vw_elegiveis_banda_extra, public.vw_elegiveis_nao_contatados,
      public.vw_elegiveis_preview, public.vw_resultados_recentes, public.vw_funil_campanha,
      public.campanha_resultados to service_role;
grant execute on function
      public.rpc_reservar_lote(int),
      public.rpc_marcar_disparo(bigint,text,text,text,boolean),
      public.rpc_registrar_resposta(text,text,text),
      public.rpc_atualizar_status_wa(text,text) to service_role;
