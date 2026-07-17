-- ============================================================================
-- Valenet CRM v6 — Tools (function calling) da Velma + seed do KB. Idempotente.
--   Reaproveita: stg_clientes, vw_elegiveis_banda_extra, campanha_resultados,
--                rpc_registrar_resposta, conversation_states, velma_settings.
--   Cria: velma_consultar_cliente, velma_aplicar_tag, velma_registrar_aceite,
--         velma_transferir_humano. Sem agendamento (fora do escopo).
-- ============================================================================

-- ---------- TOOL: consultar_cliente ----------------------------------------
-- Perfil + elegibilidade da Banda Extra pelo telefone canônico. NULL = fora da base.
-- Telefone NÃO é único na base: se o mesmo número tem vários contratos, prioriza
-- o contrato ELEGÍVEL (para não negar a oferta por causa de outro contrato do mesmo cliente).
create or replace function public.velma_consultar_cliente(p_canon text)
returns jsonb language sql security definer set search_path = public as $$
  with matches as (
    select s.codcliente, s.nome, s.cidade, s.banda, s.total_mensal, s.meses_vigencia,
           s.status_contrato, s.tecnologia, (e.codcliente is not null) as elegivel
    from public.stg_clientes s
    left join public.vw_elegiveis_banda_extra e on e.codcliente = s.codcliente
    where regexp_replace(s.telefone_e164, '^(55\d{2})9(\d{8})$', '\1\2') = p_canon
  )
  select jsonb_build_object(
    'nome',                 m.nome,
    'cidade',               m.cidade,
    'plano_mbps',           m.banda,
    'mensalidade',          m.total_mensal,
    'meses_vigencia',       m.meses_vigencia,
    'status_contrato',      m.status_contrato,
    'tecnologia',           m.tecnologia,
    'elegivel_banda_extra', m.elegivel,
    'oferta',               case when m.elegivel then '+200MB por R$12,90' else null end,
    'multiplos_contratos',  ((select count(*) from matches) > 1)
  )
  from matches m
  order by m.elegivel desc, m.total_mensal asc
  limit 1;
$$;

