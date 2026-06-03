import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from "kysely";
import {
  CompiledQuery,
  DeleteQueryNode,
  IdentifierNode,
  InsertQueryNode,
  RawNode,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  UpdateQueryNode,
  createQueryId,
} from "kysely";

// Kysely dialect for Node's synchronous node:sqlite API. The driver serializes
// connection use because DatabaseSync is single-connection and blocking.
type MaybePromise<T> = T | Promise<T>;

/** Configuration for the node:sqlite Kysely dialect. */
export type NodeSqliteKyselyDialectConfig = {
  database: DatabaseSync | (() => MaybePromise<DatabaseSync>);
  onCreateConnection?: (connection: DatabaseConnection) => MaybePromise<void>;
  transactionMode?: "deferred" | "immediate" | "exclusive";
};

/** Kysely dialect backed by a node:sqlite DatabaseSync instance. */
export class NodeSqliteKyselyDialect implements Dialect {
  readonly #config: NodeSqliteKyselyDialectConfig;

  constructor(config: NodeSqliteKyselyDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  createDriver(): Driver {
    return new NodeSqliteKyselyDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NodeSqliteKyselyDriver implements Driver {
  readonly #config: NodeSqliteKyselyDialectConfig;
  readonly #mutex = new ConnectionMutex();

  #db?: DatabaseSync;
  #connection?: DatabaseConnection;

  constructor(config: NodeSqliteKyselyDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  async init(): Promise<void> {
    this.#db =
      typeof this.#config.database === "function"
        ? await this.#config.database()
        : this.#config.database;

    this.#connection = new NodeSqliteKyselyConnection(this.#db);
    await this.#config.onCreateConnection?.(this.#connection);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    // Kysely expects async acquisition even though node:sqlite is sync; the
    // mutex preserves transaction ordering across concurrent callers.
    await this.#mutex.lock();
    return this.#connection!;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    const mode = this.#config.transactionMode ?? "deferred";
    await connection.executeQuery(CompiledQuery.raw(`begin ${mode}`));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(createSavepointCommand("savepoint", savepointName), createQueryId()),
    );
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(createSavepointCommand("rollback to", savepointName), createQueryId()),
    );
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(createSavepointCommand("release", savepointName), createQueryId()),
    );
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
    this.#connection = undefined;
  }
}

class NodeSqliteKyselyConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    return Promise.resolve(executeCompiledQuerySync<O>(this.#db, compiledQuery));
  }

  async *streamQuery<O>(
    compiledQuery: CompiledQuery,
    _chunkSize?: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.#db.prepare(sql);

    for (const row of stmt.iterate(...(parameters as SQLInputValue[]))) {
      yield { rows: [row as O] };
    }
  }
}

/** Execute a compiled Kysely query synchronously against node:sqlite. */
export function executeCompiledQuerySync<O>(
  db: DatabaseSync,
  compiledQuery: CompiledQuery,
): QueryResult<O> {
  const statement = db.prepare(compiledQuery.sql);
  const parameters = compiledQuery.parameters as SQLInputValue[];

  if (statementReturnsRows(statement, compiledQuery)) {
    return { rows: statement.all(...parameters) as O[] };
  }

  const { changes, lastInsertRowid } = statement.run(...parameters);
  const result: QueryResult<O> = {
    numAffectedRows: BigInt(changes),
    rows: [],
  };
  if (InsertQueryNode.is(compiledQuery.query) && changes > 0) {
    return { ...result, insertId: BigInt(lastInsertRowid) };
  }
  return result;
}

// node:sqlite added StatementSync.columns() in v22.16/v23.11; it asks SQLite
// directly whether a prepared statement yields a result set. Node 23.0–23.10
// (still >=22.19, so allowed by engines) lack it, so fall back to the compiled
// Kysely node. That is exact here: callers only execute builder queries through
// this dialect, and the dialect itself only raw-executes transaction-control
// statements (begin/commit/rollback/savepoint), none of which return rows.
function statementReturnsRows(statement: StatementSync, compiledQuery: CompiledQuery): boolean {
  if (typeof statement.columns === "function") {
    return statement.columns().length > 0;
  }
  const node = compiledQuery.query;
  if (SelectQueryNode.is(node)) {
    return true;
  }
  if (InsertQueryNode.is(node) || UpdateQueryNode.is(node) || DeleteQueryNode.is(node)) {
    return node.returning != null;
  }
  return false;
}

function createSavepointCommand(command: string, savepointName: string): RawNode {
  return RawNode.createWithChildren([
    RawNode.createWithSql(`${command} `),
    IdentifierNode.create(savepointName),
  ]);
}

class ConnectionMutex {
  #promise?: Promise<void>;
  #resolve?: () => void;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }

    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}
