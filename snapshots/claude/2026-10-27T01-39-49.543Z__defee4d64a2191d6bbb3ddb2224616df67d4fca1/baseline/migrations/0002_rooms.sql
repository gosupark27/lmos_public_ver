create table if not exists rooms (
  code text primary key,
  version integer not null default 1,
  state text not null,
  updated_at timestamptz not null default now()
);
