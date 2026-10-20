// Dev-only stand-in for the production log agent: reads JSON log lines on stdin,
// pretty-prints them for the terminal and ships the raw JSON to local VictoriaLogs.
//   pnpm dev:api | node scripts/dev/ship-logs.ts
import { createInterface } from 'node:readline';
import { prettyFactory } from 'pino-pretty';

const endpoint =
  process.env.VICTORIALOGS_URL ??
  'http://127.0.0.1:9428/insert/jsonline?_stream_fields=service,component&_msg_field=msg&_time_field=time';
const pretty = prettyFactory({
  colorize: true,
  singleLine: true,
  ignore: 'pid,hostname,service,env',
});

let batch: string[] = [];

async function flush(): Promise<void> {
  if (batch.length === 0) return;
  const body = `${batch.join('\n')}\n`;
  batch = [];
  try {
    const res = await fetch(endpoint, { method: 'POST', body });
    if (!res.ok) process.stderr.write(`ship-logs: VictoriaLogs responded ${res.status}\n`);
  } catch (err) {
    process.stderr.write(`ship-logs: ${(err as Error).message}\n`);
  }
}

const timer = setInterval(flush, 1000);

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.startsWith('{')) {
    process.stdout.write(`${line}\n`);
    continue;
  }
  try {
    process.stdout.write(pretty(JSON.parse(line)));
    batch.push(line);
  } catch {
    process.stdout.write(`${line}\n`);
  }
  if (batch.length >= 500) await flush();
}

clearInterval(timer);
await flush();
