import { Megaphone } from 'lucide-react';
import Link from 'next/link';
import { LocalDateTime } from '@/components/local-time';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Line = {
  name: string;
  leads: number;
  fresh: number;
  interested: number;
  won: number;
  lost: number;
  sources: Map<string, number>;
  last: string;
};

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

/** Campaigns: every client's `campaign` value, with lead volume, outcomes and sources. */
export default async function CampaignsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const data = await client.clientWorkspace.all();
  const category = new Map(data.statuses.map((s) => [s.id, s.category ?? 'open']));
  const base = `/w/${workspace.slug}`;

  const lines = new Map<string, Line>();
  for (const r of data.rows) {
    const name = r.campaign ?? '(no campaign)';
    let l = lines.get(name);
    if (!l) {
      l = {
        name,
        leads: 0,
        fresh: 0,
        interested: 0,
        won: 0,
        lost: 0,
        sources: new Map(),
        last: r.createdAt,
      };
      lines.set(name, l);
    }
    l.leads++;
    const cat = r.status ? category.get(r.status) : undefined;
    if (r.status === 'new') l.fresh++;
    if (r.status === 'interested') l.interested++;
    if (cat === 'won') l.won++;
    if (cat === 'lost') l.lost++;
    if (r.source) l.sources.set(r.source, (l.sources.get(r.source) ?? 0) + 1);
    if (r.createdAt > l.last) l.last = r.createdAt;
  }
  const rows = [...lines.values()].sort((a, b) => b.leads - a.leads);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Campaigns"
        description="Lead volume and outcomes per campaign, from each client's Campaign field."
      />
      {rows.length === 0 ? (
        <div className="rounded-[9px] border border-hairline bg-card px-6 py-10 text-center text-[13.5px] text-ink-secondary">
          <Megaphone aria-hidden size={22} className="mx-auto mb-2 text-ink-muted" />
          No clients yet. Leads from your landing pages and imports appear here grouped by campaign.
        </div>
      ) : (
        <div className="overflow-auto rounded-[8px] border border-hairline bg-card">
          <table className="w-full whitespace-nowrap text-[13px]">
            <thead className="bg-raised text-left text-ink-secondary">
              <tr className="h-[38px] border-b border-hairline">
                {[
                  'Campaign',
                  'Leads',
                  'New',
                  'Interested',
                  'Active',
                  'Lost',
                  'Conversion',
                  'Top source',
                  'Latest lead',
                ].map((h) => (
                  <th key={h} className="px-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tnum">
              {rows.map((l) => {
                const top = [...l.sources.entries()].sort((a, b) => b[1] - a[1])[0];
                return (
                  <tr key={l.name} className="h-[44px] border-b border-hairline last:border-b-0">
                    <td className="px-3 font-semibold">
                      {l.name === '(no campaign)' ? (
                        <span className="text-ink-secondary">{l.name}</span>
                      ) : (
                        <Link
                          href={`${base}/clients?campaign=${encodeURIComponent(l.name)}`}
                          className="hover:text-link"
                        >
                          {l.name}
                        </Link>
                      )}
                    </td>
                    <td className="px-3">{l.leads}</td>
                    <td className="px-3">{l.fresh}</td>
                    <td className="px-3">{l.interested}</td>
                    <td className="px-3 text-[#35e6a2]">{l.won}</td>
                    <td className="px-3">{l.lost}</td>
                    <td className="px-3 font-semibold">{pct(l.won, l.leads)}</td>
                    <td className="px-3 text-ink-secondary">{top ? top[0] : '—'}</td>
                    <td className="px-3 text-ink-secondary">
                      <LocalDateTime iso={l.last} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
