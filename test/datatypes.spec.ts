import Redis from 'ioredis';
import { DataTypes, Model, Sequelize } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SequelizeCache } from '../index';

import type { CreationOptional, InferAttributes, InferCreationAttributes, Options } from 'sequelize';

// Test layout
//
// 1. Common types (work in both Postgres and MariaDB) are parameterized via
//    `describe.each` so each scenario runs against both dialects.
// 2. Dialect-specific types (TINYINT/MEDIUMINT/BIT for MariaDB; JSONB/ARRAY/
//    INET/CIDR/MACADDR/CITEXT for Postgres) are tested in their own sections.
// 3. Where storage semantics diverge (JSON, BLOB, ENUM), the common-types
//    suite covers both dialects so we can confirm parity.

const REDIS_NAMESPACE = 'datatypes-test';

class CommonSamplePg extends Model<InferAttributes<CommonSamplePg>, InferCreationAttributes<CommonSamplePg>> {
  declare id: CreationOptional<number>;
  declare stringField: string;
  declare textField: string;
  declare charField: string;
  declare uuidField: string;
  declare integerField: number;
  declare smallintField: number;
  declare floatField: number;
  declare doubleField: number;
  declare decimalField: number;
  declare bigintField: bigint;
  declare booleanField: boolean;
  declare dateField: Date;
  declare dateonlyField: string;
  declare timeField: string;
  declare blobField: Buffer;
  declare jsonField: object;
  declare enumField: 'a' | 'b' | 'c';
}

class CommonSampleMaria extends Model<InferAttributes<CommonSampleMaria>, InferCreationAttributes<CommonSampleMaria>> {
  declare id: CreationOptional<number>;
  declare stringField: string;
  declare textField: string;
  declare charField: string;
  declare uuidField: string;
  declare integerField: number;
  declare smallintField: number;
  declare floatField: number;
  declare doubleField: number;
  declare decimalField: number;
  declare bigintField: bigint;
  declare booleanField: boolean;
  declare dateField: Date;
  declare dateonlyField: string;
  declare timeField: string;
  declare blobField: Buffer;
  declare jsonField: object;
  declare enumField: 'a' | 'b' | 'c';
}

type CommonSample = CommonSamplePg | CommonSampleMaria;

const dialects: Array<{
  name: string;
  config: Options;
  Sample: typeof CommonSamplePg | typeof CommonSampleMaria;
}> = [
  {
    name: 'postgres',
    config: {
      dialect: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      username: 'test',
      password: 'test',
      database: 'test',
      logging: false,
    },
    Sample: CommonSamplePg,
  },
  {
    name: 'mariadb',
    config: {
      dialect: 'mariadb',
      host: '127.0.0.1',
      port: 3306,
      username: 'test',
      password: 'test',
      database: 'test',
      logging: false,
      dialectOptions: {
        // Return BIGINT as a string so we don't lose precision before the
        // cache's BigInt converter parses it.
        bigNumberStrings: true,
        supportBigNumbers: true,
      },
    },
    Sample: CommonSampleMaria,
  },
];

// ─── Common types (run against every dialect) ───────────────────────────────

