/**
 * A job board that exists only for the tests: two pages, ordinary markup, a link into each posting.
 *
 * Testing a scraper against real sites makes a suite that fails when somebody else deploys. This is
 * the opposite — a site that never changes, so a red test always means our code changed.
 */
import { createServer } from 'node:http';

// Ten postings, five to a page: enough for the engine to see a repeating block rather than a handful
// of unrelated elements, which is what a real list looks like anyway.
const CITIES = ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Bilbao', 'Malaga', 'Zaragoza', 'Murcia', 'Palma', 'Vigo'];
const JOBS = CITIES.map((city, index) => ({
  id: index + 1,
  title: `${['Dancer', 'Hostess', 'Model'][index % 3]} wanted in ${city}`,
  city,
  posted: `2026-08-${String(10 + index).padStart(2, '0')}`,
  teaser: `A well-known house in ${city} is looking for people to join its team this season. Flexible hours, accommodation offered, and the sort of conditions that do not need explaining twice.`,
  pay: `${1200 + index * 100} € / week`,
}));

const PER_PAGE = 5;

const page = (number) => {
  const slice = JOBS.slice((number - 1) * PER_PAGE, number * PER_PAGE);
  const cards = slice
    .map(
      (job) => `
      <article class="job">
        <h2 class="job-title"><a href="/jobs/${job.id}">${job.title}</a></h2>
        <p class="job-teaser">${job.teaser}</p>
        <span class="job-city">${job.city}</span>
        <time class="job-posted">${job.posted}</time>
      </article>`,
    )
    .join('');
  const next = number * PER_PAGE < JOBS.length ? `<a class="next" href="/?page=${number + 1}">next</a>` : '';
  return `<!doctype html><html><head><title>Jobs</title></head><body>
    <h1>Jobs</h1><div class="list">${cards}</div>${next}</body></html>`;
};

const posting = (id) => {
  const job = JOBS.find((entry) => String(entry.id) === id);
  if (!job) return undefined;
  // The pay lives here and nowhere else — the reason a robot has to walk into a row at all.
  return `<!doctype html><html><head><title>${job.title}</title></head><body>
    <h1>${job.title}</h1>
    <div class="pay">${job.pay}</div>
    <div class="city">${job.city}</div>
    <p class="text">${job.teaser}</p></body></html>`;
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const single = url.pathname.startsWith('/jobs/') ? posting(url.pathname.split('/')[2] ?? '') : undefined;
  const body = single ?? (url.pathname === '/' ? page(Number(url.searchParams.get('page') ?? 1) || 1) : undefined);

  if (!body) {
    response.writeHead(404).end('no such page');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
});

server.listen(Number(process.env.PORT ?? 5610), '127.0.0.1', () => console.log(`fixture site on ${process.env.PORT ?? 5610}`));
