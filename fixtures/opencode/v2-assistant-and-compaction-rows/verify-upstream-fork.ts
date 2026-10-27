/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated adapter for dynamically extracted, hash-pinned upstream code; never part of the product build. */
// Run in a temporary package with effect@4.0.1, drizzle-orm@1.0.0-rc.5-169397b and the pinned projector.ts.
// Executes the unmodified upstream projectFork body with synthetic rows, real SQLite and a minimal Effect adapter.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const source = readFileSync(process.argv[2], "utf8");
assert.equal(
  createHash("sha256").update(source).digest("hex"),
  "c324ca65a6a6fc959757413e64e78906269ac119e8bbf81b50fa0cdc659536c2",
);
const start = source.indexOf("const projectFork = Effect.fn(");
const end = source.indexOf("\nfunction run(", start);
assert(start >= 0 && end > start);
const columns: Record<string, any> = {};
for (const name of [
  "id",
  "parent_id",
  "fork_session_id",
  "project_id",
  "workspace_id",
  "slug",
  "directory",
  "path",
  "title",
  "agent",
  "version",
])
  columns[name] = text(name);
for (const name of ["fork_boundary", "model", "metadata", "permission"])
  columns[name] = text(name, { mode: "json" });
for (const name of [
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "time_created",
  "time_updated",
])
  columns[name] = integer(name);
columns.cost = real("cost");
const SessionTable = sqliteTable("session_v2", columns);
const SessionMessageTable = sqliteTable("session_message", {
  id: text("id").primaryKey(),
  session_id: text("session_id"),
  type: text("type"),
  seq: integer("seq"),
  time_created: integer("time_created"),
  time_updated: integer("time_updated"),
  data: text("data", { mode: "json" }),
});
const raw = new Database(":memory:");
raw.exec(
  "CREATE TABLE session_v2(" +
    Object.keys(columns)
      .map(
        (n) =>
          `"${n}" ${n === "id" ? "TEXT PRIMARY KEY" : n.startsWith("tokens_") || n.startsWith("time_") ? "INTEGER" : n === "cost" ? "REAL" : "TEXT"}`,
      )
      .join(",") +
    ")",
);
raw.exec(
  "CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT)",
);
const sync = drizzle({ client: raw });
const { Effect } = await import("effect");
function wrap(q: any): any {
  return new Proxy(q, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: any[]) =>
        ["get", "all", "run"].includes(String(key))
          ? Effect.sync(() => value.apply(target, args))
          : wrap(value.apply(target, args));
    },
  });
}
const db = {
  select: (...args: any[]) => wrap((sync.select as any)(...args)),
  insert: (...args: any[]) => wrap((sync.insert as any)(...args)),
};
const shim = `import { and, asc, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
const SessionMessage={ID:Object.defineProperties(Object.create(Schema.String),{make:{value:(v:string)=>v},fromEvent:{value:(v:string)=>v.replace(/^evt_/,'msg_')}})};
const SessionAlreadyProjected=Error;
const ForkBatchSize=500;
const Slug={create:()=> 'synthetic-slug'};
const InstructionEntry={}; const InstructionState={};
const Bus={reserveSequence:()=>Effect.void};
const forkTitle=(value?:string)=>value;
let SessionTable:any,SessionMessageTable:any;
export function tables(s:any,m:any){SessionTable=s;SessionMessageTable=m;}
`;
const modulePath = new URL("./pinned-projector-extracted.ts", import.meta.url);
writeFileSync(
  modulePath,
  shim + source.slice(start, end) + "\nexport {projectFork};\n",
);
const { tables, projectFork } = await import(modulePath.href);
tables(SessionTable, SessionMessageTable);
sync
  .insert(SessionTable)
  .values({
    id: "ses_root",
    directory: "/synthetic/project",
    project_id: "synthetic-project",
    time_created: 0,
  })
  .run();
