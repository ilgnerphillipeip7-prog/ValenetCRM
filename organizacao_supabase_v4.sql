-- ============================================================================
-- Valenet CRM v4 — Inbox de conversas (chat WhatsApp). Idempotente.
--   mensagens (in/out) + vw_conversas (lista por telefone, janela 24h, nome).
-- ============================================================================

create table if not exists public.mensagens (
  id            bigserial primary key,
  telefone_e164 text not null,
  telefone_canon text generated always as (
    regexp_replace(regexp_replace(telefone_e164, '\D', '', 'g'), '^(55\d{2})9(\d{8})$', '\1\2')
  ) stored,
  direcao       text not null check (direcao in ('in','out')),
  tipo          text not null default 'text',
  texto         text,
  wa_message_id text,
  status        text,                 -- in: 'recebida' | out: enviado/entregue/lido/falhou
  simulado      boolean not null default false,
  operador      text,                 -- e-mail do operador (mensagens 'out')
  criado_em     timestamptz not null default now()
);
create index if not exists ix_msg_canon_data on public.mensagens (telefone_canon, criado_em);
create index if not exists ix_msg_waid on public.mensagens (wa_message_id);

alter table public.mensagens enable row level security;             -- sem policy => anon/authenticated bloqueados
revoke all on public.mensagens from anon, authenticated;
grant select, insert, update on public.mensagens to service_role;
grant usage, select on sequence public.mensagens_id_seq to service_role;

-- Lista de conversas (uma por telefone canônico), com janela de 24h e nome do cliente
create or replace view public.vw_conversas as
with agg as (
  select telefone_canon,
         max(criado_em) as ultima_em,
         max(criado_em) filter (where direcao='in') as ultima_entrada_em,
         count(*) as qtd
  from public.mensagens group by telefone_canon
)
select a.telefone_canon,
       a.ultima_em, a.ultima_entrada_em, a.qtd,
       (a.ultima_entrada_em is not null and a.ultima_entrada_em > now() - interval '24 hours') as janela_aberta,
       lm.texto    as ultima_texto,
       lm.direcao  as ultima_direcao,
       c.codcliente, c.nome
from agg a
left join lateral (
  select texto, direcao from public.mensagens m
  where m.telefone_canon = a.telefone_canon order by criado_em desc limit 1
) lm on true
left join lateral (
  select s.codcliente, s.nome from public.stg_clientes s
  where regexp_replace(s.telefone_e164, '^(55\d{2})9(\d{8})$', '\1\2') = a.telefone_canon limit 1
) c on true
order by a.ultima_em desc;

revoke select on public.vw_conversas from anon, authenticated;
grant select on public.vw_conversas to service_role;
