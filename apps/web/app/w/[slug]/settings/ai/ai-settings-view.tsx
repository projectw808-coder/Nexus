'use client';

/**
 * The AI kill switch, monthly token budget and PII redaction level (§13). Flipping the kill
 * switch changes what the very next `checkAiAllowed()` read returns — every feature function
 * checks it fresh before calling the model, so there is nothing to cancel mid-flight (ADR-021).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card } from '@/components/card';
import { useTRPC } from '@/lib/trpc-client';

type AiSettings = {
  killSwitch: boolean;
  monthlyTokenBudget?: number;
  piiRedaction: 'strict' | 'standard' | 'off';
};

/** Keyed by `dataUpdatedAt` in the parent so it remounts (and re-initializes its own state)
 * whenever fresh server data arrives, instead of syncing props into state via an effect. */
function AiSettingsForm({ initial, canManage }: { initial: AiSettings; canManage: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [killSwitch, setKillSwitch] = useState(initial.killSwitch);
  const [budget, setBudget] = useState(
    initial.monthlyTokenBudget ? String(initial.monthlyTokenBudget) : '',
  );
  const [pii, setPii] = useState(initial.piiRedaction);

  const update = useMutation(
    trpc.ai.settings.update.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.ai.settings.pathKey() }),
    }),
  );

  return (
    <Card className="flex max-w-lg flex-col gap-5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[var(--text-sm)] font-medium">Kill switch</p>
          <p className="text-[var(--text-xs)] text-ink-muted">
            Stops every AI feature — summaries, briefs, research, reply drafts, semantic search —
            immediately. No model call happens once this is on.
          </p>
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-checked={killSwitch}
          aria-label="AI kill switch"
          checked={killSwitch}
          disabled={!canManage}
          onChange={(e) => {
            setKillSwitch(e.target.checked);
            update.mutate({ killSwitch: e.target.checked });
          }}
          className="mt-1 h-5 w-9 shrink-0 accent-critical"
        />
      </div>

      <label className="flex flex-col gap-1 text-[var(--text-sm)]">
        Monthly token budget (optional)
        <input
          type="number"
          min={0}
          value={budget}
          disabled={!canManage}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={() =>
            update.mutate({ monthlyTokenBudget: budget.trim() ? Number(budget) : null })
          }
          placeholder="No limit"
          className="h-9 rounded-[var(--radius-control)] border border-hairline bg-raised px-3"
        />
      </label>

      <label className="flex flex-col gap-1 text-[var(--text-sm)]">
        PII redaction before any external model call
        <select
          value={pii}
          disabled={!canManage}
          onChange={(e) => {
            const v = e.target.value as 'strict' | 'standard' | 'off';
            setPii(v);
            update.mutate({ piiRedaction: v });
          }}
          className="h-9 rounded-[var(--radius-control)] border border-hairline bg-raised px-2"
        >
          <option value="strict">Strict</option>
          <option value="standard">Standard</option>
          <option value="off">Off</option>
        </select>
      </label>

      {!canManage ? (
        <p className="text-[var(--text-xs)] text-ink-muted">
          Only owners and admins can change these.
        </p>
      ) : null}
      {update.error ? (
        <p role="alert" className="text-[var(--text-xs)] text-critical">
          {update.error.message}
        </p>
      ) : null}
      <p className="text-[var(--text-xs)] text-ink-muted">
        No customer data is used to train any model.
      </p>
    </Card>
  );
}

export function AiSettingsView({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC();
  const settings = useQuery(trpc.ai.settings.get.queryOptions());

  if (settings.isPending) return <p className="text-[var(--text-sm)] text-ink-muted">Loading…</p>;
  if (settings.isError)
    return (
      <p role="alert" className="text-[var(--text-sm)] text-critical">
        {settings.error.message}
      </p>
    );

  return (
    <AiSettingsForm key={settings.dataUpdatedAt} initial={settings.data} canManage={canManage} />
  );
}
