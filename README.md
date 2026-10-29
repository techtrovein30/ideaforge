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

The admin console is available at `/wasd4381`; the separately routed email
queue is at `/wasd4381/email` and requires the same admin sign-in. For Vercel deployments, keep
[`vercel.json`](./vercel.json) in the configured project root so Vercel serves
the app for that route instead of returning a 404. Redeploy after adding or
changing the rewrite configuration.

The participant profile check-in scanner is hidden until an admin enables it
at `/wasd4381/email/qrtoggle`. Apply
[`20261027170000_ideaforge_participant_checkin_toggle.sql`](./supabase/migrations/20261027170000_ideaforge_participant_checkin_toggle.sql)
to existing Supabase projects before using this toggle.

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
payment screenshots to the private `ideaforge-payment-proofs` bucket. It
requires a Google-authenticated participant and uses that account's email for
the team contact. Every team member can sign in with their own registered
email to view team registration and attendance status. Registered accounts
are directed to their profile instead of being offered another registration.
The admin route also uses Google OAuth and checks the `ideaforge_admins` table
before showing live registration data or controls.

The admin console includes payment review, registration totals, a searchable
participant directory, team check-in by search, and a Gmail confirmation
outbox with safe retry controls. Admins can display a five-minute check-in QR
that authenticated participants scan from their profiles. Applying the
participant check-in migration below is required for this feature. Apply
[`supabase/migrations/20261026210000_ideaforge_admin_checkin.sql`](./supabase/migrations/20261026210000_ideaforge_admin_checkin.sql)
after the base schema and email-confirmation migration. It assigns each team a
unique code and adds admin-only check-in recording. The payment approval email
includes the team code; redeploy the email-worker Edge Function after applying
the migration.

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
registration time, member roster, payment details, and check-in status on their
profile. It also restricts replacement payment submissions to teams whose
latest admin review explicitly requested a re-upload.

Apply
[`supabase/migrations/20261026250000_ideaforge_2k26_rules_and_team_limit.sql`](./supabase/migrations/20261026250000_ideaforge_2k26_rules_and_team_limit.sql)
after the participant-profile migration to update the registration limit to
five members. The website publishes the IDEAFORGE 2K26 participant rules.

Apply
[`supabase/migrations/20261026260000_ideaforge_participant_checkin.sql`](./supabase/migrations/20261026260000_ideaforge_participant_checkin.sql)
after the team-limit migration. It lets all registered team members view their
team's profile and check-in status, creates short-lived admin check-in QR
sessions, and limits participant self-check-in to an authenticated member of
that team. Payment proof remains visible only to the team contact.

Apply
[`supabase/migrations/20261027100000_ideaforge_accept_college_email_domains.sql`](./supabase/migrations/20261027100000_ideaforge_accept_college_email_domains.sql)
after the participant check-in migration to accept valid college and other
email domains during registration. The team leader still signs in with Google,
and their entered email must match that signed-in account.

Apply
[`supabase/migrations/20261027220000_ideaforge_require_payment_before_registration.sql`](./supabase/migrations/20261027220000_ideaforge_require_payment_before_registration.sql)
after all earlier participant migrations, including
[`supabase/migrations/20261027181500_ideaforge_duplicate_member_email_message.sql`](./supabase/migrations/20261027181500_ideaforge_duplicate_member_email_message.sql),
to keep unpaid teams in an incomplete state and withhold the team code until
the UTR and payment screenshot are submitted. Team leaders can resume payment
submission from their profile.

Apply
[`supabase/migrations/20261027230000_ideaforge_defer_team_codes_until_payment.sql`](./supabase/migrations/20261027230000_ideaforge_defer_team_codes_until_payment.sql)
after the require-payment migration to remove codes from existing unpaid team
drafts and assign codes only when payment proof is submitted.

Apply
[`supabase/migrations/20261028210000_ideaforge_internal_free_registration.sql`](./supabase/migrations/20261028210000_ideaforge_internal_free_registration.sql)
after the deferred-team-code migration to enable free internal team
registrations. Internal teams must provide a unique register number for each
member and receive a team code without submitting payment. External teams
continue through the existing ₹99-per-member payment flow.

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
Supabase Edge Function secrets. Email activation is approved, but the
credentials, function deployment, Vault secrets, and scheduler still need to
be configured in Supabase. Required secret names are `GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `IDEAFORGE_GMAIL_FROM`,
`IDEAFORGE_GMAIL_FROM_NAME`, `IDEAFORGE_EMAIL_WORKER_TOKEN`, and
`IDEAFORGE_EMAIL_SENDING_ENABLED`. The Supabase service-role key is never
needed in the browser and must never be placed in a `VITE_*` variable.
The worker is configured with `verify_jwt = false` so scheduled requests can
authenticate with their high-entropy worker bearer token. The admin outbox's
**Send queued now** button instead uses the signed-in user's JWT; the worker
validates that user and checks `is_ideaforge_admin` before processing the queue.
Deploy the updated function to enable this manual action. The Gmail
authorization must include the
`https://www.googleapis.com/auth/gmail.send` scope. Existing Google sign-in
OAuth should remain unchanged.

[`supabase/scheduler.sql`](./supabase/scheduler.sql) is a proposed pg_cron /
pg_net / Vault setup, not an applied configuration. Verify those extensions
and existing jobs in the target project before running it. Review eligible
pending outbox rows first; enabling the worker will send queued confirmations.
Configure the
`ideaforge_supabase_url` and `ideaforge_email_worker_token` Vault entries
first. The scheduler runs every five minutes; the database enforces a
concurrency-safe 200-message rolling 24-hour cap.

The worker records Gmail API acceptance, which is not proof of inbox delivery.
The Gmail outbox page can show and retry eligible failures. An admin can use
**Send next batch now** to process currently due messages up to the configured
batch limit. Automatic sending also requires the Edge Function and scheduler
to be deployed and enabled.
For the remaining activation steps and sender/OAuth setup requirements, see
[URLs needed](./URLs%20needed.md).
