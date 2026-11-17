/**
 * Who may put documents into the knowledge base by sharing them with the service account.
 *
 * Sharing a Drive document with an address needs no acceptance on the other side, and a service account is just an
 * address. So with drive.scope "shared", anyone who learns that address could plant a document that then shows up
 * in every user's search results and in the index. `drive.trustedOwners` closes this: a document shared outside the
 * roots is shown only when the top shared item belongs to a listed owner.
 *
 * This file has no imports and reads no config, so the setup commands can use the same rule.
 */

/** Does `entry` (an email, a domain, "drive:<id>" or "*") cover one of these owners or this shared drive? */
export function ownerMatches(entry: string, owners: string[], driveId?: string | null): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e === '*') return true;
  if (e.startsWith('drive:')) return !!driveId && driveId.toLowerCase() === e.slice(6);
  const domain = e.startsWith('@') ? e.slice(1) : e.includes('@') ? null : e;
  return owners.some((o) => {
    const email = o.trim().toLowerCase();
    return domain ? email.endsWith(`@${domain}`) : email === e;
  });
}

/** Is this owner (or shared drive) covered by the list? An empty list trusts nobody. */
export function isTrusted(list: string[], owners: string[] | undefined, driveId?: string | null): boolean {
  return list.some((entry) => ownerMatches(entry, owners ?? [], driveId));
}

// Mail providers where a domain says nothing about who the person is. Trusting "gmail.com" would trust everyone.
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.jp', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com',
  'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
]);

/**
 * The entry to suggest for an owner: the whole domain for an organization's own domain, the single address for a
 * public mail provider.
 */
export function trustEntryFor(email: string): string | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return null;
  const domain = e.slice(at + 1);
  if (domain.endsWith('.gserviceaccount.com')) return null; // another service account is not a person to trust by default
  return PUBLIC_MAIL_DOMAINS.has(domain) ? e : domain;
}

/** Is this a well-formed trust entry? Rejects a bare public mail domain, which would trust every user of it. */
export function validTrustEntry(entry: string): true | string {
  const e = entry.trim().toLowerCase();
  if (e === '*') return true;
  if (/^drive:[a-z0-9_-]+$/i.test(e)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return true;
  const domain = e.startsWith('@') ? e.slice(1) : e;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return `"${entry}" is not an email, a domain or drive:<id>`;
  if (PUBLIC_MAIL_DOMAINS.has(domain)) return `"${domain}" is a public mail provider: trusting it would trust everyone who has an address there. List the addresses instead`;
  return true;
}
