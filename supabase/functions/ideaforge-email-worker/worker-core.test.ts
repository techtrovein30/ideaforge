import { describe, expect, it, vi } from "vitest";
import { GmailSendError } from "./gmail.ts";
import { processClaimedEmails, retryDelayMs, type WorkerDependencies } from "./worker-core.ts";

const row = {
  id: "queue-id",
  recipient_email: "contact@example.com",
  recipient_name: "Contact",
  team_name: "Demo Team",
  team_code: "IF-ABC1234567",
  member_names: ["Contact", "Member"],
  attempt_count: 1,
};

function dependencies(
  send: WorkerDependencies["send"],
): WorkerDependencies {
  return {
    send,
    markSent: vi.fn(async () => {}),
    markRetry: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
}

describe("IdeaForge email worker core", () => {
  it("records a successful provider acceptance", async () => {
    const deps = dependencies(async () => ({ id: "gmail-message-id" }));
    const result = await processClaimedEmails([row], deps);

    expect(result).toEqual({ attempted: 1, sent: 1, retried: 0, failed: 0 });
    expect(deps.markSent).toHaveBeenCalledWith("queue-id", "gmail-message-id");
  });

  it("leaves a claimed row for conservative stale recovery if recording acceptance fails", async () => {
    const deps = dependencies(async () => ({ id: "gmail-message-id" }));
    vi.mocked(deps.markSent).mockRejectedValue(new Error("database unavailable"));

    await expect(processClaimedEmails([row], deps)).rejects.toThrow("database unavailable");
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.markRetry).not.toHaveBeenCalled();
  });

  it("retries transient provider failures with exponential backoff", async () => {
    const deps = dependencies(async () => {
      throw new GmailSendError("quota", 429, "Gmail rate limit.");
    });
    const result = await processClaimedEmails([row], deps, () => 0);

    expect(result.retried).toBe(1);
    expect(deps.markRetry).toHaveBeenCalledWith(
      "queue-id",
      "Gmail rate limit.",
      new Date(120_000).toISOString(),
    );
  });

  it("fails permanent errors and uncertain delivery errors without blind retry", async () => {
    const permanent = dependencies(async () => {
      throw new GmailSendError("auth", 401, "Authorization rejected.");
    });
    const unknown = dependencies(async () => {
      throw new TypeError("network disconnected");
    });

    const permanentResult = await processClaimedEmails([row], permanent);
    const unknownResult = await processClaimedEmails([row], unknown);

    expect(permanentResult.failed).toBe(1);
    expect(unknownResult.failed).toBe(1);
    expect(permanent.markRetry).not.toHaveBeenCalled();
    expect(unknown.markRetry).not.toHaveBeenCalled();
  });

  it("fails rows after the maximum attempt count and detects missing recipients", async () => {
    const deps = dependencies(async () => {
      throw new GmailSendError("quota", 429, "Gmail rate limit.");
    });
    const noRecipient = { ...row, recipient_email: null };

    const result = await processClaimedEmails([{ ...row, attempt_count: 5 }], deps);
    const missingRecipientResult = await processClaimedEmails([noRecipient], deps);

    expect(result.failed).toBe(1);
    expect(missingRecipientResult.failed).toBe(1);
    expect(deps.markRetry).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenNthCalledWith(
      1,
      "queue-id",
      "Gmail rate limit.",
      true,
    );
    expect(deps.markFailed).toHaveBeenNthCalledWith(
      2,
      "queue-id",
      "No recipient email was recorded.",
      false,
    );
  });

  it("does not mark uncertain network outcomes safe for manual retry", async () => {
    const deps = dependencies(async () => {
      throw new TypeError("network disconnected");
    });

    await processClaimedEmails([row], deps);

    expect(deps.markFailed).toHaveBeenCalledWith(
      "queue-id",
      "network disconnected",
      false,
    );
  });

  it("does not automatically retry a Gmail server error with uncertain delivery", async () => {
    const deps = dependencies(async () => {
      throw new GmailSendError("transient", 503, "Gmail server error.", true);
    });
    await processClaimedEmails([row], deps);

    expect(deps.markRetry).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith(
      "queue-id",
      "Gmail server error.",
      false,
    );
  });

  it("halts a batch on authorization or quota errors and releases unattempted claims", async () => {
    const deps = dependencies(async () => {
      throw new GmailSendError("auth", 401, "Authorization rejected.");
    });
    const second = { ...row, id: "queue-id-2", attempt_count: 1 };

    const result = await processClaimedEmails([row, second], deps);

    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(1);
    expect(deps.release).toHaveBeenCalledWith("queue-id-2", 1);
  });

  it("caps exponential retry delay at one hour", () => {
    expect(retryDelayMs(1)).toBe(2 * 60_000);
    expect(retryDelayMs(20)).toBe(60 * 60_000);
  });
});
