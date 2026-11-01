/**
 * A limit on how long something may take, after which it is treated as having failed.
 *
 * Every await in the worker trusts somebody else to answer: Postgres, Redis, Telegram, a browser in
 * another container. Each of them can stop answering without saying no, and an await on an answer
 * that never comes is not an error — it is nothing, for ever. Measured on a live queue: one batch of
 * fourteen scrapers stopped at a quarter to six in the morning, the container stayed up, and for four
 * hours nothing in any history said anything was wrong, because no run ever finished.
 *
 * So the work is raced against a clock. When the clock wins, the work is told to stop through its
 * signal — closing what it holds is its own business, since only it knows what that is — and the
 * caller gets an `Overdue` to write down like any other failure.
 */
export class Overdue extends Error {
  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`${what} did not finish in ${spoken(ms)} and was stopped`);
    this.name = 'Overdue';
  }
}

export async function withDeadline<T>(what: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const overdue = new Overdue(what, ms);
      stop.abort(overdue);
      reject(overdue);
    }, ms);
  });
  try {
    return await Promise.race([work(stop.signal), clock]);
  } finally {
    clearTimeout(timer);
  }
}

/** "30 min", "90 s": what a person reads on a card, not a number of milliseconds. */
export function spoken(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`;
  return `${ms} ms`;
}
