/**
 * Client-safe helpers for the Clients workspace: pill tones, the country fallback from a phone
 * number's dial code, and the relative date labels the table and drawer print.
 */

export type Tone = 'green' | 'blue' | 'amber' | 'purple' | 'gray' | 'lime' | 'red';

/** Each pair is contrast-checked (≥4.5:1, 11px text) against its own fill, so it reads on either theme. */
export const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-[#0d4637] text-[#35e6a2]',
  blue: 'bg-[#113e80] text-[#7cc0ff]',
  amber: 'bg-[#4b340a] text-[#ffbf33]',
  purple: 'bg-[#472079] text-[#d8b0ff]',
  gray: 'bg-[#303b47] text-[#c8d0db]',
  lime: 'bg-[#35500e] text-[#a8fb5a]',
  red: 'bg-[#61292f] text-[#ffa4a8]',
};

export const STATUS_TONE: Record<string, Tone> = {
  new: 'blue',
  contacted: 'purple',
  interested: 'green',
  callback: 'amber',
  no_answer: 'gray',
  kyc_pending: 'lime',
  kyc_completed: 'amber',
  active_client: 'green',
  not_interested: 'red',
  invalid_lead: 'gray',
};

export const PRIORITY_TONE: Record<string, Tone> = { high: 'red', medium: 'amber', low: 'green' };

// Longest prefix wins, so +1 (US) never shadows +1 868 etc. once added; NANP stays "US".
const DIAL_CODES: [string, string][] = [
  ['1', 'US'],
  ['7', 'RU'],
  ['20', 'EG'],
  ['27', 'ZA'],
  ['30', 'GR'],
  ['31', 'NL'],
  ['32', 'BE'],
  ['33', 'FR'],
  ['34', 'ES'],
  ['36', 'HU'],
  ['39', 'IT'],
  ['40', 'RO'],
  ['41', 'CH'],
  ['43', 'AT'],
  ['44', 'GB'],
  ['45', 'DK'],
  ['46', 'SE'],
  ['47', 'NO'],
  ['48', 'PL'],
  ['49', 'DE'],
  ['52', 'MX'],
  ['54', 'AR'],
  ['55', 'BR'],
  ['56', 'CL'],
  ['57', 'CO'],
  ['60', 'MY'],
  ['61', 'AU'],
  ['62', 'ID'],
  ['63', 'PH'],
  ['64', 'NZ'],
  ['65', 'SG'],
  ['66', 'TH'],
  ['81', 'JP'],
  ['82', 'KR'],
  ['84', 'VN'],
  ['86', 'CN'],
  ['90', 'TR'],
  ['91', 'IN'],
  ['92', 'PK'],
  ['212', 'MA'],
  ['234', 'NG'],
  ['254', 'KE'],
  ['351', 'PT'],
  ['352', 'LU'],
  ['353', 'IE'],
  ['356', 'MT'],
  ['357', 'CY'],
  ['358', 'FI'],
  ['359', 'BG'],
  ['370', 'LT'],
  ['371', 'LV'],
  ['372', 'EE'],
  ['380', 'UA'],
  ['381', 'RS'],
  ['385', 'HR'],
  ['386', 'SI'],
  ['420', 'CZ'],
  ['421', 'SK'],
  ['852', 'HK'],
  ['886', 'TW'],
  ['961', 'LB'],
  ['962', 'JO'],
  ['965', 'KW'],
  ['966', 'SA'],
  ['971', 'AE'],
  ['972', 'IL'],
  ['974', 'QA'],
];

/** ISO 3166-1 alpha-2: the stored country, else the phone's dial code, else null. */
export function countryOf(country: string | null, phone: string | null): string | null {
  if (country && /^[A-Za-z]{2}$/.test(country.trim())) return country.trim().toUpperCase();
  if (!phone?.startsWith('+')) return null;
  const digits = phone.slice(1).replace(/\D/g, '');
  let best: string | null = null;
  let bestLen = 0;
  for (const [code, iso] of DIAL_CODES) {
    if (code.length > bestLen && digits.startsWith(code)) {
      best = iso;
      bestLen = code.length;
    }
  }
  return best;
}

/** Regional-indicator pair; rendered with the colour-emoji font so Windows shows a real flag. */
export function flagOf(iso: string): string {
  return String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

export function countryName(iso: string): string {
  try {
    return regionNames?.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/** "+447700900123" → "+44 7700 900123"; leaves anything it doesn't recognise alone. */
export function formatPhone(phone: string | null): string {
  if (!phone) return '—';
  const d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+1') && d.length === 12)
    return `+1 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  if (d.startsWith('+44') && d.length === 13) return `+44 ${d.slice(3, 7)} ${d.slice(7)}`;
  const iso = countryOf(null, d);
  const code = iso ? DIAL_CODES.find(([, i]) => i === iso)?.[0] : undefined;
  if (code && d.startsWith(`+${code}`)) {
    const rest = d.slice(code.length + 1);
    return `+${code} ${rest.replace(/(\d{3})(?=\d{3,})/g, '$1 ')}`;
  }
  return phone;
}

/** Best-effort E.164 for the Add Client form (the PHONE attribute rejects anything else). */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('00')
    ? `+${trimmed.slice(2).replace(/\D/g, '')}`
    : trimmed.replace(/(?!^\+)[^\d]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (
    parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts.at(-1)![0]!
  ).toUpperCase();
}

const DAY = 86_400_000;

function startOfDay(d: Date, utc = false): number {
  return utc
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const time = (d: Date, utc = false) =>
  d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(utc ? { timeZone: 'UTC' } : {}),
  });

/**
 * "Today, 14:22" · "Yesterday, 11:05" · "Tomorrow, 10:00" · "3 days ago" · "12 Oct". `utc` gives
 * a time-zone-independent label, for a server render that must match the hydration pass.
 */
export function dayLabel(iso: string | null, now = new Date(), utc = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Math.round((startOfDay(d, utc) - startOfDay(now, utc)) / DAY);
  if (diff === 0) return `Today, ${time(d, utc)}`;
  if (diff === -1) return `Yesterday, ${time(d, utc)}`;
  if (diff === 1) return `Tomorrow, ${time(d, utc)}`;
  if (diff < 0 && diff >= -6) return `${-diff} days ago`;
  if (diff < 0 && diff >= -13) return '1 week ago';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(utc ? { timeZone: 'UTC' } : {}),
  });
}

/** Due when the follow-up falls before the end of today (so overdue counts too). */
export function isDue(iso: string | null, now = new Date()): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t < startOfDay(now) + DAY;
}

/** `<input type="datetime-local">` value for an ISO instant, in the browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
