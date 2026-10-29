import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOST = "127.0.0.1";
const DEFAULT_ARTIFACT_ROOT = join(tmpdir(), "healthagents-postgres-fixtures");

export interface PostgresFixtureIdentity {
  readonly fixtureId: string;
  readonly systemIdentifier: string;
  readonly serverPid: number;
  readonly host: typeof HOST;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly dataDirectory: string;
  readonly serverVersion: string;
  readonly startedAt: string;
}

export interface PostgresFailurePacket {
  readonly schemaVersion: "isolated-postgres-failure/v1";
  readonly fixture: string;
  readonly phase: string;
  readonly failure: { readonly name: string; readonly message: string };
  readonly identity: {
    readonly fixtureId: string;
    readonly systemIdentifier: string | null;
    readonly serverPid: number | null;
    readonly host: typeof HOST;
    readonly port: number | null;
    readonly database: string;
    readonly username: string;
    readonly dataDirectory: string;
    readonly serverVersion: string | null;
    readonly startedAt: string | null;
  };
  readonly connection: string;
  readonly processCleanup: "not_started" | "stopped" | "failed";
  readonly retained: { readonly rootDirectory: string; readonly postgresLog: string; readonly controlLog: string };
  readonly logTail: { readonly postgres: readonly string[]; readonly control: readonly string[] };
  readonly rerunCommand: string;
  readonly createdAt: string;
}

export type PostgresFixtureOutcome =
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly phase: string; readonly error: unknown };

export interface PostgresFixtureTeardownReceipt {
  readonly status: "removed" | "retained";
  readonly rootDirectory: string;
  readonly failurePacketPath: string | null;
}

export interface IsolatedPostgresFixture {
  readonly databaseURL: string;
  readonly identity: PostgresFixtureIdentity;
  readonly paths: { readonly rootDirectory: string; readonly postgresLog: string; readonly controlLog: string };
  close(outcome: PostgresFixtureOutcome): Promise<PostgresFixtureTeardownReceipt>;
}

export class IsolatedPostgresFixtureError extends Error {
  constructor(message: string, readonly packet: PostgresFailurePacket, readonly packetPath: string) {
    super(`${message}; failure_packet=${packetPath}`);
    this.name = "IsolatedPostgresFixtureError";
  }
}

