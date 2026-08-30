/**
 * Drive this installation's own MCP server the way a client would — the same door an agent uses.
 *
 *   RATATOSK_TOKEN=<token> node scripts/mcp-do.mjs robots
 *   RATATOSK_TOKEN=<token> node scripts/mcp-do.mjs build <url> <name> "<what is wanted>"
 *   RATATOSK_TOKEN=<token> node scripts/mcp-do.mjs fetch <name> [maxPages]
 *   RATATOSK_TOKEN=<token> node scripts/mcp-do.mjs look <url>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [command, ...rest] = process.argv.slice(2);
if (!command) {
  console.error('usage: mcp-do.mjs robots | build <url> <name> "<want>" | fetch <name> [maxPages] | look <url>');
  process.exit(2);
}

const client = new Client({ name: 'mcp-do', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp/server.js'],
    env: { ...process.env },
  }),
);

/**
 * A build works a real site with a real browser and a model: minutes, not seconds. The default MCP
 * request timeout is a minute, which cuts it off mid-work — so this client waits properly.
 */
const CALL_TIMEOUT_MS = Number(process.env.RATATOSK_MCP_TIMEOUT ?? 900_000);

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

try {
  if (command === 'robots') {
    const robots = await call('robots');
    for (const robot of robots) console.log(`${robot.kind.padEnd(9)} ${robot.name.padEnd(20)} ${robot.fields.join(',')}`);
    console.log(`— ${robots.length} robots`);
  }

  if (command === 'look') {
    const [url] = rest;
    await call('open', { url });
    const sketch = await call('look');
    console.log(`title: ${sketch.title}`);
    console.log(`notes: ${sketch.notes.join('; ') || '—'}`);
    for (const candidate of sketch.candidates.slice(0, 4)) {
      console.log(`${String(candidate.count).padStart(4)} × ${candidate.selector.slice(0, 48).padEnd(50)} ${candidate.fields.map((f) => f.role).join(',')}`);
    }
    console.log(`pagination: ${JSON.stringify(sketch.pagination)}`);
  }

  if (command === 'build') {
    const [url, name, want] = rest;
    const built = await call('build', { url, name, want: want ?? 'the list on this page with every column that carries meaning' });
    console.log(`SAVED ${built.saved} — ${built.rows} rows, ${built.modelCalls} model calls`);
    console.log(`coverage: ${JSON.stringify(built.coverage)}`);
    console.log(`sample: ${JSON.stringify(built.sample).slice(0, 200)}`);
  }

  if (command === 'fetch') {
    const [name, maxPages] = rest;
    const data = await call('fetch', { name, ...(maxPages ? { maxPages: Number(maxPages) } : {}) });
    console.log(`${name}: ${data.status}, ${data.count} rows from ${data.pages} page(s)`);
    for (const row of data.rows.slice(0, 2)) console.log(`  ${JSON.stringify(row).slice(0, 190)}`);
  }
} catch (error) {
  console.error(`FAILED — ${error.message.slice(0, 400)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
