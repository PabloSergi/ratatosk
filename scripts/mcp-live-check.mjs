/**
 * Drives the MCP server the way an agent would: open → look → try → paginate_probe → save,
 * then the consuming side, robots → fetch. Talks over real stdio to a real browser, so it is
 * kept out of `npm test` and run by hand:  node scripts/mcp-live-check.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const URL_UNDER_TEST = 'https://books.toscrape.com/catalogue/page-1.html';

const client = new Client({ name: 'live-check', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp/server.js'] }));

const json = (result) => JSON.parse(result.content[0].text);
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return json(result);
};

const { tools } = await client.listTools();
console.log('инструменты:', tools.map((t) => t.name).join(', '));

const opened = await call('open', { url: URL_UNDER_TEST });
console.log('open:', opened.title);

const sketch = await call('look');
const candidate = sketch.candidates[0];
console.log('look:', candidate.selector, '×' + candidate.count, '| поля:', candidate.fields.map((f) => f.role).join(','));

const fields = {
  title: { type: 'attr', selector: 'h3 a', attr: 'title' },
  url: { type: 'attr', selector: 'a', attr: 'href', absolute: true },
  price: { type: 'text', selector: 'p.price_color' },
};
const attempt = await call('try', { rows: candidate.selector, fields });
console.log('try:', attempt.rows, 'строк из', attempt.blocksSeen, 'блоков | предупреждений:', attempt.warnings.length);

const probe = await call('paginate_probe', { rows: candidate.selector, maxPages: 3 });
console.log('probe:', probe.note);

const saved = await call('save', {
  name: 'books', url: URL_UNDER_TEST, rows: candidate.selector, fields,
  pagination: probe.worked ? probe.pagination : { type: 'none' }, minRowsPerPage: 10,
});
console.log('save:', saved.saved, '| проверено строк:', saved.provenRows);

console.log('robots:', JSON.stringify(await call('robots')));

const data = await call('fetch', { name: 'books', maxPages: 2 });
console.log('fetch:', data.count, 'строк с', data.pages, 'страниц | первая:', JSON.stringify(data.rows[0]));

// И отказ должен быть внятным, а не «An error occurred».
const broken = await client.callTool({ name: 'fetch', arguments: { name: 'no-such-robot' } });
console.log('ошибка по делу:', broken.content[0].text.slice(0, 100));

await client.close();
