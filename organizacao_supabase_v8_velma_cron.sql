-- ============================================================================
-- Valenet CRM v8 — Backup cron da Velma (pg_cron + pg_net). Idempotente.
--   Re-cutuca os workers a cada minuto (rede de seguranca; o fluxo normal ja se
--   auto-encadeia via webhook -> grouper -> orchestrator -> sender).
--   Auth via segredo 'velma_worker_secret' no Vault (criado fora deste arquivo).
--   __REF__ e substituido pelo project ref no momento do apply.
-- ============================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.velma_tick() returns void
language plpgsql security definer set search_path = public as $$
declare k text; base text := 'https://__REF__.supabase.co/functions/v1/'; hdr jsonb;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'velma_worker_secret' limit 1;
  if k is null then return; end if;                         -- sem segredo: nao faz nada
  hdr := jsonb_build_object('x-velma-key', k, 'content-type', 'application/json');
  perform net.http_post(url := base || 'velma-grouper',      headers := hdr, body := '{}'::jsonb);
  perform net.http_post(url := base || 'velma-orchestrator', headers := hdr, body := '{}'::jsonb);
  perform net.http_post(url := base || 'velma-sender',       headers := hdr, body := '{}'::jsonb);
end $$;
revoke execute on function public.velma_tick() from public, anon, authenticated;
grant execute on function public.velma_tick() to service_role;

do $$ begin perform cron.unschedule('velma-tick'); exception when others then null; end $$;
select cron.schedule('velma-tick', '* * * * *', 'select public.velma_tick();');
