import { describe, expect, it } from "vitest";
import { buildPaymentConfirmation } from "./content.ts";

describe("buildPaymentConfirmation", () => {
  it("builds IdeaForge-branded plain-text and HTML confirmation", () => {
    const mail = buildPaymentConfirmation({
      teamName: "Byte Builders",
      teamCode: "IF-ABC1234567",
      recipientName: "Asha",
      memberNames: ["Asha", "Ravi"],
    });

    expect(mail.subject).toBe("IdeaForge Hackathon — Byte Builders payment confirmed");
    expect(mail.text).toContain("Payment for Byte Builders has been approved");
    expect(mail.text).toContain("Team check-in code: IF-ABC1234567");
    expect(mail.html).toContain("Byte Builders");
    expect(mail.html).toContain("IF-ABC1234567");
    expect(mail.html).toContain("Asha");
    expect(mail.text).toContain("Ravi");
  });

  it("escapes user-provided team and participant names in HTML", () => {
    const mail = buildPaymentConfirmation({
      teamName: '<img src=x onerror="alert(1)">',
      teamCode: '<img src=x onerror="alert(1)">',
      recipientName: "<script>bad()</script>",
      memberNames: ["<b>Member</b>"],
    });

    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("Team check-in code: <strong><img");
    expect(mail.html).not.toContain("<b>Member</b>");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});
