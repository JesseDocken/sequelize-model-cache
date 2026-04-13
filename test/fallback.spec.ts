import Redis from 'ioredis';
import { DataTypes, Model, Sequelize } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SequelizeCache } from '../index';

import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

// Models

class ConnectedModel extends Model<InferAttributes<ConnectedModel>, InferCreationAttributes<ConnectedModel>> {
  declare id: CreationOptional<number>;
  declare name: string;
}

class DisconnectedModel extends Model<InferAttributes<DisconnectedModel>, InferCreationAttributes<DisconnectedModel>> {
  declare id: CreationOptional<number>;
  declare name: string;
}

// Fixtures

let sequelize: Sequelize;
let goodRedis: Redis;
let badRedis: Redis;

const NAMESPACE = 'fallback-test';

beforeAll(async () => {
  goodRedis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
  await goodRedis.connect();

  // Connect to a non-listening port. Disable retries and offline queueing so
  // operations fail fast rather than hanging.
  badRedis = new Redis({
    host: '127.0.0.1',
    port: 6390,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 200,
    retryStrategy: () => null,
  });

  sequelize = new Sequelize({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'test',
    password: 'test',
    database: 'test',
    logging: false,
  });

  ConnectedModel.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
  }, {
    sequelize,
    modelName: 'ConnectedModel',
    timestamps: false,
    scopes: {
      named: { where: { name: 'scoped' } },
    },
  });

  DisconnectedModel.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
  }, { sequelize, modelName: 'DisconnectedModel', timestamps: false });

  await sequelize.sync({ force: true });

  const connectedCache = new SequelizeCache({
    engine: { connection: goodRedis, type: 'redis' },
    caching: { namespace: NAMESPACE },
  });
  connectedCache.cacheModel(ConnectedModel);

  const disconnectedCache = new SequelizeCache({
    engine: { connection: badRedis, type: 'redis' },
    caching: { namespace: NAMESPACE },
  });
  disconnectedCache.cacheModel(DisconnectedModel);
});

beforeEach(async () => {
  const keys = await goodRedis.keys(`${NAMESPACE}:*`);
  if (keys.length > 0) {
    await goodRedis.del(keys);
  }
  await ConnectedModel.destroy({ where: {}, hooks: false });
  await DisconnectedModel.destroy({ where: {}, hooks: false });
});

afterAll(async () => {
  await sequelize.close();
  goodRedis.disconnect();
  badRedis.disconnect();
});

// Tests

describe('fallback behavior', () => {
  describe('cache engine unavailable', () => {
    it('falls back to database when fallback is "database"', async () => {
      const inst = await DisconnectedModel.create({ name: 'Widget' });

      const result = await DisconnectedModel.findByPk(inst.id, {
        cache: { enabled: true, fallback: 'database' },
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Widget');
    });

    it('throws when fallback is "fail"', async () => {
      const inst = await DisconnectedModel.create({ name: 'Widget' });

      await expect(DisconnectedModel.findByPk(inst.id, {
        cache: { enabled: true, fallback: 'fail' },
      })).rejects.toThrow();
    });
  });

  describe('scoped model query', () => {
    it('falls back to database with default fallback', async () => {
      const inst = await ConnectedModel.create({ name: 'scoped' });

      const result = await ConnectedModel.scope('named').findByPk(inst.id, {
        cache: { enabled: true },
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('scoped');

      // Nothing should have been cached.
      const redisKeys = await goodRedis.keys(`${NAMESPACE}:ConnectedModel:*`);
      expect(redisKeys).toHaveLength(0);
    });

    it('throws when fallback is "fail"', async () => {
      const inst = await ConnectedModel.create({ name: 'scoped' });

      await expect(ConnectedModel.scope('named').findByPk(inst.id, {
        cache: { enabled: true, fallback: 'fail' },
      })).rejects.toThrow('Query is nonconformant');
    });
  });

  describe('unsupported query options', () => {
    it('falls back to database with default fallback', async () => {
      const inst = await ConnectedModel.create({ name: 'Widget' });

      // `limit` is not in the permitted options list.
      const result = await ConnectedModel.findOne({
        where: { id: inst.id },
        limit: 1,
        cache: { enabled: true },
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Widget');

      const redisKeys = await goodRedis.keys(`${NAMESPACE}:ConnectedModel:*`);
      expect(redisKeys).toHaveLength(0);
    });

    it('throws when fallback is "fail"', async () => {
      const inst = await ConnectedModel.create({ name: 'Widget' });

      await expect(ConnectedModel.findOne({
        where: { id: inst.id },
        limit: 1,
        cache: { enabled: true, fallback: 'fail' },
      })).rejects.toThrow('Query is nonconformant');
    });
  });

  describe('unsupported where clause', () => {
    it('falls back to database with default fallback', async () => {
      await ConnectedModel.create({ name: 'Widget' });

      // `name` is not a primary or declared unique key.
      const result = await ConnectedModel.findOne({
        where: { name: 'Widget' },
        cache: { enabled: true },
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Widget');

      const redisKeys = await goodRedis.keys(`${NAMESPACE}:ConnectedModel:*`);
      expect(redisKeys).toHaveLength(0);
    });

    it('throws when fallback is "fail"', async () => {
      await ConnectedModel.create({ name: 'Widget' });

      await expect(ConnectedModel.findOne({
        where: { name: 'Widget' },
        cache: { enabled: true, fallback: 'fail' },
      })).rejects.toThrow('Query is nonconformant');
    });
  });
});
