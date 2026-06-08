import { DataTypes, Model, Op, Sequelize } from 'sequelize';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheUnavailableError } from '../../lib/errors/CacheUnavailableError';
import { ConfigurationError } from '../../lib/errors/ConfigurationError';
import { PeerContext } from '../../lib/peers';
import { clearCachedModels, keysMatchCandidates, SequelizeCache, shouldUseCache } from '../../lib/SequelizeCache';

import type { CacheOptions as ModelCacheOptions, ModelKeyLookup } from '../../lib/CachedModelInstance';
import type { CacheOptions, GlobalCacheOptions } from '../../lib/SequelizeCache';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

// Shared, per-test-mutable state for the CachedModelInstance/PeerContext mocks below. Behavioral
// tests tweak `modelOptions` and `getModel` to drive the cache lookup path inside the patched
// findByPk/findOne without standing up a real Redis engine.
const h = vi.hoisted(() => ({
  getModel: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  modelKeys: { primary: ['id'], unique: [] as string[][] },
  modelOptions: { caching: { enabled: true, fallbackOverride: 'none' } } as any,
  log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../lib/CachedModelInstance', () => ({
  CachedModelInstance: class {
    get modelKeys() { return h.modelKeys; }
    get options() { return h.modelOptions; }
    getModel(...args: unknown[]) { return h.getModel(...args); }
    invalidate(...args: unknown[]) { return h.invalidate(...args); }
    invalidateAll(...args: unknown[]) { return h.invalidateAll(...args); }
  },
}));

vi.mock('../../lib/peers', () => ({
  PeerContext: class {
    log = h.log;
    metrics = {
      lookupTime: { startTimer: () => () => undefined },
      lookupCount: { inc: () => undefined },
    };
  },
}));

// Test Models
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: ':memory:',
  logging: false,
});

class SingleColPk extends Model<InferAttributes<SingleColPk>, InferCreationAttributes<SingleColPk>> {
  declare id: CreationOptional<string>;
  declare name: string;
}

// Capture the pristine (inherited) static finders so behavioral tests, which replace them with
// spies, don't leak their overrides into later tests.
const pristineFindByPk = SingleColPk.findByPk;
const pristineFindOne = SingleColPk.findOne;

const REDIS_DOWN = new CacheUnavailableError({ cause: new Error('redis down') });

// A mock PeerContext instance (the peers module is mocked above) for direct shouldUseCache calls.
const testCtx = new PeerContext({} as unknown as GlobalCacheOptions);

/** Builds a `globalOpts` argument for `shouldUseCache`, enabled by default. */
function globalOpts(caching: Record<string, unknown> = {}): GlobalCacheOptions {
  return {
    engine: { connection: null as any, type: 'redis' },
    caching: { enabled: true, fallbackOverride: 'none', ...caching },
  } as GlobalCacheOptions;
}

/** Builds a `modelOpts` argument for `shouldUseCache`, enabled by default. */
function modelOpts(caching: Record<string, unknown> = {}): ModelCacheOptions {
  return { caching: { enabled: true, fallbackOverride: 'none', ...caching } } as unknown as ModelCacheOptions;
}

