import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const shouldWrite = process.argv.includes('--write');
const shouldVerify = process.argv.includes('--verify');
const shouldRefresh = process.argv.includes('--refresh');
const booksPath = new URL('../src/data/books.json', import.meta.url);
const outputDirectory = new URL('../src/images/book-covers/remote/', import.meta.url);
const booksByYear = JSON.parse(await readFile(booksPath, 'utf8'));
const books = Object.values(booksByYear).flat();
const sourceOverrides = new Map([
  ['9780525522386', 'https://images4.penguinrandomhouse.com/cover/9780525522409'],
  ['1495345017', 'https://richardbach.com/wp-content/uploads/2023/02/3769BA7D-C899-4F8F-A33A-26407E816813.jpeg'],
  ['9781006610196', 'https://subatomik.co/cdn/shop/files/Politigram_513e4cf3-dbfd-42d6-a135-7801225fe3bd.png?v=1730476429'],
  ['9781787634107', 'https://cdn.penguin.co.uk/dam-assets/books/9781787634107/9781787634107-jacket-large.jpg'],
  ['1943499845', 'https://davidkushner.com/wp-content/uploads/2016/02/prepare-to-meet.jpg'],
  ['0670141127', 'https://i0.wp.com/www.nationalbook.org/wp-content/uploads/2015/10/cover-of-Augustus-by-John-Williams.jpg?ssl=1&w=640']
]);
const placeholderHashes = new Set([
  '37cc230c16fdad5610c553d0cd3f4ba25e72b179'
]);

const slugify = value => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/gi, '-')
  .replace(/^-|-$/g, '')
  .toLowerCase();

const decodeXml = value => value
  .replaceAll('&amp;', '&')
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'");

