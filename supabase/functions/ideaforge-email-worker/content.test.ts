import { describe, expect, it } from "vitest";
import { buildDeliveryReport, buildPaymentConfirmation } from "./content.ts";

describe("buildDeliveryReport", () => {
  it("reports the team, leader, Gmail address, and Gmail acceptance time", () => {
    const report = buildDeliveryReport({
      teamName: "Byte Builders",
      teamCode: "IF-ABC123",
      recipientName: "Asha",
      recipientEmail: "asha@example.com",
      sentAt: "2026-11-02T15:00:00.000Z",
    });

    expect(report.subject).toBe("IdeaForge confirmation sent — Byte Builders");
    expect(report.text).toContain("Team: Byte Builders");
    expect(report.text).toContain("Team code: IF-ABC123");
    expect(report.text).toContain("Team leader: Asha");
    expect(report.text).toContain("Leader Gmail: asha@example.com");
    expect(report.text).toContain("Accepted by Gmail at: 2026-11-02T15:00:00.000Z");
    expect(report.text).toContain("not a copy of the confirmation email");
  });

  it("escapes names and addresses in the HTML report", () => {
    const report = buildDeliveryReport({
      teamName: "<script>team()</script>",
      teamCode: "IF-ABC123",
      recipientName: "<b>Leader</b>",
      recipientEmail: "leader@example.com",
      sentAt: "now",
    });

    expect(report.html).not.toContain("<script>");
    expect(report.html).not.toContain("<b>Leader</b>");
    expect(report.html).toContain("&lt;script&gt;");
    expect(report.html).toContain("&lt;b&gt;Leader&lt;/b&gt;");
  });
});

describe("buildPaymentConfirmation", () => {
  it("builds IdeaForge-branded plain-text and HTML confirmation", () => {
    const mail = buildPaymentConfirmation({
      teamName: "Byte Builders",
      recipientName: "Asha",
      memberNames: ["Asha", "Ravi"],
    });

    expect(mail.subject).toBe("IdeaForge 2026 — Byte Builders team registration confirmation");
    expect(mail.text).toContain("Dear Asha,");
    expect(mail.text).toContain("November 6, 2026");
    expect(mail.text).toContain("Team Name: Byte Builders");
    expect(mail.text).toContain("Team Leader: Asha");
    expect(mail.text).toContain("- Asha\n- Ravi");
    expect(mail.text).toContain("https://chat.whatsapp.com/FNZ8hTDSRKgE213TR1f8cU");
    expect(mail.html).toContain("Byte Builders");
    expect(mail.html).toContain("November 6, 2026");
    expect(mail.html).toContain("https://chat.whatsapp.com/FNZ8hTDSRKgE213TR1f8cU");
    expect(mail.html).toContain("Asha");
    expect(mail.text).toContain("Ravi");
  });

  it("escapes user-provided team and participant names in HTML", () => {
    const mail = buildPaymentConfirmation({
      teamName: '<img src=x onerror="alert(1)">',
      recipientName: "<script>bad()</script>",
      memberNames: ["<b>Member</b>"],
    });

    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<b>Member</b>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).toContain("<script>bad()</script>");
  });
});
