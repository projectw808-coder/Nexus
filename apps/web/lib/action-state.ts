/**
 * The shape every server action returns to `useActionState`. Success carries an optional
 * confirmation sentence; failure carries the user-facing message and, when the failure class
 * knows one, the remediation (§9.2). Field errors are keyed by input name.
 */
export type ActionState =
  | { ok: true; message?: string }
  | { ok: false; message: string; remediation?: string; fields?: Record<string, string> };

export const IDLE: ActionState = { ok: true };

export function fail(
  message: string,
  extra?: { remediation?: string | null; fields?: Record<string, string> },
): ActionState {
  return {
    ok: false,
    message,
    ...(extra?.remediation ? { remediation: extra.remediation } : {}),
    ...(extra?.fields ? { fields: extra.fields } : {}),
  };
}

export function text(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v.trim() : '';
}
