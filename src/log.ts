/**
 * One line per thing that happened, as JSON.
 *
 * A scraping platform fails in ways nobody is watching: at four in the morning, on one site out of
 * fourteen, through a proxy that started refusing an hour ago. The interface tells whoever is looking
 * what a robot returned; this tells whoever comes later what the machine actually did — which request,
 * which robot, how long, and what went wrong.
 *
 * JSON because it is grepped by people and read by machines, one line because that survives every
 * pipe, and no dependency because a logger is not worth one.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Everything at this level and above is written. Default keeps the ordinary story and drops the noise. */
const threshold = RANK[(process.env['RATATOSK_LOG'] as Level) ?? 'info'] ?? RANK.info;

export function log(level: Level, event: string, detail?: Record<string, unknown>): void {
  if (RANK[level] < threshold) return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...detail });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const debug = (event: string, detail?: Record<string, unknown>): void => log('debug', event, detail);
export const info = (event: string, detail?: Record<string, unknown>): void => log('info', event, detail);
export const warn = (event: string, detail?: Record<string, unknown>): void => log('warn', event, detail);

/** Errors are logged with the message only: a stack in a log line is noise, and secrets hide in them. */
export function failure(event: string, error: unknown, detail?: Record<string, unknown>): void {
  const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
  log('error', event, { ...detail, why: message.slice(0, 300) });
}

/** How long something took, without every caller writing the same three lines. */
export async function timed<T>(event: string, detail: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const answer = await work();
    info(event, { ...detail, ms: Date.now() - started });
    return answer;
  } catch (error) {
    failure(event, error, { ...detail, ms: Date.now() - started });
    throw error;
  }
}
