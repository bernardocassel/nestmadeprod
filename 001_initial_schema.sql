-- ============================================================
-- NestMate — Database Schema v1.0
-- Rodar no Supabase SQL Editor: https://supabase.com/dashboard
-- ============================================================

-- Habilitar extensões necessárias
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- para busca full-text

-- ============================================================
-- TABELA: profiles (estende auth.users do Supabase)
-- ============================================================
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text unique not null,
  full_name text,
  avatar_url text,
  role text check (role in ('tenant', 'landlord', 'both')) default 'tenant',
  nationality text,
  nationality_code text, -- código ISO ex: 'br', 'cn'
  phone text,
  bio text,
  kyc_status text check (kyc_status in ('pending', 'in_review', 'verified', 'failed')) default 'pending',
  kyc_verified_at timestamptz,
  stripe_account_id text, -- para landlords (Stripe Connect)
  stripe_customer_id text, -- para tenants
  rating_avg numeric(3,2) default 0,
  rating_count integer default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- TABELA: listings (anúncios de quartos)
-- ============================================================
create table public.listings (
  id uuid default uuid_generate_v4() primary key,
  landlord_id uuid references public.profiles(id) on delete cascade not null,
  title text not null,
  description text,
  suburb text not null,
  city text default 'Gold Coast',
  state text default 'QLD',
  address text, -- endereço completo (visível só após reserva aceita)
  latitude numeric(10,7),
  longitude numeric(10,7),
  price_weekly numeric(10,2) not null,
  bond_amount numeric(10,2) not null,
  room_type text check (room_type in ('private', 'ensuite', 'studio', 'shared')) not null,
  min_weeks integer default 1 check (min_weeks >= 1),
  max_months integer default 6 check (max_months <= 12),
  available_from date default current_date,
  house_vibe text check (house_vibe in ('social', 'quiet', 'study', 'chill')),
  gender_preference text check (gender_preference in ('any', 'female', 'male', 'mixed')) default 'any',
  nationalities text[] default '{}', -- códigos ISO dos moradores
  amenities text[] default '{}',
  house_rules text[] default '{}',
  photos text[] default '{}' check (array_length(photos, 1) >= 3 or photos = '{}'), -- mín 3 fotos
  photos_verified boolean default false,
  status text check (status in ('draft', 'pending_review', 'active', 'paused', 'occupied', 'deleted')) default 'draft',
  views_count integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- TABELA: housemates (moradores da listagem)
-- ============================================================
create table public.housemates (
  id uuid default uuid_generate_v4() primary key,
  listing_id uuid references public.listings(id) on delete cascade not null,
  name text not null,
  nationality_code text,
  bio text,
  avatar_emoji text,
  created_at timestamptz default now()
);

-- ============================================================
-- TABELA: bookings (reservas)
-- ============================================================
create table public.bookings (
  id uuid default uuid_generate_v4() primary key,
  listing_id uuid references public.listings(id) on delete restrict not null,
  tenant_id uuid references public.profiles(id) on delete restrict not null,
  landlord_id uuid references public.profiles(id) on delete restrict not null,
  move_in_date date not null,
  move_out_date date not null,
  weeks_count integer generated always as (
    ceil(extract(day from (move_out_date::timestamptz - move_in_date::timestamptz)) / 7.0)::integer
  ) stored,
  total_rent numeric(10,2) not null,
  bond_amount numeric(10,2) not null,
  service_fee numeric(10,2) not null,
  total_amount numeric(10,2) not null,
  -- Stripe
  stripe_payment_intent_id text unique,
  stripe_transfer_id text,
  -- Status do fluxo
  status text check (status in (
    'pending',       -- aguardando aprovação do landlord
    'approved',      -- landlord aceitou
    'contract_sent', -- contrato enviado para assinatura
    'signed',        -- ambos assinaram
    'paid',          -- pagamento realizado (em escrow)
    'checked_in',    -- tenant confirmou check-in → escrow liberado
    'checked_out',   -- fim do contrato
    'cancelled',     -- cancelado
    'disputed'       -- em disputa
  )) default 'pending',
  tenant_message text,
  landlord_response text,
  contract_url text,
  tenant_signed_at timestamptz,
  landlord_signed_at timestamptz,
  check_in_confirmed_at timestamptz,
  check_out_confirmed_at timestamptz,
  escrow_released_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- TABELA: payments (histórico de transações)
-- ============================================================
create table public.payments (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references public.bookings(id) on delete restrict not null,
  payer_id uuid references public.profiles(id) on delete restrict,
  receiver_id uuid references public.profiles(id) on delete restrict,
  amount numeric(10,2) not null,
  currency text default 'aud',
  payment_type text check (payment_type in (
    'rent', 'bond', 'service_fee', 'bond_refund', 'rent_refund'
  )) not null,
  status text check (status in ('pending', 'processing', 'completed', 'failed', 'refunded')) default 'pending',
  stripe_payment_intent_id text,
  stripe_transfer_id text,
  stripe_charge_id text,
  description text,
  created_at timestamptz default now()
);

-- ============================================================
-- TABELA: messages (chat em tempo real)
-- ============================================================
create table public.messages (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references public.bookings(id) on delete cascade not null,
  sender_id uuid references public.profiles(id) on delete restrict not null,
  receiver_id uuid references public.profiles(id) on delete restrict not null,
  content text not null check (length(content) > 0 and length(content) <= 2000),
  read_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- TABELA: reviews (avaliações bilaterais)
-- ============================================================
create table public.reviews (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references public.bookings(id) on delete restrict not null,
  reviewer_id uuid references public.profiles(id) on delete restrict not null,
  reviewee_id uuid references public.profiles(id) on delete restrict not null,
  listing_id uuid references public.listings(id) on delete restrict,
  rating integer check (rating between 1 and 5) not null,
  comment text check (length(comment) <= 1000),
  review_type text check (review_type in ('tenant_to_landlord', 'landlord_to_tenant')),
  created_at timestamptz default now(),
  -- Uma review por pessoa por booking
  unique(booking_id, reviewer_id)
);

-- ============================================================
-- TABELA: disputes (disputas de bond)
-- ============================================================
create table public.disputes (
  id uuid default uuid_generate_v4() primary key,
  booking_id uuid references public.bookings(id) on delete restrict not null,
  opened_by uuid references public.profiles(id) on delete restrict not null,
  reason text not null,
  description text,
  evidence_urls text[] default '{}',
  status text check (status in ('open', 'under_review', 'resolved_tenant', 'resolved_landlord', 'resolved_split')) default 'open',
  resolution_notes text,
  resolved_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- ÍNDICES para performance
-- ============================================================
create index idx_listings_status on public.listings(status);
create index idx_listings_suburb on public.listings(suburb);
create index idx_listings_price on public.listings(price_weekly);
create index idx_listings_landlord on public.listings(landlord_id);
create index idx_listings_available on public.listings(available_from);
create index idx_bookings_tenant on public.bookings(tenant_id);
create index idx_bookings_landlord on public.bookings(landlord_id);
create index idx_bookings_listing on public.bookings(listing_id);
create index idx_bookings_status on public.bookings(status);
create index idx_messages_booking on public.messages(booking_id);
create index idx_messages_sender on public.messages(sender_id);
create index idx_payments_booking on public.payments(booking_id);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — Segurança por linha
-- ============================================================

-- Profiles: usuário vê seu próprio perfil + perfis públicos de landlords verificados
alter table public.profiles enable row level security;

create policy "Perfil público de landlords ativos"
  on public.profiles for select
  using (is_active = true);

create policy "Usuário gerencia próprio perfil"
  on public.profiles for all
  using (auth.uid() = id);

-- Listings: qualquer um vê listagens ativas; só landlord gerencia as suas
alter table public.listings enable row level security;

create policy "Listagens ativas são públicas"
  on public.listings for select
  using (status = 'active');

create policy "Landlord gerencia próprias listagens"
  on public.listings for all
  using (auth.uid() = landlord_id);

-- Housemates: público junto com listagem
alter table public.housemates enable row level security;

create policy "Housemates são públicos"
  on public.housemates for select using (true);

create policy "Landlord gerencia housemates"
  on public.housemates for all
  using (
    auth.uid() = (select landlord_id from public.listings where id = listing_id)
  );

-- Bookings: só as partes envolvidas veem
alter table public.bookings enable row level security;

create policy "Partes da reserva veem booking"
  on public.bookings for select
  using (auth.uid() = tenant_id or auth.uid() = landlord_id);

create policy "Tenant cria booking"
  on public.bookings for insert
  with check (auth.uid() = tenant_id);

create policy "Partes atualizam booking"
  on public.bookings for update
  using (auth.uid() = tenant_id or auth.uid() = landlord_id);

-- Payments: só as partes envolvidas
alter table public.payments enable row level security;

create policy "Partes veem pagamentos"
  on public.payments for select
  using (auth.uid() = payer_id or auth.uid() = receiver_id);

-- Messages: só remetente e destinatário
alter table public.messages enable row level security;

create policy "Participantes do chat veem mensagens"
  on public.messages for select
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "Usuário envia mensagens"
  on public.messages for insert
  with check (auth.uid() = sender_id);

create policy "Destinatário marca como lida"
  on public.messages for update
  using (auth.uid() = receiver_id);

-- Reviews: públicas para leitura, privadas para criação
alter table public.reviews enable row level security;

create policy "Reviews são públicas"
  on public.reviews for select using (true);

create policy "Usuário cria própria review"
  on public.reviews for insert
  with check (auth.uid() = reviewer_id);

-- Disputes: só as partes e admins
alter table public.disputes enable row level security;

create policy "Partes veem disputa"
  on public.disputes for select
  using (
    auth.uid() = opened_by or
    auth.uid() = (select tenant_id from public.bookings where id = booking_id) or
    auth.uid() = (select landlord_id from public.bookings where id = booking_id)
  );

create policy "Partes abrem disputa"
  on public.disputes for insert
  with check (auth.uid() = opened_by);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-criar profile quando usuário se registra
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Auto-atualizar updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

create trigger set_listings_updated_at
  before update on public.listings
  for each row execute procedure public.set_updated_at();

create trigger set_bookings_updated_at
  before update on public.bookings
  for each row execute procedure public.set_updated_at();

-- Atualizar rating médio ao criar review
create or replace function public.update_rating_on_review()
returns trigger as $$
begin
  update public.profiles
  set
    rating_avg = (
      select round(avg(rating)::numeric, 2)
      from public.reviews
      where reviewee_id = new.reviewee_id
    ),
    rating_count = (
      select count(*)
      from public.reviews
      where reviewee_id = new.reviewee_id
    )
  where id = new.reviewee_id;
  return new;
end;
$$ language plpgsql;

create trigger update_rating_after_review
  after insert on public.reviews
  for each row execute procedure public.update_rating_on_review();

-- ============================================================
-- STORAGE BUCKETS (rodar separado no Dashboard > Storage)
-- ============================================================
-- Bucket: listing-photos (público)
-- Bucket: kyc-documents (privado)
-- Bucket: contracts (privado)
-- Bucket: avatars (público)

-- ============================================================
-- DADOS DE TESTE (remover em produção)
-- ============================================================
-- Os dados de teste serão inseridos pelo HTML com as credenciais reais
