export interface PaymentConfirmation {
  teamName: string;
  recipientName: string | null;
  memberNames: string[];
}

export interface DeliveryReport {
  teamName: string;
  teamCode: string;
  recipientName: string | null;
  recipientEmail: string;
  sentAt: string;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export function buildDeliveryReport(data: DeliveryReport): EmailContent {
  const teamName = escapeHtml(data.teamName);
  const teamCode = escapeHtml(data.teamCode);
  const recipientName = escapeHtml(data.recipientName ?? "Team Leader");
  const recipientEmail = escapeHtml(data.recipientEmail);
  const sentAt = escapeHtml(data.sentAt);

  return {
    subject: `IdeaForge confirmation sent — ${data.teamName}`,
    text: [
      "A team registration confirmation was accepted by Gmail.",
      "",
      `Team: ${data.teamName}`,
      `Team code: ${data.teamCode}`,
      `Team leader: ${data.recipientName ?? "Team Leader"}`,
      `Leader Gmail: ${data.recipientEmail}`,
      `Accepted by Gmail at: ${data.sentAt}`,
      "",
      "This is a delivery status report, not a copy of the confirmation email.",
      "Gmail API acceptance does not guarantee inbox delivery.",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f6f2;font-family:Arial,sans-serif;color:#17231e">
    <main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border-radius:16px">
      <p style="color:#4d7d5c;font-weight:700;letter-spacing:.12em">IDEAFORGE DELIVERY REPORT</p>
      <h1 style="font-size:24px">Confirmation accepted by Gmail</h1>
      <p><strong>Team:</strong> ${teamName}</p>
      <p><strong>Team code:</strong> ${teamCode}</p>
      <p><strong>Team leader:</strong> ${recipientName}</p>
      <p><strong>Leader Gmail:</strong> ${recipientEmail}</p>
      <p><strong>Accepted by Gmail at:</strong> ${sentAt}</p>
      <p>This is a delivery status report, not a copy of the confirmation email. Gmail API acceptance does not guarantee inbox delivery.</p>
    </main>
  </body>
</html>`,
  };
}

export function buildPaymentConfirmation(data: PaymentConfirmation): EmailContent {
  const safeTeamName = escapeHtml(data.teamName);
  const safeLeaderName = escapeHtml(data.recipientName ?? "Team Leader");
  const greetingText = data.recipientName
    ? `Dear ${data.recipientName},`
    : "Dear Team Leader,";
  const greetingHtml = data.recipientName
    ? `Dear ${safeLeaderName},`
    : "Dear Team Leader,";
  const names = data.memberNames.map(escapeHtml);
  const membersText = data.memberNames.length
    ? data.memberNames.map((name) => `- ${name}`).join("\n")
    : "- No member details were provided.";
  const membersHtml = names.length
    ? `<ul>${names.map((name) => `<li>${name}</li>`).join("")}</ul>`
    : "<ul><li>No member details were provided.</li></ul>";
  const communityUrl = "https://chat.whatsapp.com/FNZ8hTDSRKgE213TR1f8cU";

  return {
    subject: `IdeaForge 2026 — ${data.teamName} team registration confirmation`,
    text: [
      greetingText,
      "",
      "Greetings from the IdeaForge Organizing Team!",
      "",
      "We are pleased to confirm that your team has been successfully registered for IdeaForge 2026, the hackathon scheduled for November 6, 2026.",
      "",
      "Here are your team registration details:",
      "",
      `Team Name: ${data.teamName}`,
      `Team Leader: ${data.recipientName ?? "Team Leader"}`,
      "Team Members:",
      membersText,
      "",
      "Please verify the team details above and inform us if any corrections are required.",
      "",
      "Join the IdeaForge Community",
      "",
      "If you have not joined the IdeaForge WhatsApp community yet, please join using the link below. Important event updates, announcements, and further instructions will be shared through the community.",
      communityUrl,
      "",
      "We look forward to your team's participation and wish you the very best for IdeaForge 2026!",
      "",
      "Best regards,",
      "IdeaForge Organizing Team",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f6f2;font-family:Arial,sans-serif;color:#17231e">
    <main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border-radius:16px">
      <p style="color:#4d7d5c;font-weight:700;letter-spacing:.12em">IDEAFORGE HACKATHON</p>
      <h1 style="font-size:24px">IdeaForge 2026 Team Registration Confirmation</h1>
      <p>${greetingHtml}</p>
      <p>Greetings from the IdeaForge Organizing Team!</p>
      <p>We are pleased to confirm that your team has been successfully registered for <strong>IdeaForge 2026</strong>, the hackathon scheduled for <strong>November 6, 2026</strong>.</p>
      <p>Here are your team registration details:</p>
      <p><strong>Team Name:</strong> ${safeTeamName}<br>
      <strong>Team Leader:</strong> ${safeLeaderName}</p>
      <h2 style="font-size:16px">Team Members</h2>
      ${membersHtml}
      <p>Please verify the team details above and inform us if any corrections are required.</p>
      <h2 style="font-size:16px">Join the IdeaForge Community</h2>
      <p>If you have not joined the IdeaForge WhatsApp community yet, please join using the link below. Important event updates, announcements, and further instructions will be shared through the community.</p>
      <p><a href="${communityUrl}">${communityUrl}</a></p>
      <p>We look forward to your team's participation and wish you the very best for IdeaForge 2026!</p>
      <p>Best regards,<br>IdeaForge Organizing Team</p>
    </main>
  </body>
</html>`,
  };
}
