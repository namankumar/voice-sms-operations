import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";

export interface DatabaseMigration { readonly version:string; readonly checksum:string; readonly sql:string; }

export async function loadDatabaseMigrations(directory=new URL("../../../../db/migrations/",import.meta.url)):Promise<readonly DatabaseMigration[]> {
  const names=(await readdir(directory)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if(names.length===0) throw new Error("database_migrations_missing");
  const expected=names.map((_,index)=>String(index+1).padStart(4,"0"));
  if(names.some((name,index)=>!name.startsWith(`${expected[index]}_`))) throw new Error("database_migration_sequence_invalid");
  return Promise.all(names.map(async(version)=>{const sql=await readFile(new URL(version,directory),"utf8");return{version,sql,checksum:`sha256:${createHash("sha256").update(sql).digest("hex")}`};}));
}

/** Applies immutable migrations under a session advisory lock. */
export async function applyDatabaseMigrations(databaseUrl:string,migrations?:readonly DatabaseMigration[]):Promise<{applied:readonly string[];current:readonly string[]}> {
  if(!databaseUrl.startsWith("postgres://")&&!databaseUrl.startsWith("postgresql://")) throw new Error("database_url_invalid");
  const values=migrations??await loadDatabaseMigrations();
  const sql=postgres(databaseUrl,{max:1,connect_timeout:10,idle_timeout:5,connection:{application_name:"healthagents-migrator"}});
  const applied:string[]=[];
  try {
    await sql`SELECT pg_advisory_lock(hashtext('healthagents-schema-migrations'))`;
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    for(const migration of values){
      const prior=await sql<{checksum:string}[]>`SELECT checksum FROM schema_migrations WHERE version=${migration.version}`;
      if(prior[0]!==undefined){if(prior[0].checksum!==migration.checksum)throw new Error(`database_migration_checksum_mismatch:${migration.version}`);continue;}
      const body=unwrapTransaction(migration.sql,migration.version);
      await sql.begin(async tx=>{await tx.unsafe(body);await tx`INSERT INTO schema_migrations(version,checksum) VALUES (${migration.version},${migration.checksum})`;});
      applied.push(migration.version);
    }
    const current=(await sql<{version:string}[]>`SELECT version FROM schema_migrations ORDER BY version`).map(row=>row.version);
    const expected=new Set(values.map(value=>value.version));
    if(current.some(version=>!expected.has(version))) throw new Error("database_schema_ahead_of_runtime");
    return{applied,current};
  } finally { try{await sql`SELECT pg_advisory_unlock(hashtext('healthagents-schema-migrations'))`;}catch{/* connection closure releases the lock */}await sql.end({timeout:5}); }
}

function unwrapTransaction(value:string,version:string):string {
  const match=value.match(/^\s*BEGIN;([\s\S]*)COMMIT;\s*$/i);
  if(match?.[1]===undefined) throw new Error(`database_migration_transaction_wrapper_required:${version}`);
  return match[1];
}
