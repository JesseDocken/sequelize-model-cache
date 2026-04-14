/* eslint-disable import-x/first */
import { describe, expect, it, vi } from 'vitest';

// Simulates the `debug` peer dependency not being installed.
vi.mock('../../lib/loadDebug', () => ({
  loadDebug: () => { throw new Error('Cannot resolve debug'); },
}));

import { PeerContext } from '../../lib/peers';
import { NoopLogger } from '../../lib/peers/loggers/NoopLogger';
import { NoopMetricsProvider } from '../../lib/peers/metrics/NoopMetricsProvider';

describe('PeerContext when debug is unavailable', () => {
  it('falls back to NoopLogger and NoopMetricsProvider', () => {
    const context = new PeerContext({
      engine: {
        connection: null as any,
        type: 'redis',
      },
    });

    expect(context.log).to.be.instanceOf(NoopLogger);
    expect(context.metrics.provider).to.be.instanceOf(NoopMetricsProvider);
  });
});
