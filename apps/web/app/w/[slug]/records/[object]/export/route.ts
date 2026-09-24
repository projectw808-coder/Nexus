import { api } from '@/lib/api';
import { describeError, isCode } from '@/lib/errors';
import { parseTableQuery, toRecordQuery, type SearchParams } from '@/lib/record-query';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Download the current table as CSV or JSON. Same URL grammar as the table page
 * (`q`, `sort`, `dir`, `f=`), plus `format=csv|json`; the same in-process caller runs
 * `export.records`, which applies field-level redaction and writes the audit row.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; object: string }> },
): Promise<Response> {
  const { slug, object } = await params;
  if (!(await getSessionUser())) return new Response('Sign in to export.', { status: 401 });

  const url = new URL(request.url);
  const sp: SearchParams = {};
  for (const [k, v] of url.searchParams) {
    const prev = sp[k];
    sp[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const table = parseTableQuery(sp);

  try {
    const client = await api(slug);
    const attrs = await client.attribute.list({ objectType: object });
    const q = toRecordQuery(table, attrs, 200);
    const out = await client.export.records({
      objectType: object,
      format,
      filters: q.filters,
      sort: q.sort,
      ...(q.search ? { search: q.search } : {}),
    });
    return new Response(out.body, {
      status: 200,
      headers: {
        'Content-Type': `${out.contentType}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${out.filename.replace(/["\r\n]/g, '')}"`,
        'Cache-Control': 'no-store',
        'X-Nexus-Rows': String(out.rows),
        ...(out.truncated ? { 'X-Nexus-Truncated': 'true' } : {}),
      },
    });
  } catch (e) {
    const { message } = describeError(e);
    const status = isCode(e, 'FORBIDDEN')
      ? 403
      : isCode(e, 'NOT_FOUND')
        ? 404
        : isCode(e, 'BAD_REQUEST')
          ? 400
          : 500;
    return new Response(message, {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