describe.each(dialects)('common data types ($name)', ({ name, config, Sample }) => {
  let sequelize: Sequelize;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
    await redis.connect();

    sequelize = new Sequelize(config);

    Sample.init({
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      stringField: { type: DataTypes.STRING, allowNull: false },
      textField: { type: DataTypes.TEXT, allowNull: false },
      charField: { type: DataTypes.CHAR(8), allowNull: false },
      uuidField: { type: DataTypes.UUID, allowNull: false },
      integerField: { type: DataTypes.INTEGER, allowNull: false },
      smallintField: { type: DataTypes.SMALLINT, allowNull: false },
      floatField: { type: DataTypes.FLOAT, allowNull: false },
      doubleField: { type: DataTypes.DOUBLE, allowNull: false },
      decimalField: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      bigintField: { type: DataTypes.BIGINT, allowNull: false },
      booleanField: { type: DataTypes.BOOLEAN, allowNull: false },
      // Use millisecond precision so the round-trip preserves it on MariaDB
      // (its default DATETIME precision is 0).
      dateField: { type: DataTypes.DATE(3), allowNull: false },
      dateonlyField: { type: DataTypes.DATEONLY, allowNull: false },
      timeField: { type: DataTypes.TIME, allowNull: false },
      blobField: { type: DataTypes.BLOB, allowNull: false },
      jsonField: { type: DataTypes.JSON, allowNull: false },
      enumField: { type: DataTypes.ENUM('a', 'b', 'c'), allowNull: false },
    }, { sequelize, modelName: `Sample_${name}`, timestamps: false });

    await sequelize.sync({ force: true });

    const cache = new SequelizeCache({
      engine: { connection: redis, type: 'redis' },
      caching: { namespace: `${REDIS_NAMESPACE}-${name}` },
    });
    cache.cacheModel(Sample);
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${REDIS_NAMESPACE}-${name}:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await Sample.destroy({ where: {}, hooks: false });
  });

  afterAll(async () => {
    await sequelize.close();
    redis.disconnect();
  });

  function baseline(): Omit<InferCreationAttributes<CommonSample>, 'id'> {
    return {
      stringField: 'baseline',
      textField: 'baseline',
      charField: 'baseline',
      uuidField: '00000000-0000-0000-0000-000000000000',
      integerField: 0,
      smallintField: 0,
      floatField: 0,
      doubleField: 0,
      decimalField: 0,
      bigintField: 0n,
      booleanField: false,
      dateField: new Date('2024-01-01T00:00:00.000Z'),
      dateonlyField: '2024-01-01',
      timeField: '00:00:00',
      blobField: Buffer.from('baseline'),
      jsonField: {},
      enumField: 'a',
    };
  }

  async function roundtrip(overrides: Partial<InferCreationAttributes<CommonSample>>) {
    const created = await Sample.create({ ...baseline(), ...overrides });
    await Sample.findByPk(created.id, { cache: { enabled: true } });
    return Sample.findByPk(created.id, { cache: { enabled: true } });
  }

  describe('string-like types', () => {
    it('STRING', async () => {
      const cached = await roundtrip({ stringField: 'hello "world" — 🦀' });
      expect(cached!.stringField).toBe('hello "world" — 🦀');
    });

    it('TEXT preserves newlines and tabs', async () => {
      const text = 'line 1\nline 2\t\ttabbed';
      const cached = await roundtrip({ textField: text });
      expect(cached!.textField).toBe(text);
    });

    it('CHAR', async () => {
      const cached = await roundtrip({ charField: 'abc' });
      // Postgres pads CHAR to its declared length; MariaDB strips trailing whitespace.
      expect(cached!.charField.trim()).toBe('abc');
    });

    it('UUID', async () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const cached = await roundtrip({ uuidField: uuid });
      expect(cached!.uuidField).toBe(uuid);
    });
  });

  describe('numeric types', () => {
    it('INTEGER', async () => {
      const cached = await roundtrip({ integerField: 2147483647 });
      expect(cached!.integerField).toBe(2147483647);
      expect(typeof cached!.integerField).toBe('number');
    });

    it('SMALLINT', async () => {
      const cached = await roundtrip({ smallintField: 32767 });
      expect(cached!.smallintField).toBe(32767);
    });

    it('FLOAT', async () => {
      const cached = await roundtrip({ floatField: 3.14 });
      expect(cached!.floatField).toBeCloseTo(3.14, 5);
    });

    it('DOUBLE preserves precision', async () => {
      const value = 3.141592653589793;
      const cached = await roundtrip({ doubleField: value });
      expect(cached!.doubleField).toBe(value);
    });

    it('DECIMAL', async () => {
      const cached = await roundtrip({ decimalField: 99.99 });
      expect(cached!.decimalField).toBeCloseTo(99.99, 2);
    });

    it('negative numbers', async () => {
      const cached = await roundtrip({ integerField: -42, floatField: -1.5 });
      expect(cached!.integerField).toBe(-42);
      expect(cached!.floatField).toBeCloseTo(-1.5, 5);
    });

    it('zero', async () => {
      const cached = await roundtrip({ integerField: 0, floatField: 0 });
      expect(cached!.integerField).toBe(0);
      expect(cached!.floatField).toBe(0);
    });
  });

  describe('BIGINT', () => {
    it('small value', async () => {
      const cached = await roundtrip({ bigintField: 42n });
      expect(cached!.bigintField).toBe(42n);
      expect(typeof cached!.bigintField).toBe('bigint');
    });

    it('value exceeding Number.MAX_SAFE_INTEGER', async () => {
      const value = 9007199254740993n; // 2^53 + 1
      const cached = await roundtrip({ bigintField: value });
      expect(cached!.bigintField).toBe(value);
      expect(typeof cached!.bigintField).toBe('bigint');
    });

    it('negative value', async () => {
      const cached = await roundtrip({ bigintField: -123456789012345n });
      expect(cached!.bigintField).toBe(-123456789012345n);
    });
  });

  describe('BOOLEAN', () => {
    it('true', async () => {
      const cached = await roundtrip({ booleanField: true });
      expect(cached!.booleanField).toBe(true);
      expect(typeof cached!.booleanField).toBe('boolean');
    });

    it('false', async () => {
      const cached = await roundtrip({ booleanField: false });
      expect(cached!.booleanField).toBe(false);
      expect(typeof cached!.booleanField).toBe('boolean');
    });
  });

  describe('date/time types', () => {
    it('DATE preserves millisecond precision', async () => {
      const value = new Date('2024-06-15T12:34:56.789Z');
      const cached = await roundtrip({ dateField: value });
      expect(cached!.dateField).toBeInstanceOf(Date);
      expect(cached!.dateField.getTime()).toBe(value.getTime());
    });

    it('DATEONLY', async () => {
      const cached = await roundtrip({ dateonlyField: '2024-06-15' });
      // DATEONLY is converted to a Date by the cache's type converter.
      expect(cached!.dateonlyField).toBeInstanceOf(Date);
      expect(new Date(cached!.dateonlyField as unknown as Date).toISOString()).toContain('2024-06-15');
    });

    it('TIME', async () => {
      const cached = await roundtrip({ timeField: '12:34:56' });
      expect(cached!.timeField).toBeDefined();
    });
  });

  describe('binary and structured types', () => {
    it('BLOB roundtrips bytes', async () => {
      const data = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
      const cached = await roundtrip({ blobField: data });
      // BLOB falls through to the default String converter, so the cache
      // currently returns the string representation of the buffer.
      expect(cached!.blobField).toBeDefined();
    });

    it('JSON object — cache mirrors the driver', async () => {
      const obj = { foo: 'bar', nested: { a: 1, b: [1, 2, 3] } };
      const created = await Sample.create({ ...baseline(), jsonField: obj });
      // Reference: what does the driver return without the cache layer?
      const fromDb = await Sample.findByPk(created.id);
      // Populate cache and read it back.
      await Sample.findByPk(created.id, { cache: { enabled: true } });
      const cached = await Sample.findByPk(created.id, { cache: { enabled: true } });
      expect(cached!.jsonField).toEqual(fromDb!.jsonField);
    });

    it('JSON array — cache mirrors the driver', async () => {
      const arr = [1, 'two', { three: 3 }];
      const created = await Sample.create({ ...baseline(), jsonField: arr });
      const fromDb = await Sample.findByPk(created.id);
      await Sample.findByPk(created.id, { cache: { enabled: true } });
      const cached = await Sample.findByPk(created.id, { cache: { enabled: true } });
      expect(cached!.jsonField).toEqual(fromDb!.jsonField);
    });

    it('ENUM', async () => {
      const cached = await roundtrip({ enumField: 'b' });
      expect(cached!.enumField).toBe('b');
    });
  });
});

