# IdeaForge Hackathon

IdeaForge is a standalone website project. It does not modify or depend on the
TechTrove app.

## Run locally

From this folder, run:

```sh
npm install
npm run dev
```

To create and preview a production build:

```sh
npm run build
npm run preview
```

Copy `.env.example` to `.env` for local, browser-safe Supabase configuration.
The service-role key must only be configured in a trusted backend or Supabase
Edge Function secret store; never add it to this frontend project.

To initialize the database and private payment-proof bucket, run
[`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL Editor.
After `suvedhansuveg14@gmail.com` has signed in with Google once, run
[`supabase/migrations/20261026092700_ideaforge_grant_admin.sql`](./supabase/migrations/20261026092700_ideaforge_grant_admin.sql)
in the Supabase SQL Editor to grant the admin role.
Add the local origin and production origin to Supabase Authentication's
redirect URL allow list so Google OAuth can return to the admin route.

The public registration form saves teams and members to Supabase and uploads
payment screenshots to the private `ideaforge-payment-proofs` bucket. The
registration form requires a Google-authenticated participant and uses that
account's email for the team contact. The admin route also uses Google OAuth
and checks the `ideaforge_admins` table before showing live registration data
or controls.

The admin console includes payment review, registration totals, a searchable
participant directory, team check-in by QR scan or team code, and a Gmail
confirmation outbox with safe retry controls. Apply
[`supabase/migrations/20261026210000_ideaforge_admin_checkin.sql`](./supabase/migrations/20261026210000_ideaforge_admin_checkin.sql)
after the base schema and email-confirmation migration. It assigns each team a
unique code, displays its QR in the signed-in team leader's profile, and adds
admin-only check-in recording. The payment approval email includes the team
code; redeploy the email-worker Edge Function after applying the migration.

Apply
[`supabase/migrations/20261026220000_ideaforge_payment_reupload.sql`](./supabase/migrations/20261026220000_ideaforge_payment_reupload.sql)
after the admin/check-in migration to enable admin re-upload requests and
authenticated team-leader payment resubmission. A requested team can upload a
replacement UTR and screenshot from the team leader's profile.

Apply
[`supabase/migrations/20261026230000_ideaforge_short_team_codes.sql`](./supabase/migrations/20261026230000_ideaforge_short_team_codes.sql)
after the payment re-upload migration to generate shorter team codes for new
registrations. Codes use the format `IF-ABC234`; existing team codes are not
changed.

Apply
[`supabase/migrations/20261026240000_ideaforge_participant_profile.sql`](./supabase/migrations/20261026240000_ideaforge_participant_profile.sql)
after the short-team-code migration to show the signed-in team leader's
registration time, member roster, payment details, and check-in QR on their
profile. It also restricts replacement payment submissions to teams whose
latest admin review explicitly requested a re-upload.

Apply
[`supabase/migrations/20261026250000_ideaforge_2k26_rules_and_team_limit.sql`](./supabase/migrations/20261026250000_ideaforge_2k26_rules_and_team_limit.sql)
after the participant-profile migration to update the registration limit to
five members. The website publishes the IDEAFORGE 2K26 participant rules.

After installing the base schema, apply
[`supabase/migrations/20261026090000_ideaforge_require_participant_auth.sql`](./supabase/migrations/20261026090000_ideaforge_require_participant_auth.sql)
to require participant sign-in for team registration and match the team
contact email to the authenticated account.

After the base schema is installed, review the
[`supabase/migrations/20261025230000_ideaforge_email_confirmation.sql`](./supabase/migrations/20261025230000_ideaforge_email_confirmation.sql)
outbox/trigger migration and run its rollback-only queue test against a
disposable database. It queues one message to the team contact only when
payment changes from `pending_review` to `approved`. It does not backfill
existing approvals.

The Edge Function in `supabase/functions/ideaforge-email-worker/` sends using
the Gmail API and is disabled unless the server-side
`IDEAFORGE_EMAIL_SENDING_ENABLED` secret is explicitly set to `true`. Before
deployment, configure Gmail API OAuth credentials and the sender identity as
Supabase Edge Function secrets; required names are `GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `IDEAFORGE_GMAIL_FROM`,
`IDEAFORGE_GMAIL_FROM_NAME`, `IDEAFORGE_EMAIL_WORKER_TOKEN`, and
`IDEAFORGE_EMAIL_SENDING_ENABLED`. The Supabase service-role key is never
needed in the browser and must never be placed in a `VITE_*` variable.
The worker is configured with `verify_jwt = false` because it authenticates
with its own high-entropy bearer token; deploy it only after configuring that
secret. The Gmail authorization must include the
`https://www.googleapis.com/auth/gmail.send` scope. Existing Google sign-in
OAuth should remain unchanged.

[`supabase/scheduler.sql`](./supabase/scheduler.sql) is a proposed pg_cron /
pg_net / Vault setup, not an applied configuration. Verify those extensions
and existing jobs in the target project before running it. Configure the
`ideaforge_supabase_url` and `ideaforge_email_worker_token` Vault entries
first. The scheduler runs every five minutes; the database enforces a
concurrency-safe 200-message rolling 24-hour cap.

The worker records Gmail API acceptance, which is not proof of inbox delivery.
Email sending, deployment, scheduler setup, and migrations remain pending
explicit approval. The Gmail outbox page can show and retry eligible failures,
but queued messages are sent only when the Edge Function and scheduler are
deployed and enabled. For sender/OAuth setup requirements, see
[URLs needed](./URLs%20needed.md).
