import { Pool, type PoolClient } from 'pg';

/**
 * The database, when there is one.
 *
 * An installation put up with `docker compose up` gets Postgres in the stack and uses it. A clone run
 * with `npm start` on somebody's laptop, the command line, and the test suite get no database and no
 * demand for one — the same code then keeps its rows in files. Both are real deployments and neither
 * is a fallback in the apologetic sense: a scraper on a laptop should not need a database server to
 * hand back two hundred rows.
 *
 * Which one is in use is decided by one variable, `RATATOSK_DB`, and by nothing else. There is no
 * autodetection, because a service that quietly writes somewhere other than where you think it does
 * is a service you cannot back up.
 */
let pool: Pool | undefined;
let ready: Promise<void> | undefined;

export function dbUrl(): string | undefined {
  return process.env['RATATOSK_DB'] || undefined;
}

export function usingDatabase(): boolean {
  return Boolean(dbUrl());
}

function poolFor(url: string): Pool {
  pool ??= new Pool({
    connectionString: url,
    // A browser holds a run open for a minute at a time; a pool that hands out a connection per run
    // and never more is enough, and it means a burst of runs queues rather than exhausting Postgres.
    max: Number(process.env['RATATOSK_DB_POOL'] ?? 8),
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

/**
 * The schema, created if it is not there.
 *
 * No migration tool: one statement per table, all of them `IF NOT EXISTS`, run on the first query. A
 * schema this small does not need a framework, and a framework here would mean a version table, a
 * lock, and a failure mode where the service will not start because a migration is half-applied.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS results (
  user_id     TEXT        NOT NULL,
  scraper     TEXT        NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  status      TEXT        NOT NULL,
  pages       INTEGER     NOT NULL DEFAULT 0,
  reason      TEXT,
  rows        JSONB       NOT NULL,
  row_count   INTEGER     NOT NULL,
  PRIMARY KEY (user_id, scraper, at)
);

CREATE INDEX IF NOT EXISTS results_by_scraper ON results (user_id, scraper, at DESC);

CREATE TABLE IF NOT EXISTS schedules (
  user_id       TEXT        NOT NULL,
  scraper       TEXT        NOT NULL,
  every_minutes INTEGER     NOT NULL,
  next_at       TIMESTAMPTZ NOT NULL,
  last_at       TIMESTAMPTZ,
  paused        BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, scraper)
);

CREATE INDEX IF NOT EXISTS schedules_due ON schedules (next_at) WHERE paused = false;
`;

export async function db(): Promise<Pool> {
  const url = dbUrl();
  if (!url) throw new Error('no database is configured — set RATATOSK_DB');

  const connected = poolFor(url);
  ready ??= connected.query(SCHEMA).then(() => undefined);
  await ready;
  return connected;
}

/** For the tests and for shutdown: let the process end instead of waiting on an idle pool. */
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  ready = undefined;
}

export type { PoolClient };