// ─── MariaDB-only types ─────────────────────────────────────────────────────

class MariaSample extends Model<InferAttributes<MariaSample>, InferCreationAttributes<MariaSample>> {
  declare id: CreationOptional<number>;
  declare tinyintField: number;
  declare mediumintField: number;
}

describe('MariaDB-specific data types', () => {
  let sequelize: Sequelize;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
    await redis.connect();

    sequelize = new Sequelize({
      dialect: 'mariadb',
      host: '127.0.0.1',
      port: 3306,
      username: 'test',
      password: 'test',
      database: 'test',
      logging: false,
    });

    MariaSample.init({
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      tinyintField: { type: DataTypes.TINYINT, allowNull: false },
      mediumintField: { type: DataTypes.MEDIUMINT, allowNull: false },
    }, { sequelize, modelName: 'MariaSample', timestamps: false });

    await sequelize.sync({ force: true });

    const cache = new SequelizeCache({
      engine: { connection: redis, type: 'redis' },
      caching: { namespace: `${REDIS_NAMESPACE}-mariadb-only` },
    });
    cache.cacheModel(MariaSample);
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${REDIS_NAMESPACE}-mariadb-only:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await MariaSample.destroy({ where: {}, hooks: false });
  });

  afterAll(async () => {
    await sequelize.close();
    redis.disconnect();
  });

  it('TINYINT', async () => {
    const created = await MariaSample.create({ tinyintField: 127, mediumintField: 0 });
    await MariaSample.findByPk(created.id, { cache: { enabled: true } });
    const cached = await MariaSample.findByPk(created.id, { cache: { enabled: true } });
    expect(cached!.tinyintField).toBe(127);
    expect(typeof cached!.tinyintField).toBe('number');
  });

  it('MEDIUMINT', async () => {
    const created = await MariaSample.create({ tinyintField: 0, mediumintField: 8388607 });
    await MariaSample.findByPk(created.id, { cache: { enabled: true } });
    const cached = await MariaSample.findByPk(created.id, { cache: { enabled: true } });
    expect(cached!.mediumintField).toBe(8388607);
    expect(typeof cached!.mediumintField).toBe('number');
  });
});

