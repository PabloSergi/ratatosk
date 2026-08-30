/**
 * The engine talks to a browser only through this interface.
 * Playwright and patchright adapters live in src/drivers/ and are the only files that know about them.
 */
export interface PageDriver {
  goto(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  /** Run a function inside the page and bring back a JSON-serialisable result. */
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  click(selector: string): Promise<void>;
  waitMs(ms: number): Promise<void>;
}
