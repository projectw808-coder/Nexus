# ADR-011 — Client data layer: tRPC over TanStack Query; grid layout in localStorage

**Status:** accepted (Phase 3) · **Spec:** §5 tRPC, §12 UI, §16 Phase 3

## Context

Phases 1–2 rendered every screen on the server (server components + server actions). The
records table, board, palette and record panels need client-side interaction that round-trips
constantly (inline edit, drag, infinite scroll, live search) and must stay responsive with
100k rows. Server actions serialize through the router and re-render the tree; that is the wrong
tool for a cell edit.

## Decision

- `apps/web/lib/trpc-client.tsx` creates a typed tRPC client (`@trpc/tanstack-react-query`,
  `httpBatchLink` to `/api/trpc`, superjson) and a QueryClient per workspace shell. Client
  components call `useTRPC()` + `useQuery`/`useMutation`; the server still owns authorization,
  audit and scoping — the client is a thin caller of the same procedures the server pages use.
- Record pages are cursor-paginated with `useInfiniteQuery`; the grid virtualizes rows
  (TanStack Virtual, 36 px rows, overscan 12) and asks for the next page when the viewport nears
  the end of the loaded rows. Aggregates in the footer are computed over loaded rows and say so.
- Mutations are optimistic where the local result is certain (cell edit, delete, board move),
  and rolled back from the server's error; the server response replaces the optimistic row.
- Per-user grid layout (column order, widths, pinning, visibility, grouping) is stored in
  `localStorage` under `nexus.grid.<objectTypeId>`. Saved views (server-side, shareable) hold
  filters and sort; layout is device-local because it is a viewport preference, not data.
- Server components keep doing the first render (attributes, permissions, lists) so the four
  mandatory states still resolve on the server for the shell; client components handle their
  own loading/error/empty states for the data they fetch.

## Consequences

- Two data paths exist (server caller for pages, HTTP for client components). Both hit the same
  router and the same isolation test suite.
- Layout is not synced across devices. If that becomes a request, it moves into `SavedView`
  with a new column; the storage key and shape are already versioned for that.
- The React Compiler cannot memoize the grid component (TanStack Table returns unstable
  functions); it is opted out of memoization by the lint warning and manages its own `useMemo`.
