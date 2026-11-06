-- 매매공시방 DB 스키마. Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run.
-- 다시 실행해도 안전하도록 if not exists / or replace 를 씀.

create extension if not exists pgcrypto;

-- ── 테이블 ────────────────────────────────────────────────

create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists members (
  room_id   uuid not null references rooms on delete cascade,
  user_id   uuid not null,
  nickname  text not null check (char_length(nickname) between 1 and 20),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists posts (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references rooms on delete cascade,
  user_id    uuid not null default auth.uid(),
  nickname   text not null default '',
  market     text not null check (market in ('KR', 'US')),
  symbol     text not null check (char_length(symbol) between 1 and 12),
  name       text not null check (char_length(name) between 1 and 80),
  side       text not null check (side in ('BUY', 'SELL')),
  price      numeric(18, 4) not null check (price > 0),
  qty        numeric(18, 4) not null check (qty > 0),
  created_at timestamptz not null default now()
);
create index if not exists posts_room_created on posts (room_id, created_at desc);

create table if not exists reactions (
  post_id    bigint not null references posts on delete cascade,
  user_id    uuid not null default auth.uid(),
  kind       text not null check (kind in ('why', 'envy', 'fool')),
  nickname   text not null default '',
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

-- 종목 목록(자동완성용)과 종가는 배치가 채움
create table if not exists symbols (
  market   text not null,
  symbol   text not null,
  name     text not null,
  exchange text not null,        -- KOSPI / KOSDAQ / KONEX / ETF / NASDAQ / NYSE ...
  yahoo    text not null,        -- 시세 조회용 티커 (005930.KS, AAPL)
  updated  date not null default current_date,
  primary key (market, symbol)
);
create index if not exists symbols_name on symbols (name);

create table if not exists closes (
  market     text not null,
  symbol     text not null,
  trade_date date not null,
  close      numeric(18, 4) not null,
  primary key (market, symbol, trade_date)
);

-- 종목별 가장 최근 종가
create or replace view latest_closes with (security_invoker = on) as
  select distinct on (market, symbol) market, symbol, trade_date, close
  from closes
  order by market, symbol, trade_date desc;

-- ── 권한 함수 ─────────────────────────────────────────────

create or replace function is_member(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where room_id = r and user_id = auth.uid());
$$;

-- 초대 코드로 입장 (닉네임 변경도 이걸로)
create or replace function join_room(code text, nick text) returns rooms
language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from rooms where invite_code = code;
  if not found then raise exception 'invalid invite code'; end if;
  insert into members (room_id, user_id, nickname)
    values (r.id, auth.uid(), trim(nick))
    on conflict (room_id, user_id) do update set nickname = excluded.nickname;
  return r;
end $$;

-- 글·반응의 작성자와 닉네임은 서버가 채움 (사칭 방지)
create or replace function fill_author() returns trigger
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  new.user_id := auth.uid();
  if tg_table_name = 'posts' then
    rid := new.room_id;
  else
    select room_id into rid from posts where id = new.post_id;
  end if;
  select nickname into new.nickname from members where room_id = rid and user_id = auth.uid();
  if new.nickname is null then raise exception 'not a member'; end if;
  return new;
end $$;

drop trigger if exists posts_author on posts;
create trigger posts_author before insert on posts for each row execute function fill_author();
drop trigger if exists reactions_author on reactions;
create trigger reactions_author before insert on reactions for each row execute function fill_author();

-- ── 행 단위 보안 (RLS) ───────────────────────────────────

alter table rooms     enable row level security;
alter table members   enable row level security;
alter table posts     enable row level security;
alter table reactions enable row level security;
alter table symbols   enable row level security;
alter table closes    enable row level security;

drop policy if exists rooms_read on rooms;
create policy rooms_read on rooms for select using (is_member(id));

drop policy if exists members_read on members;
create policy members_read on members for select using (is_member(room_id));

drop policy if exists posts_read on posts;
create policy posts_read on posts for select using (is_member(room_id));
drop policy if exists posts_insert on posts;
create policy posts_insert on posts for insert with check (is_member(room_id));
drop policy if exists posts_delete on posts;
create policy posts_delete on posts for delete using (user_id = auth.uid());

drop policy if exists reactions_read on reactions;
create policy reactions_read on reactions for select
  using (exists (select 1 from posts p where p.id = post_id and is_member(p.room_id)));
drop policy if exists reactions_insert on reactions;
create policy reactions_insert on reactions for insert
  with check (exists (select 1 from posts p where p.id = post_id and is_member(p.room_id)));
drop policy if exists reactions_delete on reactions;
create policy reactions_delete on reactions for delete using (user_id = auth.uid());

-- 종목·종가는 로그인한 사람 누구나 읽기만 (쓰기는 배치의 service_role 키만)
drop policy if exists symbols_read on symbols;
create policy symbols_read on symbols for select to authenticated using (true);
drop policy if exists closes_read on closes;
create policy closes_read on closes for select to authenticated using (true);

grant execute on function join_room(text, text) to authenticated;

-- ── 실시간 ───────────────────────────────────────────────

do $$ begin
  alter publication supabase_realtime add table posts, reactions;
exception when duplicate_object then null; end $$;

-- ── 첫 방 만들기 ─────────────────────────────────────────
-- 아래 결과로 나오는 invite_code 를 주소 뒤에 붙여 공유: https://사이트주소/#초대코드
insert into rooms (name, invite_code)
select '매매공시방', encode(gen_random_bytes(12), 'hex')
where not exists (select 1 from rooms);

select name, invite_code from rooms;
