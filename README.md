# FFR Field Log

Phone app for FFR Comms technicians to log SLA and non-SLA jobs, before and after photos,
signatures, and PDF job reports for billing chargeable work.

## How it fits together
- **The app** (this folder) is a website that installs on a phone like an app and works with no signal.
- **Supabase** stores jobs, clients, photos and logins so the office and every technician share one record.

## One-time setup
1. In Supabase, open **SQL Editor → New query**, paste all of `supabase-setup.sql`, click **Run**.
2. Put the Project URL and anon/publishable key in `config.js`.
3. In Supabase **Authentication → URL Configuration**, set **Site URL** to the app's web address.
4. Open the app and create the first account. The first account becomes the office (admin).
5. Technicians open the same address, tap **Create an account**, and the office approves them under **Me → Team**.

## Installing on a phone
- **Android (Chrome):** open the address, tap the menu ⋮ → **Install app** (or **Add to Home screen**).
- **iPhone (Safari):** open the address, tap **Share** → **Add to Home Screen**.
