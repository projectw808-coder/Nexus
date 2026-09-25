export { createMockPlatform } from './platform.ts';
export type {
  MockPlatform,
  MockPlatformOptions,
  MockFaults,
  MockAccount,
  MockPost,
  MockComment,
  MockRequest,
  MockResponse,
  EmittedWebhook,
} from './platform.ts';
export { createMockConnector, mockManifest, MOCK_KINDS } from './connector.ts';
export type { MockConnectorConfig } from './connector.ts';
