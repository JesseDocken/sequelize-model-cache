import { createNoopMeter } from '@opentelemetry/api';
import { pino as PinoLogger } from 'pino';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger as WinstonLogger } from 'winston';

describe('PeerContext', () => {
  afterEach(() => {
    vi.doUnmock('../../lib/loadDebug');
    vi.resetModules();
  });

  describe('constructor', () => {
    it('no logger or metrics returns noop implementations', async () => {
      vi.doMock('../../lib/loadDebug', () => ({
        loadDebug: () => { throw new Error('Cannot resolve debug'); },
      }));

      const { NoopLogger, NoopMetricsProvider, PeerContext } = await import('../../lib/peers.js');
      const context = new PeerContext({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(context.log).to.be.instanceOf(NoopLogger);
      expect(context.metrics.provider).to.be.instanceOf(NoopMetricsProvider);
    });

    it('debug module returns the DebugLogger', async () => {
      const { DebugLogger, NoopMetricsProvider, PeerContext } = await import('../../lib/peers.js');
      const context = new PeerContext({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(context.log).to.be.instanceOf(DebugLogger);
      expect(context.metrics.provider).to.be.instanceOf(NoopMetricsProvider);
    });

    it('pino log provider returns the StructuredLogger', async () => {
      const { StructuredLogger, NoopMetricsProvider, PeerContext } = await import('../../lib/peers.js');
      const context = new PeerContext({
        engine: {
          connection: null as any,
          type: 'redis',
        },
        logger: PinoLogger(),
      });

      expect(context.log).to.be.instanceOf(StructuredLogger);
      expect(context.metrics.provider).to.be.instanceOf(NoopMetricsProvider);
    });

    it('winston log provider returns the StructuredLogger', async () => {
      const { StructuredLogger, NoopMetricsProvider, PeerContext } = await import('../../lib/peers.js');
      const context = new PeerContext({
        engine: {
          connection: null as any,
          type: 'redis',
        },
        logger: new WinstonLogger(),
      });

      expect(context.log).to.be.instanceOf(StructuredLogger);
      expect(context.metrics.provider).to.be.instanceOf(NoopMetricsProvider);
    });

    it('Prometheus registry returns PrometheusProvider', async () => {
      const { DebugLogger, PrometheusProvider, PeerContext } = await import('../../lib/peers.js');
      const context = new PeerContext({
        engine: {
          connection: null as any,
          type: 'redis',
        },
        metrics: new Registry(),
      });

      expect(context.log).to.be.instanceOf(DebugLogger);
      expect(context.metrics.provider).to.be.instanceOf(PrometheusProvider);
    });

    it('OpenTelemetry meter returns OpenTelemetryProvider', async () => {
      const { DebugLogger, OpenTelemetryProvider, PeerContext } = await import('../../lib/peers.js');
      const context = new PeerContext({
        engine: {
          connection: null as any,
          type: 'redis',
        },
        metrics: createNoopMeter(),
      });

      expect(context.log).to.be.instanceOf(DebugLogger);
      expect(context.metrics.provider).to.be.instanceOf(OpenTelemetryProvider);
    });
  });
});
