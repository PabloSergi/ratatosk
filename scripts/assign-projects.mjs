/**
 * Put an account's scrapers into projects, from the command line.
 *
 * For an installation that had scrapers before there were projects: two hundred of them are not sorted
 * out one card at a time. Rules are tried in order and the first that matches a name wins; a scraper
 * that already has a project keeps it, and one that matches nothing is left alone and listed.
 *
 *   node scripts/assign-projects.mjs <userId> vietrent='^(nhatot-|batdongsan-|fb-marketplace-rentals$)' adult-job='.*'
 *   node scripts/assign-projects.mjs <userId> … --write
 *
 * Without --write it only says what it would do — read that list before writing anything.
 */
import { robotsDirFor } from '../dist/auth.js';
import { listRobots, loadRobot, saveRobot } from '../dist/robots.js';
import { projectName } from '../dist/projects.js';

const args = process.argv.slice(2);
const userId = args.find((arg) => !arg.includes('=') && !arg.startsWith('--'));
const rules = args
  .filter((arg) => arg.includes('='))
  .map((arg) => {
    const at = arg.indexOf('=');
    return { project: projectName(arg.slice(0, at)), match: new RegExp(arg.slice(at + 1)) };
  });
const write = args.includes('--write');

if (!userId || rules.length === 0) {
  console.error('usage: assign-projects.mjs <userId> <project>=<name regex> … [--write]');
  process.exit(2);
}

const dir = robotsDirFor(userId);
const plan = new Map();
const kept = [];
const unmatched = [];

for (const robot of await listRobots(dir)) {
  if (robot.project) {
    kept.push(`${robot.name} (${robot.project})`);
    continue;
  }
  const rule = rules.find((one) => one.match.test(robot.name));
  if (!rule) {
    unmatched.push(robot.name);
    continue;
  }
  plan.set(rule.project, [...(plan.get(rule.project) ?? []), robot.name]);
}

for (const [project, names] of plan) {
  console.log(`${project} — ${names.length}:`);
  console.log(`  ${names.sort().join(', ')}`);
}
if (kept.length) console.log(`already in a project — ${kept.length}: ${kept.join(', ')}`);
if (unmatched.length) console.log(`matched no rule, left alone — ${unmatched.length}: ${unmatched.join(', ')}`);

if (!write) {
  console.log('\nnothing written — run again with --write');
  process.exit(0);
}

let moved = 0;
for (const [project, names] of plan) {
  for (const name of names) {
    const robot = await loadRobot(name, dir);
    await saveRobot({ ...robot, project }, dir);
    moved += 1;
  }
}
console.log(`\nwritten: ${moved} scraper(s)`);
