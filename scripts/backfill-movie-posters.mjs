import { readFile, writeFile } from 'node:fs/promises';

const moviesPath = new URL('../src/data/movies.json', import.meta.url);
const shouldWrite = process.argv.includes('--write');
const shouldVerify = process.argv.includes('--verify');
const reportArg = process.argv.find(argument => argument.startsWith('--report='));
const reportPath = reportArg ? reportArg.slice('--report='.length) : null;
const moviesByYear = JSON.parse(await readFile(moviesPath, 'utf8'));

const normalize = value => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘]/g, "'")
  .replace(/[–—]/g, '-')
  .replace(/[^a-z0-9]+/gi, ' ')
  .trim()
  .toLowerCase();

const overrides = new Map([
  // Ambiguous titles are pinned to an IMDb title ID after manual verification.
  ['The Mission', 'tt28097834'],
  ['Deep Cover', 'tt0104073'],
  ['The End of the Tour', 'tt3416742'],
  ['Se7en', 'tt0114369'],
  ['The Naked Gun', 'tt0095705'],
  ['Dune', 'tt1160419'],
  ['Donut King', 'tt10214496'],
  ['Mad Max 2', 'tt0082694'],
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function suggestionsFor(title) {
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(title)}.json`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'drewcoffman-site poster backfill' }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const payload = await response.json();
  return Array.isArray(payload.d) ? payload.d : [];
}

const results = [];

for (const [watchedYear, movies] of Object.entries(moviesByYear)) {
  for (const movie of movies) {
    if (movie.poster) {
      results.push({ status: 'existing', watchedYear, movie });
      continue;
    }

    const candidates = await suggestionsFor(movie.title);
    const normalizedTitle = normalize(movie.title);
    const exact = candidates.filter(candidate =>
      candidate.i?.imageUrl && normalize(candidate.l || '') === normalizedTitle
    );
    const overrideId = overrides.get(movie.title);
    let selected = null;
    if (overrideId) {
      const overrideCandidates = await suggestionsFor(overrideId);
      selected = overrideCandidates.find(candidate => candidate.id === overrideId && candidate.i?.imageUrl);
    }

    if (!selected && movie.year) {
      selected = exact.find(candidate => candidate.y === movie.year);
    }
    if (!selected && !movie.year) {
      selected = exact.find(candidate => candidate.q === 'feature') || (exact.length === 1 ? exact[0] : null);
    }

    if (selected) {
      movie.poster = selected.i.imageUrl;
      results.push({ status: 'matched', watchedYear, movie, selected });
    } else {
      results.push({ status: exact.length > 1 ? 'ambiguous' : 'unresolved', watchedYear, movie, candidates: exact });
    }

    await sleep(35);
  }
}

const unresolved = results.filter(result => result.status === 'unresolved' || result.status === 'ambiguous');
const matched = results.filter(result => result.status === 'matched');
const existing = results.filter(result => result.status === 'existing');

const report = {
  total: results.length,
  existing: existing.length,
  matched: matched.length,
  unresolved: unresolved.map(result => ({
    watchedYear: result.watchedYear,
    title: result.movie.title,
    releaseYear: result.movie.year || null,
    status: result.status,
    candidates: result.candidates.map(candidate => ({
      id: candidate.id,
      title: candidate.l,
      year: candidate.y || null,
      type: candidate.q || null
    }))
  }))
};

console.log(JSON.stringify(report, null, 2));

if (reportPath) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (shouldWrite) {
  if (unresolved.length) {
    throw new Error(`Refusing to write with ${unresolved.length} unresolved poster${unresolved.length === 1 ? '' : 's'}.`);
  }
  await writeFile(moviesPath, `${JSON.stringify(moviesByYear, null, 2)}\n`);
}

if (shouldVerify) {
  const moviesWithPosters = Object.entries(moviesByYear).flatMap(([watchedYear, movies]) =>
    movies.map(movie => ({ watchedYear, movie })).filter(({ movie }) => movie.poster)
  );
  const failures = [];
  let nextIndex = 0;

  async function verifyNext() {
    while (nextIndex < moviesWithPosters.length) {
      const { watchedYear, movie } = moviesWithPosters[nextIndex++];
      try {
        const response = await fetch(movie.poster, { method: 'HEAD' });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.startsWith('image/')) {
          failures.push({ watchedYear, title: movie.title, status: response.status, contentType, url: movie.poster });
        }
      } catch (error) {
        failures.push({ watchedYear, title: movie.title, error: error.message, url: movie.poster });
      }
    }
  }

  await Promise.all(Array.from({ length: 8 }, () => verifyNext()));
  console.log(JSON.stringify({ verified: moviesWithPosters.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}