-- ---------- TOOL: aplicar_tag ----------------------------------------------
create or replace function public.velma_aplicar_tag(p_canon text, p_tag text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.conversation_states(telefone_canon, tags)
    values (p_canon, array[p_tag])
  on conflict (telefone_canon) do update
    set tags = (select array(select distinct t from unnest(conversation_states.tags || excluded.tags) t)),
        updated_at = now();
end $$;

-- ---------- TOOL: registrar_aceite -----------------------------------------
-- Marca aceite na conversa (tag+estado) e reflete no funil (best-effort).
create or replace function public.velma_registrar_aceite(p_canon text, p_observacao text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_camp bigint;
begin
  insert into public.conversation_states(telefone_canon, tags, last_action, last_action_at, current_state)
    values (p_canon, array['aceite'], 'aceite_banda_extra', now(), 'aceite')
  on conflict (telefone_canon) do update
    set tags = (select array(select distinct t from unnest(conversation_states.tags || array['aceite']) t)),
        last_action = 'aceite_banda_extra', last_action_at = now(), current_state = 'aceite', updated_at = now();
  select public.rpc_registrar_resposta(p_canon, 'aceite', p_observacao) into v_camp;
  return jsonb_build_object('ok', true, 'campanha_id', v_camp);
end $$;

-- ---------- TOOL: transferir_humano ----------------------------------------
-- Muda status p/ 'humano' (webhook para de enfileirar p/ IA) + reflete no funil.
create or replace function public.velma_transferir_humano(p_canon text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_camp bigint;
begin
  insert into public.conversation_states(telefone_canon, status, tags, last_action, last_action_at)
    values (p_canon, 'humano', array['handoff'], coalesce(p_motivo, 'transferido'), now())
  on conflict (telefone_canon) do update
    set status = 'humano',
        tags = (select array(select distinct t from unnest(conversation_states.tags || array['handoff']) t)),
        last_action = coalesce(p_motivo, conversation_states.last_action), last_action_at = now(), updated_at = now();
  select public.rpc_registrar_resposta(p_canon, 'handoff_humano', p_motivo) into v_camp;
  return jsonb_build_object('ok', true, 'campanha_id', v_camp);
end $$;

-- ---------- SEGURANÇA ------------------------------------------------------
revoke execute on function
  public.velma_consultar_cliente(text), public.velma_aplicar_tag(text,text),
  public.velma_registrar_aceite(text,text), public.velma_transferir_humano(text,text)
  from public, anon, authenticated;
grant execute on function
  public.velma_consultar_cliente(text), public.velma_aplicar_tag(text,text),
  public.velma_registrar_aceite(text,text), public.velma_transferir_humano(text,text)
  to service_role;

-- ---------- SEED do KB (só se ainda vazio; painel passa a ser dono depois) --
update public.velma_settings set kb = $kb$OFERTA DE RETENCAO (unica que voce pode oferecer):
- Banda Extra: +200 Mbps adicionais por R$ 12,90/mes, somados ao plano atual do cliente.
- Elegibilidade e definida pelo sistema — SEMPRE confirme com a tool consultar_cliente antes de oferecer. (Regra interna: contrato Ativo, instalacao ATIVADO, tecnologia GPON/fibra, carteira Varejo, plano ate 500 Mbps, no maximo 1 titulo nao pago, vigencia acima de 9 meses, mensalidade ate R$100, telefone movel.)
- Se o cliente NAO for elegivel, nao ofereca a Banda Extra; ajude com duvidas. Se insistir em oferta/desconto, transfira para humano.
- Nunca prometa outros valores, descontos, velocidades ou condicoes fora desta oferta.

CANAIS DE ATENDIMENTO VALENET:
- Telefone: 106 38 | WhatsApp: (31) 3840-7100 | App: Minha Valenet (Android/iOS).

FAQ (resumo — use para tirar duvidas; se exigir acao na conta do cliente, transfira para humano):
- Sem internet: reiniciar modem/roteador (desligar ~2 min, religar, aguardar ate 5 min).
- Lentidao/quedas: aproximar do roteador, usar cabo em dispositivos pesados, Mesh para casas grandes.
- Fatura: enviada digital (SMS, e-mail, app, WhatsApp). Pagamento: cartao recorrente, debito automatico, PIX (QR), codigo de barras, casas lotericas (com CPF), bancos parceiros.
- Alterar vencimento (app): Faturas > Configuracao de Faturas > Editar data. Datas: 02, 06, 08, 10, 12.
- Pagou e sinal nao voltou: PIX/bancos principais 15-30 min; outros ate 48h; sexta apos 16h compensa segunda de manha.
- Pagamento em duplicidade: o credito vai para a proxima fatura automaticamente.
- 2a via, pagar, mudar vencimento, cadastrar cartao, ativar beneficios, reiniciar internet, configurar Wi-Fi, abrir chamado: tudo pelo app Minha Valenet.
- Mudanca de endereco/comodo/titularidade, cancelamento, portabilidade, obito do titular: exigem processo/documentos -> transferir para humano.
- Cancelamento pode ter multa de fidelidade (proporcional ao tempo restante do contrato).

PRODUTOS/BENEFICIOS VALENET (reconheca se o cliente citar; NAO invente precos):
- Internet fibra (GPON), Valenet TV (100% HD, rewind 48h, gravacao), Telefone Fixo, Wi-Fi Mesh, SmartCam.
- Beneficios gratis nos planos: Skeelo (livros), McAfee (seguranca).
- Servicos/streamings contrataveis: Globoplay, Premiere, Disney+, HBO Max, Telecine, Deezer, ExitLag, Qualifica (cursos), Saude 24h (telemedicina), Watch TV.
- Para valores/contratacao desses, oriente o app/central ou transfira para humano.

FORA DO ESCOPO / TRANSFERIR PARA HUMANO:
- Cancelamento, reclamacao formal, negociacao de valores, problema tecnico que exige visita, mudanca cadastral, ou qualquer pedido fora da oferta de Banda Extra.$kb$
where id = 1 and (kb is null or kb = '');
