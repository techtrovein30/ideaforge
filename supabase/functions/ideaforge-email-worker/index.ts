import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildPaymentConfirmation,
  type PaymentConfirmation,
} from "./content.ts";
import {
  fetchAccessToken,
  gmailSendMessage,
  GmailSendError,
  type AccessTokenCache,
  type GmailConfig,
} from "./gmail.ts";
import {
  processClaimedEmails,
  type ClaimedEmail,
  type WorkerDependencies,
} from "./worker-core.ts";

const SENDING_ENABLED = Deno.env.get("IDEAFORGE_EMAIL_SENDING_ENABLED") === "true";
const WORKER_TOKEN = Deno.env.get("IDEAFORGE_EMAIL_WORKER_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BATCH_SIZE = Math.max(
  1,
  Math.min(Number.parseInt(Deno.env.get("IDEAFORGE_EMAIL_BATCH_SIZE") ?? "20", 10) || 20, 100),
);
const STALE_MINUTES = Math.max(
  5,
  Math.min(Number.parseInt(Deno.env.get("IDEAFORGE_EMAIL_STALE_MINUTES") ?? "15", 10) || 15, 60),
);

const GMAIL_CONFIG: GmailConfig = {
  clientId: Deno.env.get("GMAIL_CLIENT_ID") ?? "",
  clientSecret: Deno.env.get("GMAIL_CLIENT_SECRET") ?? "",
  refreshToken: Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "",
  fromEmail: Deno.env.get("IDEAFORGE_GMAIL_FROM") ?? "",
  fromName: Deno.env.get("IDEAFORGE_GMAIL_FROM_NAME") ?? "IdeaForge Hackathon",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function safeError(error: unknown): string {
  if (error instanceof GmailSendError) {
    return `${error.kind} Gmail error (${error.status}): ${error.message}`;
  }
  return error instanceof Error
    ? `Send failed: ${error.message.slice(0, 500)}`
    : "Unknown send failure; delivery outcome is uncertain.";
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!WORKER_TOKEN || !constantTimeEqual(bearer, WORKER_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (!SENDING_ENABLED) {
    return json({ enabled: false, note: "Email sending is disabled by server configuration." });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "missing_supabase_environment" }, 500);
  }

  if (
    !GMAIL_CONFIG.clientId || !GMAIL_CONFIG.clientSecret ||
    !GMAIL_CONFIG.refreshToken || !GMAIL_CONFIG.fromEmail
  ) {
    return json({ error: "missing_gmail_environment" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tokenCache: AccessTokenCache = { token: "", expiresAt: 0 };
  try {
    await fetchAccessToken(GMAIL_CONFIG, tokenCache);
  } catch (error) {
    console.error("[ideaforge-email-worker] Gmail authorization preflight failed:", safeError(error));
    return json({ error: "gmail_authorization_unavailable" }, 503);
  }

  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  const { error: staleError } = await admin
    .from("ideaforge_email_outbox")
    .update({
      status: "failed",
      locked_at: null,
      retryable: false,
      last_error: "Worker stopped after claiming this email; verify Gmail delivery before retrying.",
    })
    .eq("status", "sending")
    .lt("locked_at", staleBefore);
  if (staleError) {
    console.error("[ideaforge-email-worker] Could not recover stale claims:", staleError.message);
    return json({ error: "stale_claim_recovery_failed" }, 500);
  }

  const { data, error: claimError } = await admin.rpc("ideaforge_email_claim", {
    p_limit: BATCH_SIZE,
  });
  if (claimError) {
    console.error("[ideaforge-email-worker] Could not claim queue rows:", claimError.message);
    return json({ error: "queue_claim_failed" }, 500);
  }
  const rows = (data ?? []) as ClaimedEmail[];

  const dependencies: WorkerDependencies = {
    send: async (row) => {
      if (!row.recipient_email) {
        throw new Error("No recipient email was recorded.");
      }
      const content = buildPaymentConfirmation({
        teamName: row.team_name,
        teamCode: row.team_code,
        recipientName: row.recipient_name,
        memberNames: row.member_names ?? [],
      } satisfies PaymentConfirmation);
      return await gmailSendMessage(GMAIL_CONFIG, tokenCache, {
        fromEmail: GMAIL_CONFIG.fromEmail,
        fromName: GMAIL_CONFIG.fromName,
        toEmail: row.recipient_email,
        toName: row.recipient_name ?? "",
        ...content,
      });
    },
    markSent: async (id, messageId) => {
      const { error } = await admin
        .from("ideaforge_email_outbox")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          locked_at: null,
          gmail_message_id: messageId,
          last_error: null,
        })
        .eq("id", id)
        .eq("status", "sending");
      if (error) throw new Error(`Could not record successful send: ${error.message}`);
    },
    markRetry: async (id, errorMessage, retryAt) => {
      const { error } = await admin
        .from("ideaforge_email_outbox")
        .update({
          status: "pending",
          next_attempt_at: retryAt,
          locked_at: null,
          last_error: errorMessage,
        })
        .eq("id", id)
        .eq("status", "sending");
      if (error) throw new Error(`Could not schedule email retry: ${error.message}`);
    },
    markFailed: async (id, errorMessage, retryable) => {
      const { error } = await admin
        .from("ideaforge_email_outbox")
        .update({
          status: "failed",
          locked_at: null,
          retryable,
          last_error: errorMessage,
        })
        .eq("id", id)
        .eq("status", "sending");
      if (error) throw new Error(`Could not record email failure: ${error.message}`);
    },
    release: async (id, attemptCount) => {
      const { error } = await admin
        .from("ideaforge_email_outbox")
        .update({
          status: "pending",
          attempt_count: Math.max(attemptCount - 1, 0),
          locked_at: null,
          last_error: "Batch paused before this email was attempted.",
        })
        .eq("id", id)
        .eq("status", "sending");
      if (error) throw new Error(`Could not release an unattempted email: ${error.message}`);
    },
  };

  try {
    const result = await processClaimedEmails(rows, dependencies, Date.now, 5);
    return json({ enabled: true, ...result });
  } catch (error) {
    console.error("[ideaforge-email-worker] Batch persistence failed:", safeError(error));
    return json({ error: "batch_processing_failed" }, 500);
  }
});
