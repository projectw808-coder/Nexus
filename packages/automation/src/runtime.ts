/**
 * The dependency-injected runtime bag (ADR-021 decision 1).
 *
 * This package depends on `@nexus/core` and `@nexus/db` and nothing else. Every side effect that
 * would otherwise drag in `@nexus/sync`, `@nexus/connector-sdk`, `@nexus/mail` or the AI layer
 * arrives here as a callback that the *caller* supplies — `apps/worker` is the one place that
 * imports all of them, so it is the one place that wires them together. An absent callback fails
 * the one step that needed it with a clear message; it never throws out of the run.
 */
import type { Actor, TenantRuntime } from '@nexus/db';
import type { AutomationEvent } from './events.ts';

export type AutomationLogger = {
  info: (msg: string, fields?: object) => void;
  warn: (msg: string, fields?: object) => void;
  error: (msg: string, fields?: object) => void;
};

export type AutomationRuntime = {
  runtime: TenantRuntime;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logger: AutomationLogger;
  /**
   * Enqueue a follow-on `AutomationEvent` — e.g. after `update_record` runs, so the mutation
   * re-enters stage 6 with the running workflow appended to the causation chain. Required.
   */
  enqueueEvent: (event: AutomationEvent) => Promise<void>;
  /**
   * Send a platform reply. Wired to `@nexus/sync`'s `requestReply` at the `apps/worker` layer.
   * Absent → the `send_reply` action fails that step.
   */
  sendReply?: (input: {
    workspaceId: string;
    actorUserId: string | null;
    conversationId: string;
    text: string;
  }) => Promise<{ status: string; outboundActionId?: string }>;
  /** Call an arbitrary webhook. Defaults to a JSON POST through global `fetch`. */
  callWebhook?: (url: string, body: unknown) => Promise<{ status: number }>;
  /** Send an email. Wired to `@nexus/mail` at the worker layer. Absent → the step fails. */
  sendEmail?: (input: { to: string; subject: string; body: string }) => Promise<void>;
  /**
   * Enqueue an AI job. Wired to the `ai` queue / `@nexus/ai` at the worker layer — this package
   * never imports the AI layer. Absent → the `enqueue_ai` action fails that step.
   */
  enqueueAi?: (input: {
    workspaceId: string;
    feature: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
};

/** The defaults every caller gets unless it overrides them. */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const silentLogger: AutomationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A JSON POST through global `fetch`. Used when the caller injects no `callWebhook`. */
export async function defaultCallWebhook(url: string, body: unknown): Promise<{ status: number }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'nexus-automation/1' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status };
}

/**
 * Fill in the optional halves of the bag. Callers can hand `createAutomationRuntime` just a
 * `TenantRuntime` and an `enqueueEvent` and get sensible defaults for the rest.
 */
export function createAutomationRuntime(
  input: Pick<AutomationRuntime, 'runtime' | 'enqueueEvent'> & Partial<AutomationRuntime>,
): AutomationRuntime {
  return {
    now: () => new Date(),
    sleep: defaultSleep,
    logger: silentLogger,
    ...input,
  };
}

/**
 * The actor a running workflow writes as (ADR-021): full trust inside the tenant, same shape
 * `systemActorFor` produces for sync-engine writes, tagged `WORKFLOW` so the audit trail names
 * the workflow that did it. CASL/`authorize()` only runs at the tRPC layer, which the engine
 * never touches.
 */
export function workflowActor(workflow: { id: string; workspaceId: string }): Actor {
  return {
    workspaceId: workflow.workspaceId,
    userId: null,
    role: 'OWNER',
    grants: [],
    actorType: 'WORKFLOW',
    actorRef: workflow.id,
  };
}

/** A read-only actor for matching workflows before any specific one has been chosen. */
export function matchingActor(workspaceId: string): Actor {
  return {
    workspaceId,
    userId: null,
    role: 'OWNER',
    grants: [],
    actorType: 'WORKFLOW',
    actorRef: null,
  };
}
