import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// bigint (seq counters) arrive as strings by default; keep them exact but numeric when safe.
pg.types.setTypeParser(20, (value) => {
  const exact = BigInt(value);
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) && exact >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(exact) : value;
});

export interface OpenOptions {
  max?: number;
  /** Isolate all tables in this schema (used by the offline demo so it never touches production tables). */
  schema?: string;
}

/** Open a PostgreSQL pool. AccessLease metadata runs only on real PostgreSQL. */
export function openDatabase(url: string, options: OpenOptions = {}): Database {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("ACCESSLEASE_DATABASE_URL must start with postgres:// or postgresql://");
  const schema = options.schema;
  if (schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("invalid schema name");
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    // Pass the search_path as a startup parameter so it is in force before the first query on every connection.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  // An idle client error (server restart) must not crash the process; the next query reconnects.
  pool.on("error", () => undefined);
  const run = async <T>(client: pg.Pool | pg.PoolClient, text: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const result = await client.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };
  return {
    query: (text, params) => run(pool, text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (text, params) => run(client, text, params) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