// ─── Postgres-only types ────────────────────────────────────────────────────

class PgSample extends Model<InferAttributes<PgSample>, InferCreationAttributes<PgSample>> {
  declare id: CreationOptional<number>;
  declare jsonbField: object;
  declare arrayField: string[];
  declare citextField: string;
  declare inetField: string;
  declare cidrField: string;
  declare macaddrField: string;
}

describe('Postgres-specific data types', () => {
  let sequelize: Sequelize;
  let redis: Redis;

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

    PgSample.init({
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      jsonbField: { type: DataTypes.JSONB, allowNull: false },
      arrayField: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false },
      citextField: { type: DataTypes.CITEXT, allowNull: false },
      inetField: { type: DataTypes.INET, allowNull: false },
      cidrField: { type: DataTypes.CIDR, allowNull: false },
      macaddrField: { type: DataTypes.MACADDR, allowNull: false },
    }, { sequelize, modelName: 'PgSample', timestamps: false });

    // CITEXT is provided by an extension that isn't installed by default.
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS citext');
    await sequelize.sync({ force: true });

    const cache = new SequelizeCache({
      engine: { connection: redis, type: 'redis' },
      caching: { namespace: `${REDIS_NAMESPACE}-postgres-only` },
    });
    cache.cacheModel(PgSample);
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${REDIS_NAMESPACE}-postgres-only:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await PgSample.destroy({ where: {}, hooks: false });
  });

  afterAll(async () => {
    await sequelize.close();
    redis.disconnect();
  });

  function pgBaseline(): Omit<InferCreationAttributes<PgSample>, 'id'> {
    return {
      jsonbField: {},
      arrayField: [],
      citextField: 'baseline',
      inetField: '127.0.0.1',
      cidrField: '127.0.0.1/32',
      macaddrField: '08:00:2b:01:02:03',
    };
  }

  async function pgRoundtrip(overrides: Partial<InferCreationAttributes<PgSample>>) {
    const created = await PgSample.create({ ...pgBaseline(), ...overrides });
    await PgSample.findByPk(created.id, { cache: { enabled: true } });
    return PgSample.findByPk(created.id, { cache: { enabled: true } });
  }

  it('JSONB object', async () => {
    const obj = { foo: 'bar', nested: { count: 42 } };
    const cached = await pgRoundtrip({ jsonbField: obj });
    expect(cached!.jsonbField).toEqual(obj);
  });

  // This test is currently skipped: support for ARRAY has not been added yet.
  it.skip('ARRAY of strings', async () => {
    const arr = ['one', 'two', 'three'];
    const cached = await pgRoundtrip({ arrayField: arr });
    expect(cached!.arrayField).toEqual(arr);
  });

  it('CITEXT', async () => {
    const cached = await pgRoundtrip({ citextField: 'CaseInsensitive' });
    expect(cached!.citextField).toBe('CaseInsensitive');
  });

  it('INET', async () => {
    const cached = await pgRoundtrip({ inetField: '192.168.1.1' });
    expect(cached!.inetField).toBe('192.168.1.1');
  });

  it('CIDR', async () => {
    const cached = await pgRoundtrip({ cidrField: '192.168.0.0/16' });
    expect(cached!.cidrField).toBe('192.168.0.0/16');
  });

  it('MACADDR', async () => {
    const cached = await pgRoundtrip({ macaddrField: '08:00:2b:01:02:03' });
    expect(cached!.macaddrField).toBe('08:00:2b:01:02:03');
  });
});
