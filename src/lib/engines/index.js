import * as postgres from './postgres.js';
import * as mongodb from './mongodb.js';
import * as redis from './redis.js';

/**
 * Database engines beyond MySQL, keyed by credential provider. MySQL keeps its
 * own module (lib/mysql.js) and page; these three share one generic page.
 */
export const ENGINES = { postgres, mongodb, redis };

/** Every provider that is a database, MySQL included, with what the add-connection form needs. */
export const DATABASE_PROVIDERS = {
  mysql: { label: 'MySQL', icon: '🐬', defaultPort: 3306, userRequired: true },
  postgres: { label: 'PostgreSQL', icon: '🐘', defaultPort: 5432, userRequired: true },
  mongodb: { label: 'MongoDB', icon: '🍃', defaultPort: 27017, userRequired: false },
  redis: { label: 'Redis', icon: '⚡', defaultPort: 6379, userRequired: false },
};

export const engineFor = (provider) => ENGINES[provider] || null;
