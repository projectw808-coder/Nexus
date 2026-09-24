import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  currentTraceIds,
  injectTraceCarrier,
  runWithTraceCarrier,
  TRACE_CARRIER_KEY,
} from './propagation.ts';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  contextManager.disable();
});

describe('queue trace propagation', () => {
  it('a job processed with the carrier joins the producer trace', async () => {
    const tracer = trace.getTracer('test');
    let carrier: Record<string, string> = {};
    let producerTraceId = '';

    await tracer.startActiveSpan('POST /api/system/ping', async (span) => {
      producerTraceId = span.spanContext().traceId;
      carrier = injectTraceCarrier();
      expect(currentTraceIds()?.traceId).toBe(producerTraceId);
      span.end();
    });

    expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const jobData = { ping: true, [TRACE_CARRIER_KEY]: carrier };
    const result = await runWithTraceCarrier(
      jobData[TRACE_CARRIER_KEY],
      'system.ping',
      async () => {
        return currentTraceIds()?.traceId;
      },
    );

    expect(result).toBe(producerTraceId);
    const spans = exporter.getFinishedSpans();
    const consumer = spans.find((s) => s.name === 'system.ping');
    const producer = spans.find((s) => s.name === 'POST /api/system/ping');
    expect(consumer?.spanContext().traceId).toBe(producerTraceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
  });

  it('records an error status when the processor throws', async () => {
    exporter.reset();
    await expect(
      runWithTraceCarrier(undefined, 'system.boom', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const span = exporter.getFinishedSpans().find((s) => s.name === 'system.boom');
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