describe('SequelizeCache', () => {
  beforeEach(() => {
    SingleColPk.init({
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.STRING },
    }, {
      sequelize,
      modelName: 'SingleColPk',
      timestamps: false,
      scopes: {
        test: function () { return {}; },
      },
    });

    h.getModel.mockReset();
    h.invalidate.mockReset();
    h.invalidateAll.mockReset();
    h.modelKeys = { primary: ['id'], unique: [] };
    h.modelOptions = { caching: { enabled: true, fallbackOverride: 'none' } };
    Object.values(h.log).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    clearCachedModels();
    SingleColPk.findByPk = pristineFindByPk;
    SingleColPk.findOne = pristineFindOne;
  });

  describe('constructor', () => {
    it('constructor returns instance', () => {
      const inst = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });
      expect(inst).to.be.instanceOf(SequelizeCache);
    });
  });

  describe('cacheModel', () => {
    it('throws if TTL is < 0.0', () => {
      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(() => cache.cacheModel(SingleColPk, {
        ttl: -1,
      })).toThrow(ConfigurationError);
      expect(() => cache.cacheModel(SingleColPk, {
        ttl: {
          seconds: -1,
        },
      })).toThrow(ConfigurationError);
    });

    it('throws if TTL jitter is < 0.0', () => {
      function config(jitter: number): CacheOptions {
        return {
          ttl: {
            seconds: 100,
            jitter,
          },
        };
      }

      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(() => cache.cacheModel(SingleColPk, config(-1))).toThrow(ConfigurationError);
      expect(() => cache.cacheModel(SingleColPk, config(-0.5))).toThrow(ConfigurationError);
    });

    it('throws if TTL jitter is >= 1.0', () => {
      function config(jitter: number): CacheOptions {
        return {
          ttl: {
            seconds: 100,
            jitter,
          },
        };
      }

      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(() => cache.cacheModel(SingleColPk, config(1))).toThrow(ConfigurationError);
      expect(() => cache.cacheModel(SingleColPk, config(1.5))).toThrow(ConfigurationError);
    });

    it('accepts TTL and jitter within valid ranges', () => {
      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(() => cache.cacheModel(SingleColPk, {
        ttl: {
          seconds: 5,
          jitter: 0.5,
        },
      })).to.not.throw(ConfigurationError);
    });

    it('accepts enabled and fallbackOverride options', () => {
      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      expect(() => cache.cacheModel(SingleColPk, {
        enabled: () => false,
        fallbackOverride: 'fail',
      })).to.not.throw();
    });

    it('replaces findOne and findByPk', () => {
      const originalFindOne = SingleColPk.findOne;
      const originalFindByPk = SingleColPk.findByPk;

      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      cache.cacheModel(SingleColPk);

      expect(SingleColPk.findOne).to.not.equal(originalFindOne);
      expect(SingleColPk.findByPk).to.not.equal(originalFindByPk);
    });

    it('registers after hooks for update and destroy', () => {
      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      cache.cacheModel(SingleColPk);

      expect(SingleColPk.hasHook('afterUpdate')).toBeTruthy();
      expect(SingleColPk.hasHook('afterDestroy')).toBeTruthy();
      expect(SingleColPk.hasHook('afterBulkUpdate')).toBeTruthy();
      expect(SingleColPk.hasHook('afterBulkDestroy')).toBeTruthy();

      const hooks = SingleColPk.options.hooks as any;
      expect(hooks).toBeDefined();
      expect(hooks.afterUpdate).toHaveLength(1);
      expect(hooks.afterUpdate[0].name).toEqual('model-cache-update');
      expect(hooks.afterDestroy).toHaveLength(1);
      expect(hooks.afterDestroy[0].name).toEqual('model-cache-destroy');
      expect(hooks.afterBulkUpdate).toHaveLength(1);
      expect(hooks.afterBulkUpdate[0].name).toEqual('model-cache-bulk-update');
      expect(hooks.afterBulkDestroy).toHaveLength(1);
      expect(hooks.afterBulkDestroy[0].name).toEqual('model-cache-bulk-destroy');
    });

    it('throws an error if called against the same model twice', () => {
      const cache = new SequelizeCache({
        engine: {
          connection: null as any,
          type: 'redis',
        },
      });

      cache.cacheModel(SingleColPk);

      expect(() => cache.cacheModel(SingleColPk)).toThrow('Model SingleColPk has already been cached');
    });
  });

  describe('keysMatchCandidates', () => {
    it('[] does not match with any candidates', () => {
      const keys: string[] = [];
      const candidates: ModelKeyLookup = {
        primary: ['id', 'test'],
        unique: [['test'], ['ab', 'bc'], []],
      };

      const result = keysMatchCandidates(keys, candidates);

      expect(result).toBeUndefined();
    });

    it("matches ['test'] against primary ['test'] and unique []", () => {
      const keys = ['test'];
      const candidates: ModelKeyLookup = {
        primary: ['test'],
        unique: [],
      };

      const result = keysMatchCandidates(keys, candidates);

      expect(result).toBeDefined();
      expect(result).toEqual({
        type: 'primary',
        match: ['test'],
      });
    });

    it("matches ['test'] against primary ['id'] and unique ['test']", () => {
      const keys = ['test'];
      const candidates: ModelKeyLookup = {
        primary: ['id'],
        unique: [['test']],
      };

      const result = keysMatchCandidates(keys, candidates);

      expect(result).toBeDefined();
      expect(result).toEqual({
        type: 'unique',
        match: ['test'],
      });
    });

    it("matches ['def'] against primary ['id'] and unique [['abc'], ['def']]", () => {
      const keys = ['def'];
      const candidates: ModelKeyLookup = {
        primary: ['id'],
        unique: [['abc'], ['def']],
      };

      const result = keysMatchCandidates(keys, candidates);

      expect(result).toBeDefined();
      expect(result).toEqual({
        type: 'unique',
        match: ['def'],
      });
    });

    it("matches ['id', 'test'] against primary ['id', 'test'] and unique []", () => {
      const keys = ['id', 'test'];
      const candidates: ModelKeyLookup = {
        primary: ['id', 'test'],
        unique: [],
      };

      const result = keysMatchCandidates(keys, candidates);

      expect(result).toBeDefined();
      expect(result).toEqual({
        type: 'primary',
        match: ['id', 'test'],
      });
    });

    it("['abc'] does not match against primary ['id'] and unique [['test'], ['def']]", () => {
      const keys = ['abc'];
      const candidates: ModelKeyLookup = {
        primary: ['id'],
        unique: [['test'], ['def']],
      };

      const result = keysMatchCandidates(keys, candidates);

      expect(result).toBeUndefined();
    });
  });

  describe('shouldUseCache', () => {
    const keys: ModelKeyLookup = {
      primary: ['id'],
      unique: [],
    };

    it('returns false if cache is not set on the query', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys);
      expect(result).toBeFalsy();
    });

    it('returns false if cache is false on the query', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: false,
      });
      expect(result).toBeFalsy();
    });

    it('returns false if cache is disabled on the query', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: {
          enabled: false,
        },
      });
      expect(result).toBeFalsy();
    });

    it('returns false if cache is disabled on the query and fallback is fail', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: {
          enabled: false,
          fallback: 'fail',
        },
      });
      expect(result).toBeFalsy();
    });

    it('returns false if model is scoped', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk.scope({ method: ['test'] }), keys, undefined, {
        cache: true,
      });
      expect(result).toBeFalsy();
    });

    it('throws if model is scoped and fallback is fail', async () => {
      await expect(shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk.scope({ method: ['test'] }), keys, undefined, {
        cache: {
          enabled: true,
          fallback: 'fail',
        },
      })).rejects.toThrow('Query is nonconformant');
    });

    it('returns false if illegal attribute is included', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: true,
        include: ['Test'],
      });
      expect(result).toBeFalsy();
    });

    it('throws if illegal attribute is included', async () => {
      await expect(shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: {
          enabled: true,
          fallback: 'fail',
        },
        include: ['Test'],
      })).rejects.toThrow('Query is nonconformant');
    });

    it('returns false if where clause uses unsupported operator', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: true,
        where: {
          id: {
            [Op.in]: ['abc', 'def'],
          },
        },
      });
      expect(result).toBeFalsy();
    });

    it('throws if where clause uses unsupported operator and fallback is fail', async () => {
      await expect(shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: {
          enabled: true,
          fallback: 'fail',
        },
        where: {
          id: {
            [Op.in]: ['abc', 'def'],
          },
        },
      })).rejects.toThrow('Query is nonconformant');
    });

    it('returns true if identifier included and no where clause', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, 'abc', {
        cache: true,
      });
      expect(result).toBeTruthy();
    });

    it('returns true if where included with matching keys', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: true,
        where: {
          id: 'abc',
        },
      });
      expect(result).toBeTruthy();
    });

    it('returns true if where included with matching keys and eq operator', async () => {
      const result = await shouldUseCache(testCtx, globalOpts(), modelOpts(), SingleColPk, keys, undefined, {
        cache: true,
        where: {
          id: {
            [Op.eq]: 'abc',
          },
        },
      });
      expect(result).toBeTruthy();
    });

    describe('enablement', () => {
      it('returns false if global caching is disabled (boolean)', async () => {
        const result = await shouldUseCache(testCtx, globalOpts({ enabled: false }), modelOpts(), SingleColPk, keys, 'abc', {
          cache: true,
        });
        expect(result).toBeFalsy();
      });

      it('returns false if global enabled function resolves false', async () => {
        const result = await shouldUseCache(testCtx, globalOpts({ enabled: () => false }), modelOpts(), SingleColPk, keys, 'abc', {
          cache: true,
        });
        expect(result).toBeFalsy();
      });

      it('returns false if global async enabled function resolves false', async () => {
        const result = await shouldUseCache(testCtx, globalOpts({ enabled: async () => { await Promise.resolve(); return false; } }),
          modelOpts(),
          SingleColPk,
          keys,
          'abc',
          { cache: true }
        );
        expect(result).toBeFalsy();
      });

      it('returns true if global enabled function resolves true', async () => {
        const result = await shouldUseCache(testCtx, globalOpts({ enabled: () => true }), modelOpts(), SingleColPk, keys, 'abc', {
          cache: true,
        });
        expect(result).toBeTruthy();
      });

      it('returns true if global async enabled function resolves true', async () => {
        const result = await shouldUseCache(testCtx, globalOpts({ enabled: async () => { await Promise.resolve(); return true; } }),
          modelOpts(),
          SingleColPk,
          keys,
          'abc',
          { cache: true }
        );
        expect(result).toBeTruthy();
      });

      it('returns false if model caching is disabled (boolean)', async () => {
        const result = await shouldUseCache(testCtx, globalOpts(), modelOpts({ enabled: false }), SingleColPk, keys, 'abc', {
          cache: true,
        });
        expect(result).toBeFalsy();
      });

      it('returns false if model enabled function resolves false', async () => {
        const result = await shouldUseCache(testCtx, globalOpts(), modelOpts({ enabled: () => false }), SingleColPk, keys, 'abc', {
          cache: true,
        });
        expect(result).toBeFalsy();
      });

      it('returns false if model async enabled function resolves false', async () => {
        const result = await shouldUseCache(testCtx, globalOpts(),
          modelOpts({ enabled: async () => { await Promise.resolve(); return false; } }),
          SingleColPk,
          keys,
          'abc',
          { cache: true }
        );
        expect(result).toBeFalsy();
      });

      it('returns true when all three levels are enabled', async () => {
        const result = await shouldUseCache(testCtx, globalOpts({ enabled: () => true }),
          modelOpts({ enabled: () => true }),
          SingleColPk,
          keys,
          'abc',
          { cache: { enabled: true } }
        );
        expect(result).toBeTruthy();
      });

      // SPEC DEVIATION (issue #20): "If an `enabled` function throws, treat it as `false`."
      // The implementation does not wrap enabled() in try/catch, so the error propagates instead.
      // This test asserts the documented behavior and is expected to FAIL until the impl is fixed.
      it('treats a throwing global enabled function as false (no throw)', async () => {
        await expect(shouldUseCache(testCtx, globalOpts({ enabled: () => { throw new Error('flag service down'); } }),
          modelOpts(),
          SingleColPk,
          keys,
          'abc',
          { cache: true }
        )).resolves.toBeFalsy();
      });

      // SPEC DEVIATION (issue #20): see above — same gap at the model level.
      it('treats a throwing model enabled function as false (no throw)', async () => {
        await expect(shouldUseCache(testCtx, globalOpts(),
          modelOpts({ enabled: () => { throw new Error('flag service down'); } }),
          SingleColPk,
          keys,
          'abc',
          { cache: true }
        )).resolves.toBeFalsy();
      });
    });
  });

  // Exercises the fallbackOverride chain (global > model > query) through the patched findByPk.
  // The cache lookup always fails with CacheUnavailableError; the override chain decides whether
  // we fall back to the database or rethrow. `resolves.toBe('DB_PK')` => used database;
  // `rejects` => threw. The truth table in issue #20 is the source of truth for expectations.
  describe('fallbackOverride chain (findByPk)', () => {
    function setup(globalCaching: any = { enabled: true, fallbackOverride: 'none' }) {
      const dbFindByPk = vi.fn().mockResolvedValue('DB_PK');
      SingleColPk.findByPk = dbFindByPk as any;
      const cache = new SequelizeCache({
        engine: { connection: null as any, type: 'redis' },
        caching: globalCaching,
      });
      cache.cacheModel(SingleColPk);
      h.getModel.mockRejectedValue(REDIS_DOWN);
      return { dbFindByPk };
    }

    it('falls back to the database when nothing forces a fail (all none)', async () => {
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: true })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    it('falls back to the database when query fallback is database', async () => {
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    it('throws when query fallback is fail and no override defers', async () => {
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'fail' } })).rejects.toThrow();
      expect(dbFindByPk).not.toHaveBeenCalled();
    });

    it('throws when global override is fail', async () => {
      const { dbFindByPk } = setup({ enabled: true, fallbackOverride: 'fail' });
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).rejects.toThrow();
      expect(dbFindByPk).not.toHaveBeenCalled();
    });

    it('throws when global override function resolves to fail', async () => {
      const { dbFindByPk } = setup({ enabled: true, fallbackOverride: () => 'fail' });
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).rejects.toThrow();
      expect(dbFindByPk).not.toHaveBeenCalled();
    });

    it('throws when model override is fail (global none)', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: 'fail' } };
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).rejects.toThrow();
      expect(dbFindByPk).not.toHaveBeenCalled();
    });

    it('uses the database when model override is database and query fallback defers (global none)', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: 'database' } };
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    it('uses the database when a global override function resolves none and model override is database', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: 'database' } };
      const { dbFindByPk } = setup({ enabled: true, fallbackOverride: () => 'none' });
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    it('defers to query fallback when a model override function resolves none', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: () => 'none' } };
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'fail' } })).rejects.toThrow();
      expect(dbFindByPk).not.toHaveBeenCalled();
    });

    // A global override of 'database' must use the database regardless of the query fallback.
    it('uses the database when global override is database even if query fallback is fail', async () => {
      const { dbFindByPk } = setup({ enabled: true, fallbackOverride: 'database' });
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'fail' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    // A model override of 'database' beats a query 'fail' when the global override is none.
    it('uses the database when model override is database even if query fallback is fail', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: 'database' } };
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'fail' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    // If a `fallbackOverride` function throws, it is treated as 'none' and the chain defers down
    // to the query fallback (here, 'database').
    it('treats a throwing global override function as none and defers to query fallback', async () => {
      const { dbFindByPk } = setup({ enabled: true, fallbackOverride: () => { throw new Error('flag service down'); } });
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    it('throws when an async global override function resolves to fail', async () => {
      const { dbFindByPk } = setup({ enabled: true, fallbackOverride: async () => { await Promise.resolve(); return 'fail'; } });
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).rejects.toThrow();
      expect(dbFindByPk).not.toHaveBeenCalled();
    });

    it('uses the database when an async model override function resolves to database (global none)', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: async () => { await Promise.resolve(); return 'database'; } } };
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'fail' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });

    it('treats a throwing model override function as none and defers to query fallback (global none)', async () => {
      h.modelOptions = { caching: { enabled: true, fallbackOverride: () => { throw new Error('flag service down'); } } };
      const { dbFindByPk } = setup();
      await expect(SingleColPk.findByPk('abc', { cache: { enabled: true, fallback: 'database' } })).resolves.toBe('DB_PK');
      expect(dbFindByPk).toHaveBeenCalled();
    });
  });

  // findOne shares the fallbackOverride contract with findByPk.
  describe('fallbackOverride chain (findOne)', () => {
    function setup(globalCaching: any = { enabled: true, fallbackOverride: 'none' }) {
      const dbFindOne = vi.fn().mockResolvedValue('DB_ONE');
      SingleColPk.findOne = dbFindOne as any;
      const cache = new SequelizeCache({
        engine: { connection: null as any, type: 'redis' },
        caching: globalCaching,
      });
      cache.cacheModel(SingleColPk);
      h.getModel.mockRejectedValue(REDIS_DOWN);
      return { dbFindOne };
    }

    it('falls back to the database when query fallback is database', async () => {
      const { dbFindOne } = setup();
      await expect(SingleColPk.findOne({ where: { id: 'abc' }, cache: { enabled: true, fallback: 'database' } }))
        .resolves.toBe('DB_ONE');
      expect(dbFindOne).toHaveBeenCalled();
    });

    it('throws when query fallback is fail and no override defers', async () => {
      const { dbFindOne } = setup();
      await expect(SingleColPk.findOne({ where: { id: 'abc' }, cache: { enabled: true, fallback: 'fail' } }))
        .rejects.toThrow();
      expect(dbFindOne).not.toHaveBeenCalled();
    });

    // findOne consults the override chain: a global override of 'fail' forces a throw even when
    // the query fallback is 'database'.
    it('throws when global override is fail even if query fallback is database', async () => {
      const { dbFindOne } = setup({ enabled: true, fallbackOverride: 'fail' });
      await expect(SingleColPk.findOne({ where: { id: 'abc' }, cache: { enabled: true, fallback: 'database' } }))
        .rejects.toThrow();
      expect(dbFindOne).not.toHaveBeenCalled();
    });

    // A global override of 'database' uses the database even when the query fallback is 'fail'.
    it('uses the database when global override is database even if query fallback is fail', async () => {
      const { dbFindOne } = setup({ enabled: true, fallbackOverride: 'database' });
      await expect(SingleColPk.findOne({ where: { id: 'abc' }, cache: { enabled: true, fallback: 'fail' } }))
        .resolves.toBe('DB_ONE');
      expect(dbFindOne).toHaveBeenCalled();
    });
  });
});
