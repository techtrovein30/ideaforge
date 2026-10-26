import { GmailSendError } from "./gmail.ts";

export interface ClaimedEmail {
  id: string;
  recipient_email: string | null;
  recipient_name: string | null;
  team_name: string;
  team_code: string;
  member_names: string[] | null;
  attempt_count: number;
}

export interface WorkerDependencies {
  send(row: ClaimedEmail): Promise<{ id: string }>;
  markSent(id: string, messageId: string): Promise<void>;
  markRetry(id: string, error: string, retryAt: string): Promise<void>;
  markFailed(id: string, error: string, retryable: boolean): Promise<void>;
  release(id: string, attemptCount: number): Promise<void>;
}

export interface BatchResult {
  attempted: number;
  sent: number;
  retried: number;
  failed: number;
}

export function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(2 * 2 ** exponent, 60) * 60_000;
}

export async function processClaimedEmails(
  rows: ClaimedEmail[],
  dependencies: WorkerDependencies,
  now: () => number = Date.now,
  maxAttempts = 5,
): Promise<BatchResult> {
  const result: BatchResult = {
    attempted: 0,
    sent: 0,
    retried: 0,
    failed: 0,
  };

  for (const [index, row] of rows.entries()) {
    if (!row.recipient_email) {
      await dependencies.markFailed(row.id, "No recipient email was recorded.", false);
      result.failed += 1;
      continue;
    }

    result.attempted += 1;
    let response: { id: string };
    try {
      response = await dependencies.send(row);
    } catch (error) {
      if (error instanceof GmailSendError &&
        (error.kind === "transient" || error.kind === "quota") &&
        !error.deliveryUncertain &&
        row.attempt_count < maxAttempts) {
        await dependencies.markRetry(
          row.id,
          error.message,
          new Date(now() + retryDelayMs(row.attempt_count)).toISOString(),
        );
        result.retried += 1;
      } else {
        const message = error instanceof Error
          ? error.message
          : "Unknown send failure; delivery outcome is uncertain.";
        await dependencies.markFailed(
          row.id,
          message,
          error instanceof GmailSendError && !error.deliveryUncertain,
        );
        result.failed += 1;
      }

      if (error instanceof GmailSendError &&
        (error.kind === "auth" || error.kind === "quota")) {
        for (const unattempted of rows.slice(index + 1)) {
          await dependencies.release(unattempted.id, unattempted.attempt_count);
        }
        break;
      }
      continue;
    }

    await dependencies.markSent(row.id, response.id);
    result.sent += 1;
  }

  return result;
}
