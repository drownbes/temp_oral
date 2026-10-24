// Dev-only stand-in for the production log agent: reads a process's output on stdin,
// pretty-prints it for the terminal and ships every line to local VictoriaLogs, tagged with
// the process-compose process name.
//   exec pnpm dev:api > >(node scripts/dev/ship-logs.ts api) 2>&1
// JSON lines are shipped as they are, with the time/msg aliases other tools use renamed;
// any other line (Postgres, versitygw, stack traces) becomes a plain message.
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { prettyFactory } from 'pino-pretty';

const processName = process.argv[2] ?? 'unknown';
const endpoint =
  process.env.VICTORIALOGS_URL ??
  'http://127.0.0.1:9428/insert/jsonline?_stream_fields=process&_msg_field=msg&_time_field=time';
/** Lines held while VictoriaLogs is unreachable (e.g. still starting); the oldest go first. */
const MAX_BUFFERED_LINES = 10_000;
/** Field names Tempo, Grafana and VictoriaLogs use for what pino calls time and msg. */
const FIELD_ALIASES = [
  ['time', ['ts', 't', 'timestamp']],
  ['msg', ['message']],
] as const;

const pretty = prettyFactory({
  colorize: true,
  singleLine: true,
  ignore: 'pid,hostname,service,env,process',
});

let buffer: string[] = [];
let reachable = true;
let sending: Promise<void> = Promise.resolve();

function toRecord(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalise(record: Record<string, unknown>): Record<string, unknown> {
  for (const [field, aliases] of FIELD_ALIASES) {
    if (field in record) continue;
    const alias = aliases.find((name) => name in record);
    if (alias === undefined) continue;
    record[field] = record[alias];
    delete record[alias];
  }
  record.time ??= new Date().toISOString();
  if (typeof record.level === 'string') record.level = record.level.toLowerCase();
  record.process = processName;
  return record;
}

function setReachable(value: boolean, reason?: string): void {
  if (value === reachable) return;
  reachable = value;
  process.stderr.write(
    value
      ? 'ship-logs: VictoriaLogs reachable again\n'
      : `ship-logs: VictoriaLogs unreachable (${reason}), buffering\n`,
  );
}

async function send(): Promise<void> {
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: `${lines.join('\n')}\n`,
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 500) throw new Error(`status ${res.status}`);
    setReachable(true);
    // a 4xx will not get better on retry
    if (!res.ok) process.stderr.write(`ship-logs: VictoriaLogs rejected a batch: ${res.status}\n`);
  } catch (err) {
    setReachable(false, (err as Error).message);
    buffer = [...lines, ...buffer].slice(-MAX_BUFFERED_LINES);
  }
}

/**
 * Sends run one at a time so lines reach VictoriaLogs in order. Reading stdin never waits on
 * a send: a producer blocked on a full pipe would stall Postgres or Temporal.
 */
function flush(): Promise<void> {
  sending = sending.then(send);
  return sending;
}

// process-compose signals the whole process group on shutdown; keep shipping until the
// producer closes its output so its last lines are not lost.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

const timer = setInterval(flush, 1000);

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue;
  const record = toRecord(line);
  if (record) {
    normalise(record);
    process.stdout.write(pretty(record));
  } else {
    process.stdout.write(`${line}\n`);
  }
  buffer.push(JSON.stringify(record ?? normalise({ msg: stripVTControlCharacters(line) })));
}

clearInterval(timer);
await flush();
