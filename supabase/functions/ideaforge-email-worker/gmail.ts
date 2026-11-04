export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fromEmail: string;
  fromName: string;
}

export interface AccessTokenCache {
  token: string;
  expiresAt: number;
}

export type GmailErrorKind = "auth" | "quota" | "invalid" | "transient";

export class GmailSendError extends Error {
  constructor(
    readonly kind: GmailErrorKind,
    readonly status: number,
    message: string,
    readonly deliveryUncertain = false,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

function networkErrorDetail(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && details.length < 4) {
    seen.add(current);
    if (current instanceof Error) {
      details.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else if (typeof current === "string") {
      details.push(current);
      break;
    } else {
      break;
    }
  }

  const detail = details.join(" <- ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\b(authorization|access_token|refresh_token|client_secret)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
  return detail || "No network error detail was provided.";
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64urlEncode(value: string): string {
  return toBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function encodeHeaderWord(value: string): string {
  const safe = safeHeaderValue(value);
  if (/^[\x00-\x7F]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${toBase64(safe)}?=`;
}

export interface MailParts {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  toName: string;
  subject: string;
  html: string;
  text: string;
}

function formatAddress(email: string, name: string): string {
  if (!/^[^@\s<>]+@[^@\s<>]+$/.test(email)) {
    throw new GmailSendError("invalid", 400, "Invalid email address.");
  }
  const cleanName = encodeHeaderWord(name);
  return cleanName ? `${cleanName} <${email}>` : email;
}

export function buildRawMessage(parts: MailParts): string {
  const boundary = `----=_IdeaForge_${crypto.randomUUID()}`;
  const messageIdDomain = parts.fromEmail.split("@")[1] ?? "localhost";
  const headers = [
    `From: ${formatAddress(parts.fromEmail, parts.fromName)}`,
    `To: ${formatAddress(parts.toEmail, parts.toName)}`,
    `Subject: ${encodeHeaderWord(parts.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <ideaforge-${crypto.randomUUID()}@${messageIdDomain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    toBase64(parts.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    toBase64(parts.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return `${headers}\r\n\r\n${body}`;
}

export function classifySendError(
  status: number,
  body: string,
  deliveryUncertain = false,
): GmailSendError {
  const normalized = body.toLowerCase();
  let providerReason = "";
  try {
    const payload = JSON.parse(body) as {
      error?: {
        errors?: { reason?: string }[];
        status?: string;
      };
    };
    providerReason = payload.error?.errors?.[0]?.reason ??
      payload.error?.status ??
      "";
  } catch {
    // Providers may return plain text instead of a JSON error.
  }
  if (!/^[\w.-]{1,80}$/.test(providerReason)) providerReason = "";
  const reason = providerReason.toLowerCase();
  if (normalized.includes("invalid_grant") || normalized.includes("invalid_client")) {
    return new GmailSendError("auth", status, "Gmail OAuth credentials were rejected.");
  }
  if (
    status === 429 ||
    reason.includes("ratelimit") ||
    reason.includes("dailylimit") ||
    reason.includes("quota") ||
    normalized.includes("ratelimitexceeded") ||
    normalized.includes("quota") ||
    normalized.includes("daily limit")
  ) {
    return new GmailSendError("quota", status, "Gmail rate limit or quota reached.");
  }
  if (status === 401) {
    return new GmailSendError(
      "auth",
      status,
      "Gmail rejected the access token; verify the OAuth credentials and refresh token.",
    );
  }
  if (status === 403) {
    const detail = providerReason ? ` (${providerReason})` : "";
    const message = reason.includes("insufficientpermissions")
      ? "Gmail authorization lacks the gmail.send permission. Reauthorize the sender account with the gmail.send scope, update GMAIL_REFRESH_TOKEN, and retry."
      : "Gmail rejected sender authorization. Confirm GMAIL_REFRESH_TOKEN belongs to the account in IDEAFORGE_GMAIL_FROM (or an authorized sender alias) and was granted the gmail.send scope, then retry.";
    return new GmailSendError("auth", status, `${message}${detail}`);
  }
  if (status >= 500) {
    return new GmailSendError(
      "transient",
      status,
      `Gmail returned HTTP ${status}.`,
      deliveryUncertain,
    );
  }
  return new GmailSendError("invalid", status, `Gmail rejected the message (HTTP ${status}).`);
}

export async function fetchAccessToken(
  config: GmailConfig,
  cache: AccessTokenCache,
): Promise<string> {
  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 30_000) return cache.token;

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (error) {
    throw new GmailSendError(
      "transient",
      0,
      `Could not reach the Gmail OAuth token endpoint: ${networkErrorDetail(error)}`,
    );
  }
  const body = await response.text();
  if (!response.ok) throw classifySendError(response.status, body);

  let payload: { access_token?: string; expires_in?: number };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new GmailSendError("auth", response.status, "Gmail token response was invalid.");
  }
  if (!payload.access_token) {
    throw new GmailSendError("auth", response.status, "Gmail token response had no access token.");
  }

  cache.token = payload.access_token;
  cache.expiresAt = now + (payload.expires_in ?? 3600) * 1000 - 60_000;
  return cache.token;
}

export async function gmailSendMessage(
  config: GmailConfig,
  cache: AccessTokenCache,
  parts: MailParts,
): Promise<{ id: string }> {
  const token = await fetchAccessToken(config, cache);
  const requestBody = JSON.stringify({ raw: base64urlEncode(buildRawMessage(parts)) });
  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
      },
    );
  } catch (error) {
    throw new GmailSendError(
      "transient",
      0,
      `Gmail send request outcome is unknown (${networkErrorDetail(error)}); verify delivery before retrying.`,
      true,
    );
  }
  const body = await response.text();
  if (!response.ok) throw classifySendError(response.status, body, true);

  let payload: { id?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new GmailSendError(
      "transient",
      response.status,
      "Gmail send response was invalid.",
      true,
    );
  }
  if (!payload.id) {
    throw new GmailSendError(
      "transient",
      response.status,
      "Gmail send response had no message id.",
      true,
    );
  }
  return { id: payload.id };
}
