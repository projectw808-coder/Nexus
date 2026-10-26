import {
  ArrowDown,
  Ban,
  CircleCheck,
  CircleX,
  Flag,
  Flame,
  PhoneCall,
  PhoneMissed,
  PhoneOutgoing,
  ShieldCheck,
  ShieldEllipsis,
  Sparkles,
  Star,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  countryName,
  countryOf,
  flagOf,
  initials,
  PRIORITY_TONE,
  STATUS_TONE,
  TONE_CLASS,
  type Tone,
} from '@/lib/clients';

const STATUS_ICON: Record<string, LucideIcon> = {
  new: Sparkles,
  contacted: PhoneOutgoing,
  interested: Star,
  callback: PhoneCall,
  no_answer: PhoneMissed,
  kyc_pending: ShieldEllipsis,
  kyc_completed: ShieldCheck,
  active_client: CircleCheck,
  not_interested: CircleX,
  invalid_lead: Ban,
};

const PRIORITY_ICON: Record<string, LucideIcon> = { high: Flame, medium: Flag, low: ArrowDown };

export function Pill({
  tone,
  icon: Icon,
  children,
  className = '',
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-[6px] px-2 text-[11px] font-semibold ${TONE_CLASS[tone]} ${className}`}
    >
      {Icon ? (
        <Icon aria-hidden size={11} strokeWidth={2.5} />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      {children}
    </span>
  );
}

export function StatusPill({ id, label }: { id: string | null; label: string | undefined }) {
  if (!id) return <span className="text-ink-muted">—</span>;
  return (
    <Pill tone={STATUS_TONE[id] ?? 'gray'} icon={STATUS_ICON[id]}>
      {label ?? id}
    </Pill>
  );
}

export function PriorityPill({ id, label }: { id: string | null; label: string | undefined }) {
  if (!id) return <span className="text-ink-muted">—</span>;
  return (
    <Pill tone={PRIORITY_TONE[id] ?? 'gray'} icon={PRIORITY_ICON[id]}>
      {label ?? id}
    </Pill>
  );
}

/** Deterministic, non-photographic avatar: initials over one of a few muted gradients. */
const AVATAR_BG = [
  'bg-[linear-gradient(135deg,#64798d,#253b4e)]',
  'bg-[linear-gradient(135deg,#7a6a5c,#3b2c22)]',
  'bg-[linear-gradient(135deg,#5c7a6d,#223b31)]',
  'bg-[linear-gradient(135deg,#6d6489,#2c2546)]',
  'bg-[linear-gradient(135deg,#8a6464,#45262a)]',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size / 3)) }}
      className={`grid shrink-0 place-items-center rounded-full border border-white/15 font-bold text-white ${AVATAR_BG[hash(name) % AVATAR_BG.length]}`}
    >
      {initials(name)}
    </span>
  );
}

/** Flag + ISO code (or full name), from the stored country or the phone's dial code. */
export function CountryTag({
  country,
  phone,
  full = false,
}: {
  country: string | null;
  phone: string | null;
  full?: boolean;
}) {
  const iso = countryOf(country, phone);
  if (!iso) return <span className="text-ink-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="font-[family-name:var(--font-emoji)] text-[13px] leading-none">
        {flagOf(iso)}
      </span>
      <span>{full ? countryName(iso) : iso === 'GB' ? 'UK' : iso}</span>
    </span>
  );
}
