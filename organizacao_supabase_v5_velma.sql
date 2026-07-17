-- ============================================================================
-- Valenet CRM v5 — Fundação do agente de IA "Velma". Idempotente.
--   Reaproveita: mensagens, Clientes/stg_clientes, vw_conversas.
--   Cria: velma_settings, conversation_states, client_memory, 3 filas + claims.
--   Nasce DESLIGADA (velma_settings.is_active=false); só liga com ANTHROPIC_API_KEY.
-- ============================================================================

-- ---------- SETTINGS (1 linha global; single-tenant) ----------
create table if not exists public.velma_settings (
  id                    int primary key default 1,
  is_active             boolean not null default false,   -- liga/desliga geral
  auto_response_enabled boolean not null default true,
  message_breaking_enabled boolean not null default true,
  stt_enabled           boolean not null default false,   -- audio recebido (codado, desligado)
  tts_enabled           boolean not null default false,   -- audio enviado (fase posterior)
  debounce_seconds      int not null default 10,
  response_delay_min    int not null default 1000,
  response_delay_max    int not null default 3000,
  model_conversa        text not null default 'claude-sonnet-5',
  model_classificacao   text not null default 'claude-haiku-4-5',
  timezone              text not null default 'America/Sao_Paulo',
  persona_nome          text not null default 'Velma',
  empresa               text not null default 'Valenet',
  tom                   text not null default 'cordial e direta',
  termos_proibidos      text not null default 'Nunca cite concorrentes. Nunca prometa valores/condicoes fora da oferta. Nunca saia das regras das promocoes.',
  system_prompt_override text,             -- se preenchido, sobrepoe o prompt padrao
  kb                    text,              -- base de conhecimento inline (FAQ + produtos + regra)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint velma_settings_singleton check (id = 1)
);
insert into public.velma_settings (id) values (1) on conflict (id) do nothing;

