import { InputError } from './errors.js';

/**
 * Which product a scraper works for.
 *
 * One account ends up holding the scrapers of several unrelated things — rentals in one city, job boards
 * for another business — and a list of two hundred names is not a way to look after either. A project is
 * a word in the scraper's own file, nothing more: the file is not moved and the name is not changed,
 * because history, memory and results are all filed under the name and must keep finding it.
 *
 * Every new scraper belongs to one. A scraper with no project is somebody's work that nobody can find
 * again; the ones made before projects existed are shown apart until they are given one.
 */
const SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A project as it arrives from a person or a machine: lower-cased, trimmed, checked. */
export function projectName(value: unknown): string {
  const name = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!name) throw new InputError('a scraper belongs to a project — say which one');
  if (!SHAPE.test(name)) {
    throw new InputError(`"${name}" cannot be a project: letters, digits and dashes, forty at most`);
  }
  return name;
}

/** The project a robot says it belongs to, if it says. */
export function projectOf(robot: unknown): string | undefined {
  const project = (robot as { project?: unknown } | undefined)?.project;
  return typeof project === 'string' && project ? project : undefined;
}

/**
 * Projects with how many scrapers each has, in the order a list is read: the biggest first, and the
 * scrapers that still have none at the end, where they ask to be sorted out rather than hide in the middle.
 */
export function projectsOf(robots: Array<{ project?: string }>): Array<{ project: string; count: number }> {
  const counts = new Map<string, number>();
  for (const robot of robots) counts.set(robot.project ?? '', (counts.get(robot.project ?? '') ?? 0) + 1);
  return [...counts]
    .map(([project, count]) => ({ project, count }))
    .sort((one, other) =>
      !one.project ? 1 : !other.project ? -1 : other.count - one.count || one.project.localeCompare(other.project),
    );
}
