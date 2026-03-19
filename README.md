# NestMate — Guia de Setup

## Passo a Passo para Bernardo e Dhomini

---

## 1. Subir o código no GitHub

```bash
# No terminal (Mac/Linux) ou Git Bash (Windows):
git clone https://github.com/SEU-USUARIO/nestmadeprod.git
cd nestmadeprod

# Copiar o arquivo do site para a pasta public/
cp /caminho/para/nestmate_v5.html public/index.html

# Commitar tudo
git add .
git commit -m "feat: initial NestMate setup"
git push origin main
```

---

## 2. Configurar o Supabase

### 2.1 Rodar o banco de dados
1. Acesse: https://supabase.com/dashboard
2. Selecione seu projeto NestMate
3. Vá em **SQL Editor** (menu lateral)
4. Clique em **New Query**
5. Cole TODO o conteúdo do arquivo `supabase/migrations/001_initial_schema.sql`
6. Clique em **Run** (ou Ctrl+Enter)
7. Deve aparecer "Success" em verde

### 2.2 Criar os Storage Buckets
1. Vá em **Storage** (menu lateral)
2. Clique em **New Bucket**
3. Criar 4 buckets:
   - `listing-photos` → Public: **SIM**
   - `avatars` → Public: **SIM**
   - `kyc-documents` → Public: **NÃO** (privado)
   - `contracts` → Public: **NÃO** (privado)

### 2.3 Configurar Google OAuth
1. Vá em **Authentication → Providers → Google**
2. Enable: **ON**
3. Colar Client ID e Client Secret do Google Cloud Console
4. Callback URL (copiar daqui e colar no Google Cloud):
   `https://SEU-PROJETO.supabase.co/auth/v1/callback`

### 2.4 Configurar Facebook OAuth
1. Vá em **Authentication → Providers → Facebook**
2. Enable: **ON**
3. Colar App ID e App Secret do Meta Developer Portal
4. Callback URL (mesma do Google)

---

## 3. Conectar o Vercel

1. Acesse: https://vercel.com/new
2. Clique em **Import Git Repository**
3. Conecte sua conta GitHub (autorizar acesso)
4. Selecione o repositório `nestmadeprod`
5. **Framework Preset**: Other
6. **Root Directory**: deixar em branco
7. Clique em **Deploy**

### 3.1 Adicionar variáveis de ambiente no Vercel
1. Após o deploy, vá em **Settings → Environment Variables**
2. Adicionar:
   - `SUPABASE_URL` = `https://xxx.supabase.co`
   - `SUPABASE_ANON_KEY` = `eyJ...`
   - `STRIPE_PUBLISHABLE_KEY` = `pk_test_...`

### 3.2 Adicionar domínio personalizado
1. Vá em **Settings → Domains**
2. Adicionar: `nestmate.com.au`
3. Seguir instruções para configurar DNS no Cloudflare

---

## 4. Atualizar o HTML com credenciais reais

No arquivo `public/index.html`, procurar e substituir:

```javascript
// ANTES (simulação):
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
const STRIPE_KEY = 'YOUR_STRIPE_KEY';

// DEPOIS (real):
const SUPABASE_URL = 'https://xxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIs...';
const STRIPE_KEY = 'pk_test_...';
```

---

## Stack técnico

| Serviço | Função | Custo |
|---------|--------|-------|
| Supabase | Banco + Auth + Storage + Realtime | Grátis |
| Vercel | Hosting + Deploy automático | Grátis |
| Stripe Connect | Pagamentos + Escrow | 2.9% + AU$0.30 |
| Stripe Identity | KYC (verificação de identidade) | US$1.50/verificação |
| Resend | Emails transacionais | Grátis até 3K/mês |

---

## Contatos de suporte

- Supabase Discord: https://discord.supabase.com
- Stripe Support: https://support.stripe.com
- Vercel Support: https://vercel.com/support
