# URLs and details needed for the IdeaForge integration

IdeaForge is a standalone website with Supabase registration, payment review,
and admin sign-in configured in its frontend. The Gmail payment-confirmation
worker is prepared locally but is not deployed or enabled. Complete these
server-side setup steps before activation.

## Supabase

- Supabase project URL.
- Supabase **anon/public** key. It may be used by a browser client alongside
  strict database policies.
- A service-role key is not needed in this frontend. If a trusted backend or
  Supabase Edge Function needs it, configure it there as a secret; never put
  it in a `VITE_*` variable, browser code, or a checked-in file.
- Storage bucket name for payment screenshots.
- Whether you want the existing schema extended or a new IdeaForge schema.
- Any existing database tables/policies that should be reused.

## Gmail payment confirmations

Google sign-in for the admin panel is separate from Gmail sending permission.
For the server-side confirmation worker, configure these in Supabase Edge
Function secrets only (never in this Vite site's `.env` or any `VITE_*` value):

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN` from the Gmail sender account, authorized for the
  `https://www.googleapis.com/auth/gmail.send` scope.
- `IDEAFORGE_GMAIL_FROM` matching the authorized Gmail sender.
- `IDEAFORGE_GMAIL_FROM_NAME`, normally `IdeaForge Hackathon`.
- `IDEAFORGE_EMAIL_WORKER_TOKEN`: a high-entropy random bearer token shared
  with the Supabase Vault scheduler secret of the same purpose.
- `IDEAFORGE_EMAIL_SENDING_ENABLED`: leave unset or `false` until activation
  is explicitly approved.

Also configure the exact production Supabase URL in the Vault entry
`ideaforge_supabase_url`. The scheduler setup requires target-project review
of `pg_cron`, `pg_net`, Vault, and existing scheduled jobs before execution.

Admin Google sign-in and its callback/redirect URL configuration should not be
recreated. Admin access remains managed by the existing `ideaforge_admins`
table.

## Payment and event details

- Registration fee and payment instructions or UPI/payment QR image.
- Demo payment screenshot to show as an example.
- Official event title, date, venue, registration deadline, and contact email.
- Final rules, schedule, judging criteria, and any eligibility requirements.

## Hosting

- Production domain or preferred deployment location.
- Serve this standalone folder as the project root and rewrite `/wasd4381` to
  `index.html` so the admin route works on refresh. The Vercel configuration
  for this rewrite is in [`vercel.json`](./vercel.json); other hosts need an
  equivalent rewrite. The Vite development server already supports this route.
- Apply
  [`supabase/migrations/20261026260000_ideaforge_participant_checkin.sql`](./supabase/migrations/20261026260000_ideaforge_participant_checkin.sql)
  before using participant QR check-in. Admins display a five-minute QR, and
  participants scan it from their signed-in profile.

The `/wasd4381` path is only a prototype URL, not an access-control mechanism.
Before launch, the admin panel must use real authentication and server-side
authorization.
