import Link from 'next/link';
import { Avatar } from '@/components/client-pills';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api';
import { isDue } from '@/lib/clients';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Line = {
  key: string;
  name: string;
  total: number;
  fresh: number;
  working: number;
  won: number;
  lost: number;
  due: number;
  contacted: number;
};

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

/** Team Performance: each agent's book, split by pipeline outcome, from the live client data. */
export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const data = await client.clientWorkspace.all();
  const category = new Map(data.statuses.map((s) => [s.id, s.category ?? 'open']));
  const base = `/w/${workspace.slug}`;

  const lines = new Map<string, Line>();
  const lineFor = (key: string, name: string): Line => {
    let l = lines.get(key);
    if (!l) {
      l = { key, name, total: 0, fresh: 0, working: 0, won: 0, lost: 0, due: 0, contacted: 0 };
      lines.set(key, l);
    }
    return l;
  };
  for (const a of data.agents) lineFor(a.id, a.name ?? a.email);
  for (const r of data.rows) {
    const l = r.ownerId
      ? lineFor(r.ownerId, data.agents.find((a) => a.id === r.ownerId)?.name ?? 'Former member')
      : lineFor('unassigned', 'Unassigned');
    l.total++;
    const cat = r.status ? category.get(r.status) : undefined;
    if (r.status === 'new') l.fresh++;
    else if (cat === 'won') l.won++;
    else if (cat === 'lost') l.lost++;
    else l.working++;
    if (isDue(r.nextFollowUp)) l.due++;
    if (r.lastContact) l.contacted++;
  }
  const rows = [...lines.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
  const totals = rows.reduce(
    (t, l) => ({
      total: t.total + l.total,
      won: t.won + l.won,
      due: t.due + l.due,
      contacted: t.contacted + l.contacted,
    }),
    { total: 0, won: 0, due: 0, contacted: 0 },
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team Performance"
        description="How each agent's book of clients is moving through the pipeline."
      />
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Clients', totals.total.toLocaleString('en-GB')],
          ['Active clients', totals.won.toLocaleString('en-GB')],
          ['Conversion', pct(totals.won, totals.total)],
          ['Follow-ups due', totals.due.toLocaleString('en-GB')],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[9px] border border-hairline bg-card px-4 py-3.5">
            <dt className="text-[13px] text-ink-secondary">{label}</dt>
            <dd className="tnum mt-1 text-[23px] font-bold">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="overflow-auto rounded-[8px] border border-hairline bg-card">
        <table className="w-full whitespace-nowrap text-[13px]">
          <thead className="bg-raised text-left text-ink-secondary">
            <tr className="h-[38px] border-b border-hairline">
              {[
                'Agent',
                'Clients',
                'New',
                'In progress',
                'Active',
                'Lost',
                'Contacted',
                'Follow-ups due',
                'Conversion',
              ].map((h) => (
                <th key={h} className="px-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map((l) => (
              <tr key={l.key} className="h-[46px] border-b border-hairline last:border-b-0">
                <td className="px-3">
                  <Link
                    href={`${base}/clients?agent=${l.key}`}
                    className="flex items-center gap-2.5 font-semibold hover:text-link"
                  >
                    <Avatar name={l.name} size={28} />
                    {l.name}
                  </Link>
                </td>
                <td className="px-3">{l.total}</td>
                <td className="px-3">{l.fresh}</td>
                <td className="px-3">{l.working}</td>
                <td className="px-3 text-[#35e6a2]">{l.won}</td>
                <td className="px-3">{l.lost}</td>
                <td className="px-3">{pct(l.contacted, l.total)}</td>
                <td className={`px-3 ${l.due ? 'font-medium text-[#ffb13e]' : ''}`}>{l.due}</td>
                <td className="px-3 font-semibold">{pct(l.won, l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12.5px] text-ink-muted">
        Active and lost follow each status&apos;s pipeline category; “Contacted” is the share of
        clients with a logged last contact.
      </p>
    </div>
  );
}