export async function createIsolatedPostgresFixture(options: {
  readonly name: string;
  readonly rerunCommand: string;
  readonly artifactRoot?: string;
  readonly initializeDatabase?: (databaseURL: string) => Promise<unknown>;
}): Promise<IsolatedPostgresFixture> {
  const name = fixtureName(options.name);
  const fixtureId = randomBytes(10).toString("hex");
  const username = `fixture_${randomBytes(8).toString("hex")}`;
  const database = `fixture_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  const artifactRoot = resolve(options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await chmod(artifactRoot, 0o700);
  const rootDirectory = await mkdtemp(join(artifactRoot, `${name}-`));
  await chmod(rootDirectory, 0o700);
  const dataDirectory = join(rootDirectory, "data");
  // PostgreSQL Unix socket paths are capped at 103 bytes on macOS.
  const socketDirectory = await mkdtemp(join("/tmp", "ha-pg-sock-"));
  await chmod(socketDirectory, 0o700);
  const passwordFile = join(rootDirectory, ".init-password");
  const postgresLog = join(rootDirectory, "postgres.log");
  const controlLog = join(rootDirectory, "control.log");
  const failurePacketPath = join(rootDirectory, "failure-packet.json");
  const secrets = [password];
  await writeFile(postgresLog, "", { mode: 0o600 });
  await writeFile(controlLog, "", { mode: 0o600 });
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });

  let port: number | null = null;
  let started = false;
  let processCleanup: PostgresFailurePacket["processCleanup"] = "not_started";
  let identity: PostgresFixtureIdentity | null = null;
  let databaseURL: string | null = null;
  let startupPhase = "filesystem";
  let closePromise: Promise<PostgresFixtureTeardownReceipt> | null = null;
  const commandEnvironment = { ...process.env, PGPASSWORD: password, PGPASSFILE: "/dev/null", PGCONNECT_TIMEOUT: "5" };

  const captured = async (command: string, args: readonly string[], label: string): Promise<string> => {
    await appendSafe(controlLog, `[${new Date().toISOString()}] ${label}\n`, secrets);
    try {
      const result = await execFileAsync(command, args, { env: commandEnvironment, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      await appendSafe(controlLog, `${result.stdout}${result.stderr}`, secrets);
      return result.stdout;
    } catch (error) {
      const value = error as Error & { stdout?: string; stderr?: string };
      await appendSafe(controlLog, `${value.stdout ?? ""}${value.stderr ?? ""}${value.message}\n`, secrets);
      throw error;
    }
  };

  const stop = async (): Promise<void> => {
    if (!started) return;
    try {
      await captured("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "-t", "15", "stop"], "postgres.stop");
      started = false;
      processCleanup = "stopped";
    } catch (fastError) {
      try {
        await captured("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "-w", "-t", "15", "stop"], "postgres.stop_immediate");
        started = false;
        processCleanup = "stopped";
      } catch (immediateError) {
        processCleanup = "failed";
        throw new Error(`fast=${safeError(fastError, secrets).message}; immediate=${safeError(immediateError, secrets).message}`);
      }
    }
  };

  const packet = async (phase: string, error: unknown): Promise<PostgresFailurePacket> => {
    await sanitizeRetainedArtifacts(postgresLog, controlLog, secrets);
    const postgresTail = await safeTail(postgresLog, secrets);
    const controlTail = await safeTail(controlLog, secrets);
    const safeFailure = safeError(error, secrets);
    const value: PostgresFailurePacket = {
      schemaVersion: "isolated-postgres-failure/v1",
      fixture: name,
      phase,
      failure: safeFailure,
      identity: {
        fixtureId,
        systemIdentifier: identity?.systemIdentifier ?? null,
        serverPid: identity?.serverPid ?? null,
        host: HOST,
        port,
        database,
        username,
        dataDirectory,
        serverVersion: identity?.serverVersion ?? null,
        startedAt: identity?.startedAt ?? null,
      },
      connection: `postgresql://${username}:[REDACTED]@${HOST}:${port ?? "unknown"}/${database}`,
      processCleanup,
      retained: { rootDirectory, postgresLog, controlLog },
      logTail: { postgres: postgresTail, control: controlTail },
      rerunCommand: sanitize(options.rerunCommand, secrets),
      createdAt: new Date().toISOString(),
    };
    await writeFile(failurePacketPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(failurePacketPath, 0o600);
    return value;
  };

  try {
    startupPhase = "initdb";
    await captured("initdb", ["-D", dataDirectory, "--username", username, "--pwfile", passwordFile,
      "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--encoding=UTF8", "--no-locale", "--no-sync"], "postgres.initdb");
    await rm(passwordFile, { force: true });
    startupPhase = "start";
    port = await reserveLoopbackPort();
    await captured("pg_ctl", ["-D", dataDirectory, "-l", postgresLog, "-o",
      `-F -h ${HOST} -p ${port} -k ${socketDirectory} -c password_encryption=scram-sha-256 -c log_statement=none -c log_min_error_statement=panic -c log_error_verbosity=terse`, "-w", "-t", "15", "start"], "postgres.start");
    started = true;
    startupPhase = "create_database";
    await captured("psql", connectionArgs(username, "postgres", port, ["--command", `CREATE DATABASE "${database}"`]), "postgres.create_database");
    startupPhase = "verify_identity";
    const rawIdentity = await captured("psql", connectionArgs(username, database, port, ["--tuples-only", "--no-align", "--quiet", "--command",
      "SELECT json_build_object('systemIdentifier',(pg_control_system()).system_identifier::text,'host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database(),'username',current_user,'dataDirectory',current_setting('data_directory'),'serverVersion',current_setting('server_version'),'startedAt',pg_postmaster_start_time())::text"]), "postgres.verify_identity");
    const verified = parseIdentity(rawIdentity);
    const serverPid = Number.parseInt((await readFile(join(dataDirectory, "postmaster.pid"), "utf8")).split("\n")[0] ?? "", 10);
    if (!Number.isSafeInteger(serverPid) || serverPid < 1) throw new Error("isolated_postgres_pid_invalid");
    identity = {
      fixtureId,
      systemIdentifier: verified.systemIdentifier,
      serverPid,
      host: HOST,
      port,
      database,
      username,
      dataDirectory,
      serverVersion: verified.serverVersion,
      startedAt: verified.startedAt,
    };
    if (verified.host !== HOST || verified.port !== port || verified.database !== database || verified.username !== username
      || resolve(verified.dataDirectory) !== resolve(dataDirectory)) throw new Error("isolated_postgres_identity_mismatch");
    databaseURL = databaseUrl(username, password, database, port);
    if (options.initializeDatabase !== undefined) {
      startupPhase = "initialize_database";
      await options.initializeDatabase(databaseURL);
    }
  } catch (error) {
    await rm(passwordFile, { force: true }).catch(() => undefined);
    const stopError = await stop().then(() => null, (value: unknown) => value);
    await rm(socketDirectory, { recursive: true, force: true }).catch(() => undefined);
    const failure = stopError === null ? error : new Error(`${safeError(error, secrets).message}; cleanup=${safeError(stopError, secrets).message}`);
    const value = await packet(startupPhase, failure);
    throw new IsolatedPostgresFixtureError("isolated_postgres_start_failed", value, failurePacketPath);
  }

  if (databaseURL === null) throw new Error("isolated_postgres_database_url_missing");
  return {
    databaseURL,
    identity,
    paths: { rootDirectory, postgresLog, controlLog },
    close(outcome) {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        const stopError = await stop().then(() => null, (value: unknown) => value);
        await rm(socketDirectory, { recursive: true, force: true }).catch(() => undefined);
        if (outcome.status === "failed" || stopError !== null) {
          const phase = stopError !== null ? "teardown" : outcome.status === "failed" ? outcome.phase : "teardown";
          const failure = stopError !== null ? stopError : outcome.status === "failed" ? outcome.error : new Error("isolated_postgres_teardown_failed");
          await packet(phase, failure);
          return { status: "retained", rootDirectory, failurePacketPath };
        }
        await rm(rootDirectory, { recursive: true, force: true });
        return { status: "removed", rootDirectory, failurePacketPath: null };
      })();
      return closePromise;
    },
  };
}

