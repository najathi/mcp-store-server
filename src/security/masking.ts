/**
 * PII masking applied before customer data leaves the server.
 * The model gets enough to recognise a customer ("Ava T.", "a***@example.com")
 * without receiving contact details it does not need.
 */

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***-***-${digits.slice(-4)}`;
}

/** "Ava Thompson" becomes "Ava T." */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? `${first} ${last[0]}.` : first;
}