function isbn13(value) {
  const isbn = String(value).replace(/[^0-9X]/gi, '');
  if (/^\d{13}$/.test(isbn)) return isbn;
  if (!/^\d{9}[0-9X]$/i.test(isbn)) return null;
  const base = `978${isbn.slice(0, 9)}`;
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function booksenseCover(value) {
  const isbn = isbn13(value);
  if (!isbn) return null;
  return `https://images.booksense.com/images/${isbn.slice(-3)}/${isbn.slice(-6, -3)}/${isbn}.jpg`;
}

async function isPlaceholder(filePath) {
  try {
    const bytes = await readFile(filePath);
    return placeholderHashes.has(createHash('sha1').update(bytes).digest('hex'));
  } catch {
    return false;
  }
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36',
          ...options.headers
        },
        signal: AbortSignal.timeout(20_000)
      });
      if (response.ok) return response;
      throw new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function googleBooksCover(query) {
  const feedUrl = `https://books.google.com/books/feeds/volumes?q=${encodeURIComponent(query)}`;
  const response = await fetchWithRetry(feedUrl);
  const xml = await response.text();
  const thumbnail = xml.match(/rel=['"]http:\/\/schemas\.google\.com\/books\/2008\/thumbnail['"][^>]*href=['"]([^'"]+)['"]/i)?.[1];
  if (!thumbnail) throw new Error('Google Books returned no cover');

  const coverUrl = new URL(decodeXml(thumbnail).replace(/^http:/, 'https:'));
  coverUrl.searchParams.set('zoom', '2');
  coverUrl.searchParams.set('w', '640');
  return coverUrl.href;
}

async function sourcesFor(book) {
  if (book.cover?.startsWith('http')) return [book.cover];

  const queries = [];
  if (book.isbn) queries.push(`isbn:${book.isbn}`);
  queries.push(`"${book.title}" "${book.author}"`);
  const sources = sourceOverrides.has(String(book.isbn)) ? [sourceOverrides.get(String(book.isbn))] : [];
  const deterministicCover = booksenseCover(book.isbn);
  if (deterministicCover && !sources.includes(deterministicCover)) sources.push(deterministicCover);
  const errors = [];

  for (const query of queries) {
    try {
      const source = await googleBooksCover(query);
      if (!sources.includes(source)) sources.push(source);
    } catch (error) {
      errors.push(`${query}: ${error.message}`);
    }
  }

  if (!sources.length) throw new Error(errors.join('; '));
  return sources;
}

async function localize(book, temporaryDirectory) {
  const identifier = book.isbn ? String(book.isbn) : 'cover';
  const outputName = `${slugify(book.title)}-${identifier}.jpg`;
  const outputPath = fileURLToPath(new URL(outputName, outputDirectory));
  const temporaryPath = `${temporaryDirectory}/${outputName}.source`;
  const temporaryOutputPath = `${temporaryDirectory}/${outputName}.optimized.jpg`;
  const output = `images/book-covers/remote/${outputName}`;

  if (shouldWrite && !shouldRefresh) {
    try {
      await access(outputPath);
      if (!(await isPlaceholder(outputPath))) return { book, source: 'cached', output };
      await rm(outputPath, { force: true });
    } catch {}
  }

  const sources = await sourcesFor(book);
  const errors = [];

  for (const source of sources) {
    try {
      const response = await fetchWithRetry(source, { headers: { Referer: 'https://books.google.com/' } });
      const contentType = response.headers.get('content-type') || '';
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!contentType.startsWith('image/') || bytes.length < 1_000) {
        throw new Error(`Invalid image response (${contentType || 'unknown type'}, ${bytes.length} bytes)`);
      }

      if (shouldWrite) {
        await writeFile(temporaryPath, bytes);
        await run('/usr/bin/sips', [
          '-Z', '640',
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', '72',
          temporaryPath,
          '--out', temporaryOutputPath
        ]);
        if (await isPlaceholder(temporaryOutputPath)) {
          throw new Error('Cover source returned a placeholder image');
        }
        await rename(temporaryOutputPath, outputPath);
      }

      return { book, source, output };
    } catch (error) {
      errors.push(error.message);
    }
  }

  try {
    await access(outputPath);
    if (!(await isPlaceholder(outputPath))) return { book, source: 'existing fallback', output };
  } catch {}

  throw new Error(errors.join('; '));
}

const pending = [];
for (const book of books) {
  if (shouldRefresh && book.isbn && book.cover?.startsWith('images/book-covers/remote/')) {
    pending.push(book);
    continue;
  }
  if (!book.cover?.startsWith('images/')) {
    pending.push(book);
    continue;
  }
  if (book.cover.startsWith('images/book-covers/remote/')) {
    const filePath = fileURLToPath(new URL(`../src/${book.cover}`, import.meta.url));
    try {
      await access(filePath);
      if (await isPlaceholder(filePath)) pending.push(book);
    } catch {
      pending.push(book);
    }
  }
}
const temporaryDirectory = await mkdtemp(`${tmpdir()}/drew-book-covers-`);
const results = [];
let nextIndex = 0;

async function worker() {
  while (nextIndex < pending.length) {
    const book = pending[nextIndex++];
    try {
      results.push({ status: 'localized', ...(await localize(book, temporaryDirectory)) });
    } catch (error) {
      results.push({ status: 'failed', book, error: error.message });
    }
  }
}

try {
  if (shouldWrite) await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Array.from({ length: 6 }, () => worker()));

  const failures = results.filter(result => result.status === 'failed');
  console.log(JSON.stringify({
    totalBooks: books.length,
    alreadyLocal: books.length - pending.length,
    localized: results.length - failures.length,
    failures: failures.map(({ book, error }) => ({ title: book.title, isbn: book.isbn || null, error }))
  }, null, 2));

  if (failures.length) throw new Error(`Could not localize ${failures.length} cover${failures.length === 1 ? '' : 's'}`);

  if (shouldWrite) {
    for (const result of results) result.book.cover = result.output;
    await writeFile(booksPath, `${JSON.stringify(booksByYear, null, 2)}\n`);
  }

  if (shouldVerify) {
    const localCovers = books.filter(book => book.cover?.startsWith('images/'));
    const sizes = await Promise.all(localCovers.map(async book => {
      const file = await stat(fileURLToPath(new URL(`../src/${book.cover}`, import.meta.url)));
      return { title: book.title, cover: book.cover, bytes: file.size };
    }));
    const failures = sizes.filter(cover => cover.bytes > 500_000);
    const totalBytes = sizes.reduce((sum, cover) => sum + cover.bytes, 0);
    console.log(JSON.stringify({
      verified: sizes.length,
      totalMegabytes: Number((totalBytes / 1_000_000).toFixed(2)),
      largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
      failures
    }, null, 2));
    if (failures.length) process.exitCode = 1;
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
