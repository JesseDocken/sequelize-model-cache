import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataTypes, Model, Sequelize } from 'sequelize';
import Redis from 'ioredis';

import { SequelizeCache } from '../index';

import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

// ─── Test Model ─────────────────────────────────────────────────────

class Device extends Model<InferAttributes<Device>, InferCreationAttributes<Device>> {
  declare id: CreationOptional<number>;
  declare serial: string;
  declare name: string;
  declare firmware: string;
}

// ─── Fixtures ───────────────────────────────────────────────────────

let sequelize: Sequelize;
let redis: Redis;
let cache: SequelizeCache;

const CACHE_NAMESPACE = 'lifecycle-test';

beforeAll(async () => {
  redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
  await redis.connect();

  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });

  Device.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serial: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    firmware: { type: DataTypes.STRING, allowNull: false },
  }, { sequelize, modelName: 'Device', timestamps: false });

  await sequelize.sync({ force: true });

  cache = new SequelizeCache({
    engine: { connection: redis, type: 'redis' },
    caching: { namespace: CACHE_NAMESPACE },
  });

  cache.cacheModel(Device, {
    uniqueKeys: [['serial']],
    ttl: 60,
  });
});

beforeEach(async () => {
  // Clear all cache keys and reset the table between tests.
  const keys = await redis.keys(`${CACHE_NAMESPACE}:*`);
  if (keys.length > 0) {
    await redis.del(keys);
  }
  await Device.destroy({ where: {}, hooks: false });
});

afterAll(async () => {
  await sequelize.close();
  redis.disconnect();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('cache lifecycle', () => {
  it('findByPk hydrates from the database on cache miss, then serves from cache', async () => {
    const device = await Device.create({ serial: 'SN-001', name: 'Switch A', firmware: '1.0.0' });

    // First read — cache miss, should hit the database and populate cache.
    const first = await Device.findByPk(device.id, { cache: { enabled: true } });
    expect(first).not.toBeNull();
    expect(first!.name).toBe('Switch A');

    // Verify the value landed in Redis.
    const redisKeys = await redis.keys(`${CACHE_NAMESPACE}:Device:*`);
    expect(redisKeys.length).toBeGreaterThan(0);

    // Second read — cache hit, should return the same data without a DB query.
    const second = await Device.findByPk(device.id, { cache: { enabled: true } });
    expect(second).not.toBeNull();
    expect(second!.dataValues).toEqual(first!.dataValues);
  });

  it('findOne by unique key hydrates from the database and serves from cache', async () => {
    await Device.create({ serial: 'SN-002', name: 'Router B', firmware: '2.0.0' });

    // First read — cache miss.
    const first = await Device.findOne({
      where: { serial: 'SN-002' },
      cache: { enabled: true },
    });
    expect(first).not.toBeNull();
    expect(first!.name).toBe('Router B');

    // Second read — cache hit.
    const second = await Device.findOne({
      where: { serial: 'SN-002' },
      cache: { enabled: true },
    });
    expect(second).not.toBeNull();
    expect(second!.dataValues).toEqual(first!.dataValues);
  });

  it('update invalidates the cached entry', async () => {
    const device = await Device.create({ serial: 'SN-003', name: 'AP C', firmware: '3.0.0' });

    // Populate cache.
    await Device.findByPk(device.id, { cache: { enabled: true } });

    // Update the record — the afterUpdate hook should invalidate the cache.
    device.firmware = '3.1.0';
    await device.save({ hooks: true });

    // Next read should hydrate from the database and reflect the update.
    const fresh = await Device.findByPk(device.id, { cache: { enabled: true } });
    expect(fresh).not.toBeNull();
    expect(fresh!.firmware).toBe('3.1.0');
  });

  it('destroy invalidates the cached entry', async () => {
    const device = await Device.create({ serial: 'SN-004', name: 'AP D', firmware: '4.0.0' });

    // Populate cache.
    await Device.findByPk(device.id, { cache: { enabled: true } });

    // Destroy the record — the afterDestroy hook should invalidate the cache.
    await device.destroy();

    // Next read should return null.
    const gone = await Device.findByPk(device.id, { cache: { enabled: true } });
    expect(gone).toBeNull();
  });

  it('without cache option, queries go straight to the database', async () => {
    const device = await Device.create({ serial: 'SN-005', name: 'AP E', firmware: '5.0.0' });

    // Query without cache option — should not populate cache.
    const result = await Device.findByPk(device.id);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('AP E');

    // Confirm nothing was cached.
    const redisKeys = await redis.keys(`${CACHE_NAMESPACE}:Device:*`);
    expect(redisKeys).toHaveLength(0);
  });

  it('bulk update invalidates cached entries', async () => {
    const device = await Device.create({ serial: 'SN-006', name: 'AP F', firmware: '6.0.0' });

    // Populate cache.
    await Device.findByPk(device.id, { cache: { enabled: true } });

    // Bulk update — the afterBulkUpdate hook should invalidate.
    await Device.update({ firmware: '6.1.0' }, { where: { serial: 'SN-006' } });

    // Cache should be invalidated; next read gets fresh data.
    const fresh = await Device.findByPk(device.id, { cache: { enabled: true } });
    expect(fresh).not.toBeNull();
    expect(fresh!.firmware).toBe('6.1.0');
  });

  it('bulk destroy invalidates cached entries', async () => {
    const device = await Device.create({ serial: 'SN-007', name: 'AP G', firmware: '7.0.0' });

    // Populate cache.
    await Device.findByPk(device.id, { cache: { enabled: true } });

    // Bulk destroy.
    await Device.destroy({ where: { serial: 'SN-007' } });

    const gone = await Device.findByPk(device.id, { cache: { enabled: true } });
    expect(gone).toBeNull();
  });
});
