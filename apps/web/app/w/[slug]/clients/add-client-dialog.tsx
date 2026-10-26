'use client';

import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toE164 } from '@/lib/clients';
import { useTRPC } from '@/lib/trpc-client';
import type { ClientsData } from './clients-workspace';

const INPUT =
  'mt-1.5 block h-10 w-full rounded-[6px] border border-strong bg-card px-3 text-[13.5px] text-ink placeholder:text-ink-muted focus:border-link focus:outline-none';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[12.5px] text-ink-secondary">
      {label}
      {children}
    </label>
  );
}

/** Creates a real client through record.create (audited, fires automations like any other write). */
export function AddClientDialog({
  data,
  meId,
  onClose,
  onCreated,
}: {
  data: ClientsData;
  meId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const trpc = useTRPC();
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    campaign: '',
    source: 'Manual',
    status: data.statuses.some((s) => s.id === 'new') ? 'new' : '',
    priority: data.priorities.some((p) => p.id === 'medium') ? 'medium' : '',
    owner: data.agents.some((a) => a.id === meId) ? meId : '',
  });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation(trpc.record.create.mutationOptions());

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const phone = form.phone.trim() ? toE164(form.phone) : null;
    if (form.phone.trim() && !phone) {
      setError('Enter the phone with its country code, e.g. +44 7700 900123.');
      return;
    }
    const values: Record<string, unknown> = { name: form.name.trim() };
    if (form.email.trim()) values['email'] = form.email.trim();
    if (phone) values['phone'] = phone;
    if (form.campaign.trim()) values['campaign'] = form.campaign.trim();
    if (form.source.trim()) values['source'] = form.source.trim();
    if (form.status) values['status'] = form.status;
    if (form.priority) values['priority'] = form.priority;
    if (form.owner) values['owner'] = [form.owner];
    create.mutate(
      { objectType: 'client', values },
      { onSuccess: (row) => onCreated(row.id), onError: (err) => setError(err.message) },
    );
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="add-client-title"
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(440px,calc(100vw-2rem))] rounded-[12px] border border-strong bg-raised p-6 text-ink shadow-[0_20px_80px_rgba(0,0,0,0.6)] backdrop:bg-black/60"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id="add-client-title" className="text-[19px] font-bold">
            Add Client
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-[5px] p-1 text-ink-secondary hover:text-ink"
          >
            <X aria-hidden size={18} />
          </button>
        </div>
        <Field label="Full name *">
          <input required autoFocus value={form.name} onChange={set('name')} className={INPUT} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <input type="email" value={form.email} onChange={set('email')} className={INPUT} />
          </Field>
          <Field label="Phone">
            <input
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              placeholder="+44 7700 900123"
              className={INPUT}
            />
          </Field>
          <Field label="Campaign">
            <input value={form.campaign} onChange={set('campaign')} className={INPUT} />
          </Field>
          <Field label="Source">
            <input value={form.source} onChange={set('source')} className={INPUT} />
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={set('status')} className={INPUT}>
              <option value="">—</option>
              {data.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={form.priority} onChange={set('priority')} className={INPUT}>
              <option value="">—</option>
              {data.priorities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Assigned agent">
          <select value={form.owner} onChange={set('owner')} className={INPUT}>
            <option value="">Unassigned</option>
            {data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.email}
              </option>
            ))}
          </select>
        </Field>
        {error ? (
          <p role="alert" className="text-[12.5px] text-critical">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[7px] border border-strong bg-card px-4 text-[13.5px] hover:border-[#3a4b5e]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || !form.name.trim()}
            className="h-10 rounded-[7px] border border-[#fa7620] bg-[linear-gradient(#ff8628,#fa6508)] px-4 text-[13.5px] font-bold text-[#1a0d03] hover:brightness-110 disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create Client'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
