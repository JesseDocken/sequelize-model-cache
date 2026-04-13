import Redis from 'ioredis';
import { DataTypes, Model, Sequelize } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SequelizeCache } from '../index';

import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

// Models

class TestModel extends Model<InferAttributes<TestModel>, InferCreationAttributes<TestModel>> {
  declare id: CreationOptional<number>;
  declare abc: string;
  declare def: string;
  declare ghi: string;
}

// Fixtures

let sequelize: Sequelize;
let redis: Redis;
let cache: SequelizeCache;

const CACHE_NAMESPACE = 'lifecycle-test';

beforeAll(async () => {
  redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
  await redis.connect();

  sequelize = new Sequelize({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'test',
    password: 'test',
    database: 'test',
    logging: false,
  });

  TestModel.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    abc: { type: DataTypes.STRING, allowNull: false, unique: true },
    def: { type: DataTypes.STRING, allowNull: false },
    ghi: { type: DataTypes.STRING, allowNull: false },
  }, { sequelize, modelName: 'TestModel', timestamps: false });

  await sequelize.sync({ force: true });

  cache = new SequelizeCache({
    engine: { connection: redis, type: 'redis' },
    caching: { namespace: CACHE_NAMESPACE },
  });

  cache.cacheModel(TestModel, {
    uniqueKeys: [['abc']],
    ttl: 60,
  });
});

beforeEach(async () => {
  // Clear all cache keys and reset the table between tests.
  const keys = await redis.keys(`${CACHE_NAMESPACE}:*`);
  if (keys.length > 0) {
    await redis.del(keys);
  }
  await TestModel.destroy({ where: {}, hooks: false });
});

afterAll(async () => {
  await sequelize.close();
  redis.disconnect();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('cache lifecycle', () => {
  it('findByPk hydrates from the database on cache miss, then serves from cache', async () => {
    const testModel = await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // First read — cache miss, should hit the database and populate cache.
    const first = await TestModel.findByPk(testModel.id, { cache: { enabled: true } });
    expect(first).not.toBeNull();
    expect(first!.def).toBe('456');

    // Verify the value landed in Redis.
    const redisKeys = await redis.keys(`${CACHE_NAMESPACE}:TestModel:*`);
    expect(redisKeys.length).toBeGreaterThan(0);

    // Second read — cache hit, should return the same data without a DB query.
    const second = await TestModel.findByPk(testModel.id, { cache: { enabled: true } });
    expect(second).not.toBeNull();
    expect(second!.dataValues).toEqual(first!.dataValues);
  });

  it('findOne by unique key hydrates from the database and serves from cache', async () => {
    await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // First read — cache miss.
    const first = await TestModel.findOne({
      where: { abc: '123' },
      cache: { enabled: true },
    });
    expect(first).not.toBeNull();
    expect(first!.def).toBe('456');

    // Second read — cache hit.
    const second = await TestModel.findOne({
      where: { abc: '123' },
      cache: { enabled: true },
    });
    expect(second).not.toBeNull();
    expect(second!.dataValues).toEqual(first!.dataValues);
  });

  it('update invalidates the cached entry', async () => {
    const testModel = await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // Populate cache.
    await TestModel.findByPk(testModel.id, { cache: { enabled: true } });

    // Update the record — the afterUpdate hook should invalidate the cache.
    testModel.ghi = '000';
    await testModel.save({ hooks: true });

    // Next read should hydrate from the database and reflect the update.
    const fresh = await TestModel.findByPk(testModel.id, { cache: { enabled: true } });
    expect(fresh).not.toBeNull();
    expect(fresh!.ghi).toBe('000');
  });

  it('destroy invalidates the cached entry', async () => {
    const testModel = await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // Populate cache.
    await TestModel.findByPk(testModel.id, { cache: { enabled: true } });

    // Destroy the record — the afterDestroy hook should invalidate the cache.
    await testModel.destroy();

    // Next read should return null.
    const gone = await TestModel.findByPk(testModel.id, { cache: { enabled: true } });
    expect(gone).toBeNull();
  });

  it('without cache option, queries go straight to the database', async () => {
    const testModel = await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // Query without cache option — should not populate cache.
    const result = await TestModel.findByPk(testModel.id);
    expect(result).not.toBeNull();
    expect(result!.def).toBe('456');

    // Confirm nothing was cached.
    const redisKeys = await redis.keys(`${CACHE_NAMESPACE}:TestModel:*`);
    expect(redisKeys).toHaveLength(0);
  });

  it('bulk update invalidates cached entries', async () => {
    const testModel = await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // Populate cache.
    await TestModel.findByPk(testModel.id, { cache: { enabled: true } });

    // Bulk update — the afterBulkUpdate hook should invalidate.
    await TestModel.update({ ghi: '999' }, { where: { abc: '123' } });

    // Cache should be invalidated; next read gets fresh data.
    const fresh = await TestModel.findByPk(testModel.id, { cache: { enabled: true } });
    expect(fresh).not.toBeNull();
    expect(fresh!.ghi).toBe('999');
  });

  it('bulk destroy invalidates cached entries', async () => {
    const testModel = await TestModel.create({ abc: '123', def: '456', ghi: '789' });

    // Populate cache.
    await TestModel.findByPk(testModel.id, { cache: { enabled: true } });

    // Bulk destroy.
    await TestModel.destroy({ where: { abc: '123' } });

    const gone = await TestModel.findByPk(testModel.id, { cache: { enabled: true } });
    expect(gone).toBeNull();
  });
});
