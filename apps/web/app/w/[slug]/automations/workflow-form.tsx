'use client';

/**
 * Trigger → conditions → actions (§12.2.G). Conditions and actions are edited as JSON — the spec
 * explicitly allows "a visual builder and a raw JSON escape hatch"; this ships the escape hatch
 * first, with structured fields for the trigger (the one part every workflow needs) and inline
 * examples for the two JSON shapes, since a full drag-and-drop canvas is out of scope for this
 * phase.
 */
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { useTRPC } from '@/lib/trpc-client';

// Hardcoded client-side (not imported from @nexus/automation, which pulls in @nexus/db) —
// mirrors the SOURCE_KINDS precedent in settings/integrations/[connectionId]/mapping.
const TRIGGER_TYPES = [
  'record.created',
  'record.updated',
  'list.entry_added',
  'list.stage_changed',
  'message.received',
  'comment.received',
  'mention.received',
  'lead_form.submitted',
  'sla.breach_imminent',
  'task.overdue',
  'schedule',
  'webhook.inbound',
  'ai.insight_produced',
] as const;

const CONDITIONS_EXAMPLE = `{ "leaf": { "path": "event.payload.body", "op": "contains", "value": "price" } }`;
const ACTIONS_EXAMPLE = `[
  { "id": "a1", "type": "list_add", "listId": "<list id>", "recordId": "trigger", "stage": "new" },
  { "id": "a2", "type": "assign", "conversationId": "trigger", "mode": "round_robin", "candidateUserIds": ["<user id>", "<user id>"] }
]`;

export type WorkflowInitial = {
  id: string;
  name: string;
  description: string | null;
  trigger: { type: string; platform?: string; objectTypeApiSlug?: string; listId?: string };
  conditions: unknown;
  actions: unknown;
};

export function WorkflowForm({ slug, workflow }: { slug: string; workflow?: WorkflowInitial }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [triggerType, setTriggerType] = useState<string>(
    workflow?.trigger.type ?? 'record.created',
  );
  const [platform, setPlatform] = useState(workflow?.trigger.platform ?? '');
  const [objectTypeApiSlug, setObjectTypeApiSlug] = useState(
    workflow?.trigger.objectTypeApiSlug ?? '',
  );
  const [listId, setListId] = useState(workflow?.trigger.listId ?? '');
  const [conditionsText, setConditionsText] = useState(() =>
    JSON.stringify(workflow?.conditions ?? [], null, 2),
  );
  const [actionsText, setActionsText] = useState(() =>
    JSON.stringify(workflow?.actions ?? [], null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  const onSuccess = (id: string) => router.push(`/w/${slug}/automations/${id}`);
  const create = useMutation(
    trpc.workflow.create.mutationOptions({
      onSuccess: (row) => onSuccess(row.id),
      onError: (e) => setError(e.message),
    }),
  );
  const update = useMutation(
    trpc.workflow.update.mutationOptions({
      onSuccess: (row) => onSuccess(row.id),
      onError: (e) => setError(e.message),
    }),
  );
  const pending = create.isPending || update.isPending;

  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    let conditions: unknown;
    let actions: unknown;
    try {
      conditions = conditionsText.trim() ? JSON.parse(conditionsText) : [];
    } catch {
      setError('Conditions must be valid JSON.');
      return;
    }
    try {
      actions = actionsText.trim() ? JSON.parse(actionsText) : [];
    } catch {
      setError('Actions must be valid JSON.');
      return;
    }
    if (!Array.isArray(actions)) {
      setError('Actions must be a JSON array.');
      return;
    }
    const trigger = {
      type: triggerType,
      ...(platform.trim() ? { platform: platform.trim() } : {}),
      ...(objectTypeApiSlug.trim() ? { objectTypeApiSlug: objectTypeApiSlug.trim() } : {}),
      ...(listId.trim() ? { listId: listId.trim() } : {}),
    };
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      trigger,
      conditions,
      actions,
    };
    if (workflow) update.mutate({ id: workflow.id, ...payload });
    else create.mutate(payload);
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="wf-name" className="text-[var(--text-xs)] font-medium text-ink-secondary">
          Name
        </label>
        <input
          id="wf-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 text-[var(--text-sm)]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="wf-description"
          className="text-[var(--text-xs)] font-medium text-ink-secondary"
        >
          Description
        </label>
        <input
          id="wf-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="h-9 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 text-[var(--text-sm)]"
        />
      </div>

      <fieldset className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline p-3">
        <legend className="px-1 text-[var(--text-xs)] font-semibold uppercase tracking-wide text-ink-muted">
          Trigger
        </legend>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="wf-trigger-type" className="text-[var(--text-xs)] text-ink-secondary">
              Type
            </label>
            <select
              id="wf-trigger-type"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="h-9 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)] text-ink"
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="wf-platform" className="text-[var(--text-xs)] text-ink-secondary">
              Platform (optional)
            </label>
            <input
              id="wf-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value.toUpperCase())}
              placeholder="e.g. INSTAGRAM"
              className="h-9 w-40 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="wf-object-type" className="text-[var(--text-xs)] text-ink-secondary">
              Object type (optional)
            </label>
            <input
              id="wf-object-type"
              value={objectTypeApiSlug}
              onChange={(e) => setObjectTypeApiSlug(e.target.value)}
              placeholder="e.g. deal"
              className="h-9 w-40 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="wf-list-id" className="text-[var(--text-xs)] text-ink-secondary">
              List id (optional)
            </label>
            <input
              id="wf-list-id"
              value={listId}
              onChange={(e) => setListId(e.target.value)}
              placeholder="uuid"
              className="h-9 w-48 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)]"
            />
          </div>
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="wf-conditions"
          className="text-[var(--text-xs)] font-medium text-ink-secondary"
        >
          Conditions (JSON — `and`/`or`/`not`/`leaf`; empty array means always match)
        </label>
        <textarea
          id="wf-conditions"
          value={conditionsText}
          onChange={(e) => setConditionsText(e.target.value)}
          rows={4}
          placeholder={CONDITIONS_EXAMPLE}
          className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 font-mono text-[var(--text-xs)]"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="wf-actions"
          className="text-[var(--text-xs)] font-medium text-ink-secondary"
        >
          Actions (JSON array, run in order — each needs a unique &quot;id&quot;)
        </label>
        <textarea
          id="wf-actions"
          value={actionsText}
          onChange={(e) => setActionsText(e.target.value)}
          rows={8}
          placeholder={ACTIONS_EXAMPLE}
          className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 font-mono text-[var(--text-xs)]"
        />
      </div>

      {error ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : workflow ? 'Save changes' : 'Create workflow'}
        </Button>
      </div>
    </Card>
  );
}
