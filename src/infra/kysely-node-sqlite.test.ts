import { DatabaseSync } from "node:sqlite";
import { CompiledQuery, Kysely, sql, type Generated } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeSqliteKyselyDialect } from "./kysely-node-sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type TestDatabase = {
  person: {
    id: Generated<number>;
    name: string;
  };
};

describe("NodeSqliteKyselyDialect", () => {
  let db: Kysely<TestDatabase> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("uses node:sqlite with raw row-returning queries and returning clauses", async () => {
    db = await createTestDb();

    await expect(db.selectFrom("person").selectAll().execute()).resolves.toEqual([
      { id: 1, name: "Ada" },
    ]);
    await expect(sql`select name from person where id = ${1}`.execute(db)).resolves.toEqual({
      rows: [{ name: "Ada" }],
    });
    await expect(
      db.insertInto("person").values({ name: "Grace" }).returning(["id", "name"]).execute(),
    ).resolves.toEqual([{ id: 2, name: "Grace" }]);
    await expect(
      sql`insert into person (name) values ('Lin') returning *`.execute(db),
    ).resolves.toEqual({
      rows: [{ id: 3, name: "Lin" }],
    });

    const ignoredInsert = await sql`
      insert or ignore into person (id, name) values (${1}, ${"Ada Again"})
    `.execute(db);
    expect(ignoredInsert.insertId).toBeUndefined();
    expect(ignoredInsert.numAffectedRows).toBe(0n);

    const update = await sql`update person set name = ${"Ada Lovelace"} where id = ${1}`.execute(
      db,
    );
    expect(update.insertId).toBeUndefined();
    expect(update.numAffectedRows).toBe(1n);
  });

  it("creates the database lazily and runs the connection hook once", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const createDatabase = vi.fn(() => sqlite);
    const onCreateConnection = vi.fn(async (connection) => {
      await connection.executeQuery(CompiledQuery.raw("pragma user_version = 7"));
    });

    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: createDatabase,
        onCreateConnection,
      }),
    });

    await expect(sql<{ user_version: number }>`pragma user_version`.execute(db)).resolves.toEqual({
      rows: [{ user_version: 7 }],
    });
    expect(createDatabase).toHaveBeenCalledTimes(1);
    expect(onCreateConnection).toHaveBeenCalledTimes(1);
  });

  it("returns insert metadata only for changed insert statements", async () => {
    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: new DatabaseSync(":memory:"),
      }),
    });
    await createPersonTable(db);

    const insertResult = await db
      .insertInto("person")
      .values({ name: "Ada" })
      .executeTakeFirstOrThrow();
    expect(insertResult.insertId).toBe(1n);
    expect(insertResult.numInsertedOrUpdatedRows).toBe(1n);

    const updateResult = await db
      .updateTable("person")
      .set({ name: "Ada Lovelace" })
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    expect(updateResult.numUpdatedRows).toBe(1n);

    const ignoredInsert = await sql`
      insert or ignore into person (id, name) values (${1}, ${"Ada Again"})
    `.execute(db);
    expect(ignoredInsert.insertId).toBeUndefined();
    expect(ignoredInsert.numAffectedRows).toBe(0n);
  });

  it("classifies builder statements from the Kysely node when StatementSync.columns is unavailable", async () => {
    // Node 23.0–23.10 ship node:sqlite without StatementSync.columns() (added in
    // v22.16/v23.11) yet still satisfy the >=22.19 engines floor. With columns()
    // hidden, the driver must pick all()/run() from the compiled query node.
    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: withoutStatementColumns(new DatabaseSync(":memory:")),
      }),
    });
    await createPersonTable(db);

    const insertResult = await db
      .insertInto("person")
      .values({ name: "Ada" })
      .executeTakeFirstOrThrow();
    expect(insertResult.insertId).toBe(1n);
    expect(insertResult.numInsertedOrUpdatedRows).toBe(1n);

    await expect(db.selectFrom("person").selectAll().execute()).resolves.toEqual([
      { id: 1, name: "Ada" },
    ]);
    await expect(
      db.insertInto("person").values({ name: "Grace" }).returning(["id", "name"]).execute(),
    ).resolves.toEqual([{ id: 2, name: "Grace" }]);

    const updateResult = await db
      .updateTable("person")
      .set({ name: "Ada Lovelace" })
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    expect(updateResult.numUpdatedRows).toBe(1n);

    const deleteResult = await db
      .deleteFrom("person")
      .where("id", "=", 2)
      .executeTakeFirstOrThrow();
    expect(deleteResult.numDeletedRows).toBe(1n);
  });

  it("runs the sync helper path when StatementSync.columns is unavailable", () => {
    // This is the exact path that crashed in the report: state migrations call
    // executeSqliteQuerySync, which prepared a statement and called columns() —
    // absent on Node 23.0–23.10. Drive the sync helper with columns() hidden.
    const raw = withoutStatementColumns(new DatabaseSync(":memory:"));
    raw.exec("create table person (id integer primary key autoincrement, name text not null)");
    const kdb = getNodeSqliteKysely<TestDatabase>(raw);

    const inserted = executeSqliteQuerySync(raw, kdb.insertInto("person").values({ name: "Ada" }));
    expect(inserted.insertId).toBe(1n);
    expect(inserted.numAffectedRows).toBe(1n);

    const selected = executeSqliteQuerySync(raw, kdb.selectFrom("person").selectAll());
    expect(selected.rows).toEqual([{ id: 1, name: "Ada" }]);
  });

  it("rolls back transactions and controlled savepoints", async () => {
    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: new DatabaseSync(":memory:"),
      }),
    });
    await createPersonTable(db);

    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("person").values({ name: "Rollback" }).execute();
        throw new Error("rollback outer");
      }),
    ).rejects.toThrow("rollback outer");
    await expect(db.selectFrom("person").selectAll().execute()).resolves.toStrictEqual([]);

    const trx = await db.startTransaction().execute();
    await trx.insertInto("person").values({ name: "Ada" }).execute();
    const afterAda = await trx.savepoint("after_ada").execute();
    await afterAda.insertInto("person").values({ name: "Grace" }).execute();
    const afterRollback = await afterAda.rollbackToSavepoint("after_ada").execute();
    await afterRollback.insertInto("person").values({ name: "Lin" }).execute();
    await afterRollback.commit().execute();

    await expect(db.selectFrom("person").select("name").orderBy("id").execute()).resolves.toEqual([
      { name: "Ada" },
      { name: "Lin" },
    ]);
  });

  it("streams selected rows through node:sqlite iteration", async () => {
    db = await createTestDb();
    await db
      .insertInto("person")
      .values([{ name: "Grace" }, { name: "Lin" }])
      .execute();

    const rows: Array<{ id: number; name: string }> = [];
    for await (const row of db.selectFrom("person").selectAll().orderBy("id").stream(1)) {
      rows.push(row);
    }

    expect(rows).toEqual([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ]);
  });
});

async function createTestDb(): Promise<Kysely<TestDatabase>> {
  const testDb = new Kysely<TestDatabase>({
    dialect: new NodeSqliteKyselyDialect({
      database: new DatabaseSync(":memory:"),
    }),
  });
  await createPersonTable(testDb);
  await testDb.insertInto("person").values({ name: "Ada" }).execute();
  return testDb;
}

// Mimics a node:sqlite build without StatementSync.columns() by hiding that
// method on every prepared statement while leaving the rest of the native API
// (bound to the real handle) intact.
function withoutStatementColumns(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (statementSql: string) => {
          const statement = target.prepare(statementSql);
          return new Proxy(statement, {
            get(stmt, key) {
              if (key === "columns") {
                return undefined;
              }
              const value = stmt[key as keyof typeof stmt];
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function createPersonTable(testDb: Kysely<TestDatabase>): Promise<void> {
  await testDb.schema
    .createTable("person")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull())
    .execute();
}
