create table public.telegram_review_sessions (
  id text primary key check (length(id) between 32 and 64),
  draft_id uuid not null unique references public.drafts(id) on delete restrict,
  control_chat_id bigint not null,
  preview_message_id bigint not null,
  requested_by bigint not null,
  decision text check (decision in ('publish', 'reject')),
  decided_by bigint,
  decided_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (
    (decision is null and decided_by is null and decided_at is null)
    or (decision is not null and decided_by is not null and decided_at is not null)
  )
);

create index telegram_review_sessions_expires_idx
  on public.telegram_review_sessions (expires_at)
  where decision is null;

create table public.telegram_updates (
  update_id bigint primary key,
  update_kind text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text
);

alter table public.telegram_review_sessions enable row level security;
alter table public.telegram_updates enable row level security;

revoke all on table
  public.telegram_review_sessions,
  public.telegram_updates
from anon, authenticated;

grant select, insert, update on table
  public.telegram_review_sessions,
  public.telegram_updates
to service_role;

create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_update_kind text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  insert into public.telegram_updates (update_id, update_kind)
  values (p_update_id, p_update_kind)
  on conflict (update_id) do nothing
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.decide_telegram_review_session(
  p_session_id text,
  p_action text,
  p_chat_id bigint,
  p_message_id bigint,
  p_actor_id bigint
)
returns table (
  session_id text,
  draft_id uuid,
  decision text,
  decision_won boolean,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.telegram_review_sessions%rowtype;
  v_article_id uuid;
begin
  if p_action not in ('publish', 'reject') then
    raise exception 'Invalid review action';
  end if;

  select * into v_session
  from public.telegram_review_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Review session not found';
  end if;
  if v_session.control_chat_id <> p_chat_id
     or v_session.preview_message_id <> p_message_id then
    raise exception 'Review session binding mismatch';
  end if;
  if v_session.expires_at <= now() then
    raise exception 'Review session expired';
  end if;

  if v_session.decision is not null then
    return query select
      v_session.id, v_session.draft_id, v_session.decision, false,
      v_session.expires_at;
    return;
  end if;

  update public.telegram_review_sessions
  set decision = p_action, decided_by = p_actor_id, decided_at = now()
  where id = p_session_id;

  if p_action = 'publish' then
    update public.drafts
    set status = 'approved', approved_at = now(), updated_at = now()
    where id = v_session.draft_id and status = 'review'
    returning article_id into v_article_id;

    if v_article_id is null then
      raise exception 'Draft is not in review state';
    end if;

    update public.articles
    set status = 'approved', updated_at = now()
    where id = v_article_id and status = 'drafted';
  else
    update public.drafts
    set status = 'rejected',
        reviewer_notes = 'Rejected from Telegram review',
        updated_at = now()
    where id = v_session.draft_id and status = 'review'
    returning article_id into v_article_id;

    if v_article_id is null then
      raise exception 'Draft is not in review state';
    end if;

    update public.articles
    set status = 'rejected', updated_at = now()
    where id = v_article_id and status = 'drafted';
  end if;

  if not found then
    raise exception 'Article is not in the expected state';
  end if;

  return query select
    v_session.id, v_session.draft_id, p_action, true, v_session.expires_at;
end;
$$;

revoke all on function public.claim_telegram_update(bigint, text)
  from public, anon, authenticated;
revoke all on function public.decide_telegram_review_session(
  text, text, bigint, bigint, bigint
) from public, anon, authenticated;
grant execute on function public.claim_telegram_update(bigint, text)
  to service_role;
grant execute on function public.decide_telegram_review_session(
  text, text, bigint, bigint, bigint
) to service_role;
