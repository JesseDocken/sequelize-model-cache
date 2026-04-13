import { RedisClient } from './RedisClient';
import { UnsupportedEngineError } from '../errors/UnsupportedEngineError';

import type { CacheClientOptions } from './EngineClient';
import type { EngineClient } from './EngineClient';
import type { PeerContext } from '../peers';

export function createEngineClient(options: CacheClientOptions, context: PeerContext): EngineClient {
  switch (options.engine.type) {
    case 'redis':
      return new RedisClient(options, context);
    default:
      throw new UnsupportedEngineError(options.engine.type);
  }
}
