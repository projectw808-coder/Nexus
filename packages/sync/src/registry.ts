/**
 * The one place that maps a `Platform` to its connector (spec §0.4: core code never imports
 * a platform package anywhere else). The mock is always present so every test, the seed and
 * the throughput benchmark have a target; Meta serves both FACEBOOK and INSTAGRAM (one app,
 * one login, two independently manageable connection kinds).
 */
import { createMetaConnector, type MetaConfig } from '@nexus/connector-meta';
import { createMockConnector, mockManifest } from '@nexus/connector-mock';
import type { Connector, Platform } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';

export type RegistryOptions = {
  /** Origin of the mock platform for this process (`https://mock.platform.local` in-process, or the URL of a `listen()`ed server). */
  mockBaseUrl?: string;
  /** Meta app id / Login configuration / Graph origin (the Graph double in tests). */
  meta?: MetaConfig;
  /** Extra or replacement connectors (tests, future platforms). */
  overrides?: Partial<Record<Platform, Connector<unknown>>>;
};

export type ConnectorRegistry = {
  get(platform: Platform): Connector<unknown>;
  tryGet(platform: Platform): Connector<unknown> | null;
  platforms(): Platform[];
};

export function createConnectorRegistry(opts: RegistryOptions = {}): ConnectorRegistry {
  const table = new Map<Platform, Connector<unknown>>();
  table.set(
    mockManifest.platform,
    createMockConnector({ baseUrl: opts.mockBaseUrl ?? 'https://mock.platform.local' }),
  );
  const meta = createMetaConnector(opts.meta ?? {});
  table.set('FACEBOOK', meta);
  table.set('INSTAGRAM', meta);
  for (const [platform, connector] of Object.entries(opts.overrides ?? {})) {
    if (connector) table.set(platform as Platform, connector);
  }
  return {
    get(platform) {
      const c = table.get(platform);
      if (!c) {
        throw new NexusError('VALIDATION', {
          message: `no connector is registered for ${platform}`,
          details: { platform },
        });
      }
      return c;
    },
    tryGet(platform) {
      return table.get(platform) ?? null;
    },
    platforms() {
      return [...table.keys()];
    },
  };
}
