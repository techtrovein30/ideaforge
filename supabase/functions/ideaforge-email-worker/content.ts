export interface PaymentConfirmation {
  teamName: string;
  teamCode: string;
  recipientName: string | null;
  memberNames: string[];
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

export function buildPaymentConfirmation(data: PaymentConfirmation): EmailContent {
  const safeTeamName = escapeHtml(data.teamName);
  const safeTeamCode = escapeHtml(data.teamCode);
  const greetingText = data.recipientName
    ? `Hi ${data.recipientName},`
    : "Hello,";
  const greetingHtml = data.recipientName
    ? `Hi ${escapeHtml(data.recipientName)},`
    : "Hello,";
  const names = data.memberNames.map(escapeHtml);
  const membersText = names.length ? names.join(", ") : "your team";
  const membersHtml = names.length
    ? `<ul>${names.map((name) => `<li>${name}</li>`).join("")}</ul>`
    : "<p>Your team.</p>";

  return {
    subject: `IdeaForge Hackathon — ${data.teamName} payment confirmed`,
    text: [
      greetingText,
      "",
      `Payment for ${data.teamName} has been approved. Your team registration is confirmed.`,
      "",
      `Team check-in code: ${data.teamCode}`,
      "Show the QR code in the team leader's IdeaForge profile at event check-in.",
      "",
      `Team members: ${membersText}`,
      "",
      "See you at IdeaForge!",
      "IdeaForge Organizing Team",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f6f2;font-family:Arial,sans-serif;color:#17231e">
    <main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border-radius:16px">
      <p style="color:#4d7d5c;font-weight:700;letter-spacing:.12em">IDEAFORGE HACKATHON</p>
      <h1 style="font-size:24px">Payment confirmed</h1>
      <p>${greetingHtml}</p>
      <p>Payment for <strong>${safeTeamName}</strong> has been approved. Your team registration is confirmed.</p>
      <p>Team check-in code: <strong>${safeTeamCode}</strong></p>
      <p>Show the QR code in the team leader's IdeaForge profile at event check-in.</p>
      <h2 style="font-size:16px">Team members</h2>
      ${membersHtml}
      <p>See you at IdeaForge!</p>
      <p style="color:#53645a">IdeaForge Organizing Team</p>
    </main>
  </body>
</html>`,
  };
}