const message = (
  id: string,
  session: string,
  seq: number,
  type: string,
  input: number,
  output: number,
  reasoning = 0,
  read = 0,
  write = 0,
  completed = true,
) => ({
  id,
  session_id: session,
  type,
  seq,
  time_created: 1792746000000 + seq * 1000,
  time_updated: 1792746000000 + seq * 1000 + 100,
  data: {
    model: { id: "synthetic-model", providerID: "synthetic" },
    time: {
      created: 1792746000000 + seq * 1000,
      ...(completed ? { completed: 1792746000000 + seq * 1000 + 100 } : {}),
    },
    tokens: { input, output, reasoning, cache: { read, write } },
    ...(type === "compaction"
      ? { status: completed ? "completed" : "running" }
      : {}),
    content: "PRIVATE_RESPONSE_MARKER",
  },
});
sync
  .insert(SessionMessageTable)
  .values([
    message("msg_user", "ses_root", 1, "user", 0, 0),
    message("msg_original", "ses_root", 2, "assistant", 100, 10, 2, 3, 1),
    message("msg_pending", "ses_root", 3, "assistant", 4, 1, 0, 0, 0, false),
    message("msg_user4", "ses_root", 4, "user", 0, 0),
    message("msg_compact", "ses_root", 5, "compaction", 20, 2, 1),
    message("msg_running", "ses_root", 6, "compaction", 6, 1, 0, 0, 0, false),
  ])
  .run();
const fork = (
  event: string,
  session: string,
  parent: string,
  type: string,
  boundary: string,
) =>
  Effect.runPromise(
    projectFork(db, {
      id: event,
      created: 1792746020000,
      durable: { seq: 1 },
      data: {
        sessionID: session,
        parentID: parent,
        boundary: { type, messageID: boundary },
      },
    }),
  );
await fork("evt_forkb", "ses_before", "ses_root", "before", "msg_compact");
assert.deepEqual(
  raw
    .query(
      "SELECT seq FROM session_message WHERE session_id='ses_before' ORDER BY seq",
    )
    .all(),
  [{ seq: 1 }, { seq: 2 }, { seq: 4 }],
);
await fork("evt_through", "ses_through", "ses_root", "through", "msg_running");
assert.deepEqual(
  raw
    .query(
      "SELECT seq FROM session_message WHERE session_id='ses_through' ORDER BY seq",
    )
    .all(),
  [{ seq: 1 }, { seq: 2 }, { seq: 4 }, { seq: 5 }],
);
sync
  .insert(SessionMessageTable)
  .values(message("msg_newb", "ses_before", 6, "assistant", 30, 3, 1))
  .run();
await fork("evt_forkc", "ses_nested", "ses_before", "through", "msg_newb");
const projection = raw
  .query(
    "SELECT id,session_id,type,seq,json_extract(data,'$.tokens') AS tokens FROM session_message WHERE session_id IN ('ses_before','ses_nested') AND type IN ('assistant','compaction') ORDER BY session_id,seq",
  )
  .all()
  .map((row: any) => ({ ...row, tokens: JSON.parse(row.tokens) }));
assert.deepEqual(
  projection.map((r: any) => [r.id, r.session_id, r.seq]),
  [
    ["msg_forkb_2", "ses_before", 2],
    ["msg_newb", "ses_before", 6],
    ["msg_forkc_2", "ses_nested", 2],
    ["msg_forkc_6", "ses_nested", 6],
  ],
);
console.log(
  JSON.stringify(
    {
      commit: "f9f463be78312411618964a171c285c316d4b9fc",
      execution:
        "unmodified extracted projectFork; real SQLite; Effect query adapter; schema/ID/slug/title shims; synthetic sequence reservation; no instruction services invoked",
      checks: [
        "before excludes boundary",
        "through includes boundary",
        "incomplete assistant excluded",
        "running compaction excluded",
        "sequence gaps preserved",
        "nested copies preserve parent sequence",
      ],
      projection,
    },
    null,
    2,
  ),
);