function connectionArgs(username: string, database: string, port: number, trailing: readonly string[]): string[] {
  return ["--no-psqlrc", "--no-password", "--set", "ON_ERROR_STOP=1", "--host", HOST, "--port", String(port), "--username", username, "--dbname", database, ...trailing];
}

function databaseUrl(username: string, password: string, database: string, port: number): string {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${HOST}:${port}/${encodeURIComponent(database)}`;
}

function fixtureName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (normalized.length < 3) throw new Error("isolated_postgres_fixture_name_invalid");
  return normalized;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => { server.off("error", reject); resolvePromise(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") { server.close(); throw new Error("isolated_postgres_port_reservation_failed"); }
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

function parseIdentity(value: string): {
  systemIdentifier: string; host: string; port: number; database: string; username: string;
  dataDirectory: string; serverVersion: string; startedAt: string;
} {
  const parsed = JSON.parse(value.trim()) as Record<string, unknown>;
  const text = (key: string) => { const field = parsed[key]; if (typeof field !== "string" || field.length === 0) throw new Error(`isolated_postgres_identity_${key}_invalid`); return field; };
  const port = parsed.port;
  if (!Number.isSafeInteger(port) || Number(port) < 1) throw new Error("isolated_postgres_identity_port_invalid");
  return { systemIdentifier: text("systemIdentifier"), host: text("host"), port: Number(port), database: text("database"), username: text("username"),
    dataDirectory: text("dataDirectory"), serverVersion: text("serverVersion"), startedAt: text("startedAt") };
}

async function appendSafe(path: string, value: string, secrets: readonly string[]): Promise<void> {
  if (value.length === 0) return;
  await appendFile(path, sanitize(value, secrets), { encoding: "utf8", mode: 0o600 });
}

async function safeTail(path: string, secrets: readonly string[]): Promise<readonly string[]> {
  const value = sanitize(await readFile(path, "utf8").catch(() => ""), secrets);
  return value.split("\n").filter(Boolean).slice(-80).map((line) => line.slice(0, 1000));
}

async function sanitizeRetainedArtifacts(postgresLog: string, controlLog: string, secrets: readonly string[]): Promise<void> {
  const postgres = await readFile(postgresLog, "utf8").catch(() => "");
  const control = await readFile(controlLog, "utf8").catch(() => "");
  // PostgreSQL error logs can contain the complete rejected statement and caller data.
  await writeFile(postgresLog, sanitizePostgresLog(postgres, secrets), { mode: 0o600 });
  await writeFile(controlLog, sanitize(control, secrets), { mode: 0o600 });
  await chmod(postgresLog, 0o600);
  await chmod(controlLog, 0o600);
}

function sanitizePostgresLog(value: string, secrets: readonly string[]): string {
  return sanitize(value, secrets).split("\n").map((line) => {
    if (line.length === 0) return line;
    const prefix = line.match(/^(?:\d{4}-\d{2}-\d{2}[^\[]*\[[^\]]+\]\s+)?(?:LOG|ERROR|FATAL|WARNING|PANIC|DETAIL|HINT|CONTEXT|STATEMENT):/);
    return `${prefix?.[0] ?? "postgres:"} [REDACTED]`;
  }).join("\n");
}

function safeError(error: unknown, secrets: readonly string[]): { name: string; message: string } {
  if (error instanceof Error) return { name: sanitize(error.name, secrets).slice(0, 120), message: sanitize(error.message, secrets).slice(0, 2000) };
  // Test runners can serialize exceptions into null-prototype objects; coercion
  // can itself throw and must never prevent retention of the failure packet.
  return { name: "Error", message: "non_error_failure_detail_withheld" };
}

function sanitize(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) if (secret.length > 0) output = output.replaceAll(secret, "[REDACTED]");
  return output
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/((?:password|authorization|cookie|token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b(?:select|insert|update|delete|with|create|alter|drop)\b[\s\S]*/gi, "[REDACTED SQL]")
    .replace(/\+?\d[\d(). -]{6,}\d/g, "[REDACTED]");
}
