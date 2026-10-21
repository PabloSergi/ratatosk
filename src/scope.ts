import { countUsers, robotsDirFor, telegramFileFor, verifyToken } from './auth.js';
import { projectName } from './projects.js';

/**
 * Whose robots am I looking at?
 *
 * The web view knows: whoever signed in. The MCP server has no login of its own — a client starts it
 * as a process — so it is told with a token the person copies out of the web view and puts in their
 * MCP config. One token, one account, the same isolation as everywhere else.
 *
 * With no accounts created at all, this is somebody's own machine and everything lives in the plain
 * robots directory. That is the single-user case and it stays simple.
 *
 * A project narrows it further: an agent working on one product sees that product's robots, and what it
 * saves lands there. `RATATOSK_PROJECT` beside the token in the MCP config is how it is told.
 */
export interface Scope {
  robotsDir: string;
  telegramSession?: string;
  /** Whose account this is, when there is one — the model key is looked up by it. */
  userId?: string;
  /** The one project this server works in, when it was given one. */
  project?: string;
  who: string;
}

export async function resolveScope(token?: string, project?: string): Promise<Scope> {
  const root = process.env['RATATOSK_ROBOTS'] ?? 'robots';
  const only = project ? { project: projectName(project) } : {};

  if (!token) {
    if ((await countUsers()) === 0) return { robotsDir: root, ...only, who: 'this machine' };
    throw new Error(
      'this installation has accounts, so a token is required: copy one from the web view and set RATATOSK_TOKEN',
    );
  }

  const user = await verifyToken(token);
  return {
    robotsDir: robotsDirFor(user.id),
    telegramSession: telegramFileFor(user.id),
    userId: user.id,
    ...only,
    who: user.email,
  };
}
