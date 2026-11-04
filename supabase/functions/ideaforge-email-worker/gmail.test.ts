import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64urlEncode,
  buildRawMessage,
  classifySendError,
  encodeHeaderWord,
  fetchAccessToken,
  gmailSendMessage,
  type GmailConfig,
} from "./gmail.ts";

const CONFIG: GmailConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  fromEmail: "noreply@example.com",
  fromName: "IdeaForge",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail provider helpers", () => {
  it("encodes UTF-8 as unpadded base64url", () => {
    expect(base64urlEncode("héllo ✓")).toBe("aMOpbGxvIOKckw");
  });

  it("encodes non-ASCII header values and strips header newlines", () => {
    expect(encodeHeaderWord("IdeaForge — confirmed")).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeaderWord("hello\r\nBcc: victim@example.com")).toBe(
      "hello Bcc: victim@example.com",
    );
  });

  it("assembles a multipart message with validated addresses", () => {
    const raw = buildRawMessage({
      fromEmail: "noreply@example.com",
      fromName: "IdeaForge",
      toEmail: "team@example.com",
      toName: "Team Contact",
      subject: "Payment confirmed",
      html: "<p>Approved</p>",
      text: "Approved",
    });

    expect(raw).toContain("From: IdeaForge <noreply@example.com>");
    expect(raw).toContain("To: Team Contact <team@example.com>");
    expect(raw).not.toContain("\r\nBcc:");
    expect(raw).toContain("multipart/alternative");
    expect(() => buildRawMessage({
      fromEmail: "bad\r\nBcc: attacker@example.com",
      fromName: "IdeaForge",
      toEmail: "team@example.com",
      toName: "",
      subject: "Subject",
      html: "",
      text: "",
    })).toThrow("Invalid email address.");
  });

  it("classifies auth, quota, transient, and permanent errors", () => {
    expect(classifySendError(400, '{"error":"invalid_grant"}').kind).toBe("auth");
    expect(classifySendError(429, "rate limit").kind).toBe("quota");
    expect(classifySendError(503, "unavailable", true).deliveryUncertain).toBe(true);
    expect(classifySendError(400, "invalid message").kind).toBe("invalid");
  });

  it("explains Gmail sender authorization failures", () => {
    const missingScope = classifySendError(
      403,
      '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}',
    );
    const senderMismatch = classifySendError(
      403,
      '{"error":{"errors":[{"reason":"forbidden"}]}}',
    );

    expect(missingScope.message).toContain("lacks the gmail.send permission");
    expect(missingScope.message).toContain("(insufficientPermissions)");
    expect(senderMismatch.message).toContain("GMAIL_REFRESH_TOKEN belongs to the account");
    expect(senderMismatch.message).toContain("(forbidden)");
  });

  it("preserves OAuth endpoint network error details for diagnosis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const cache = { token: "", expiresAt: 0 };

    await expect(fetchAccessToken(CONFIG, cache)).rejects.toMatchObject({
      kind: "transient",
      deliveryUncertain: false,
      message: expect.stringContaining("network down"),
    });
  });

  it("preserves Gmail send network errors while marking delivery uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response('{"access_token":"test-token","expires_in":3600}'))
        .mockRejectedValueOnce(new TypeError("network down")),
    );

    await expect(gmailSendMessage(CONFIG, { token: "", expiresAt: 0 }, {
      fromEmail: CONFIG.fromEmail,
      fromName: CONFIG.fromName,
      toEmail: "team@example.com",
      toName: "Team",
      subject: "Approved",
      html: "<p>Approved</p>",
      text: "Approved",
    })).rejects.toMatchObject({
      kind: "transient",
      deliveryUncertain: true,
      message: expect.stringContaining("network down"),
    });
  });
});