-- ---------- ESTADO POR CONVERSA (chave = telefone canônico) ----------
create table if not exists public.conversation_states (
  telefone_canon text primary key,
  status         text not null default 'velma' check (status in ('velma','humano','fechado')),
  current_state  text not null default 'idle',
  last_action    text,
  last_action_at timestamptz,
  tags           text[] not null default '{}',
  contexto       jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- MEMÓRIA DO CLIENTE (chave = telefone canônico) ----------
create table if not exists public.client_memory (
  telefone_canon text primary key,
  memory jsonb not null default '{
    "last_updated": null,
    "lead_profile": {"interests": [], "lead_stage": "new", "objections": [], "communication_style": "unknown", "qualification_score": 0},
    "sales_intelligence": {"pain_points": [], "next_best_action": "qualify", "budget_indication": "unknown"},
    "interaction_summary": {"last_contact_reason": "", "total_conversations": 0},
    "conversation_history": []
  }'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- mensagens: distinguir autor (cliente/velma/humano) ----------
alter table public.mensagens
  add column if not exists autor text,
  add column if not exists processada_ia boolean not null default false,
  add column if not exists ia_ms integer;
update public.mensagens
  set autor = case when direcao = 'in' then 'cliente' else 'humano' end
  where autor is null;

-- ---------- FILAS ----------
create table if not exists public.fila_agrupamento (
  id bigserial primary key,
  wa_message_id text unique,
  telefone_canon text not null,
  texto text,
  tipo text not null default 'text',
  message_data jsonb,
  processed boolean not null default false,
  process_after timestamptz not null default (now() + interval '10 seconds'),
  created_at timestamptz not null default now()
);
create index if not exists ix_fag_pending on public.fila_agrupamento(processed, process_after) where processed = false;

create table if not exists public.fila_ia (
  id bigserial primary key,
  telefone_canon text not null,
  context_data jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  priority int not null default 1,
  retry_count int not null default 0,
  error_message text,
  scheduled_for timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_fia_pending on public.fila_ia(status, priority desc, scheduled_for) where status in ('pending','processing');

create table if not exists public.fila_envio (
  id bigserial primary key,
  telefone_canon text not null,
  texto text,
  tipo text not null default 'text',
  media_url text,
  autor text not null default 'velma',
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  priority int not null default 1,
  retry_count int not null default 0,
  error_message text,
  wa_message_id text,
  metadata jsonb not null default '{}',
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_fenv_pending on public.fila_envio(status, priority desc, scheduled_at) where status in ('pending','processing');

-- ---------- CLAIMS (FOR UPDATE SKIP LOCKED) ----------
create or replace function public.claim_fila_agrupamento(p_limit int default 200)
returns setof public.fila_agrupamento language plpgsql security definer set search_path = public as $$
begin
  return query
  with cte as (
    select id from public.fila_agrupamento
    where processed = false and process_after <= now()
    order by process_after asc for update skip locked limit p_limit
  )
  update public.fila_agrupamento q set processed = true
  where q.id in (select id from cte) returning q.*;
end $$;

create or replace function public.claim_fila_ia(p_limit int default 5)
returns setof public.fila_ia language plpgsql security definer set search_path = public as $$
begin
  return query
  with cte as (
    select id from public.fila_ia
    where status = 'pending' and (scheduled_for is null or scheduled_for <= now())
    order by priority desc, scheduled_for asc nulls first, created_at asc
    for update skip locked limit p_limit
  )
  update public.fila_ia q set status = 'processing', updated_at = now()
  where q.id in (select id from cte) returning q.*;
end $$;

create or replace function public.claim_fila_envio(p_limit int default 10)
returns setof public.fila_envio language plpgsql security definer set search_path = public as $$
begin
  return query
  with cte as (
    select id from public.fila_envio
    where status = 'pending' and (scheduled_at is null or scheduled_at <= now())
    order by priority desc, scheduled_at asc nulls first, created_at asc
    for update skip locked limit p_limit
  )
  update public.fila_envio q set status = 'processing', updated_at = now()
  where q.id in (select id from cte) returning q.*;
end $$;

-- ---------- HELPERS ----------
-- codcliente pelo telefone (normaliza 9º dígito dos dois lados); NULL = não está na base
create or replace function public.cliente_por_telefone_canon(p_canon text)
returns bigint language sql security definer set search_path = public as $$
  select s.codcliente from public.stg_clientes s
  where regexp_replace(s.telefone_e164, '^(55\d{2})9(\d{8})$', '\1\2') = p_canon
  limit 1;
$$;

-- garante linha de estado e devolve o status atual
create or replace function public.velma_conv_status(p_canon text)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  insert into public.conversation_states(telefone_canon) values (p_canon) on conflict (telefone_canon) do nothing;
  select status into v from public.conversation_states where telefone_canon = p_canon;
  return v;
end $$;

-- transferir para humano (handoff) — usada pela tool e pela classificação
create or replace function public.velma_set_status(p_canon text, p_status text, p_action text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.conversation_states(telefone_canon, status, last_action, last_action_at)
  values (p_canon, p_status, p_action, now())
  on conflict (telefone_canon) do update set status = excluded.status, last_action = coalesce(excluded.last_action, conversation_states.last_action), last_action_at = now(), updated_at = now();
end $$;

create or replace function public.velma_cleanup() returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.fila_agrupamento where processed = true and created_at < now() - interval '1 hour';
  delete from public.fila_ia    where status = 'completed' and processed_at < now() - interval '24 hours';
  delete from public.fila_envio where status = 'completed' and sent_at < now() - interval '24 hours';
  delete from public.fila_ia    where status = 'failed' and updated_at < now() - interval '7 days';
  delete from public.fila_envio where status = 'failed' and updated_at < now() - interval '7 days';
end $$;

-- ---------- SEGURANÇA (fecha anon/authenticated; só service_role) ----------
alter table public.velma_settings      enable row level security;
alter table public.conversation_states enable row level security;
alter table public.client_memory       enable row level security;
alter table public.fila_agrupamento    enable row level security;
alter table public.fila_ia             enable row level security;
alter table public.fila_envio          enable row level security;
revoke all on public.velma_settings, public.conversation_states, public.client_memory,
             public.fila_agrupamento, public.fila_ia, public.fila_envio from anon, authenticated;
grant select, insert, update, delete on public.velma_settings, public.conversation_states, public.client_memory,
             public.fila_agrupamento, public.fila_ia, public.fila_envio to service_role;
grant usage, select on sequence public.fila_agrupamento_id_seq, public.fila_ia_id_seq, public.fila_envio_id_seq to service_role;
revoke execute on function public.claim_fila_agrupamento(int), public.claim_fila_ia(int), public.claim_fila_envio(int),
             public.cliente_por_telefone_canon(text), public.velma_conv_status(text), public.velma_set_status(text,text,text), public.velma_cleanup()
             from public, anon, authenticated;
grant execute on function public.claim_fila_agrupamento(int), public.claim_fila_ia(int), public.claim_fila_envio(int),
             public.cliente_por_telefone_canon(text), public.velma_conv_status(text), public.velma_set_status(text,text,text), public.velma_cleanup()
             to service_role;
