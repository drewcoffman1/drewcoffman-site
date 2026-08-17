import { execFile } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const shouldWrite = process.argv.includes('--write');
const shouldVerify = process.argv.includes('--verify');
const booksPath = new URL('../src/data/books.json', import.meta.url);
const outputDirectory = new URL('../src/images/book-covers/', import.meta.url);
const booksByYear = JSON.parse(await readFile(booksPath, 'utf8'));
const changes = [];

async function sourceCoverFor(cover) {
  if (!cover.startsWith('images/book-covers/')) return cover;
  const name = basename(cover, extname(cover));
  for (const extension of ['.jpg', '.jpeg']) {
    const candidate = `images/${name}${extension}`;
    try {
      await access(fileURLToPath(new URL(`../src/${candidate}`, import.meta.url)));
      return candidate;
    } catch {}
  }
  throw new Error(`Original cover not found for ${cover}`);
}

for (const [readYear, books] of Object.entries(booksByYear)) {
  for (const book of books) {
    if (!book.cover?.startsWith('images/') || book.cover.startsWith('images/book-covers/remote/')) continue;

    const sourceCover = await sourceCoverFor(book.cover);
    const extension = extname(sourceCover);
    const outputName = `${basename(sourceCover, extension)}.jpg`;
    const outputCover = `images/book-covers/${outputName}`;
    changes.push({ readYear, title: book.title, source: sourceCover, output: outputCover });

    if (shouldWrite) {
      await mkdir(outputDirectory, { recursive: true });
      const sourcePath = fileURLToPath(new URL(`../src/${sourceCover}`, import.meta.url));
      const outputPath = fileURLToPath(new URL(outputName, outputDirectory));
      await run('/usr/bin/sips', [
        '-Z', '640',
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '72',
        sourcePath,
        '--out', outputPath
      ]);
      book.cover = outputCover;
    }
  }
}

console.log(JSON.stringify({ customCoversToOptimize: changes.length, changes }, null, 2));

if (shouldWrite) {
  await writeFile(booksPath, `${JSON.stringify(booksByYear, null, 2)}\n`);
}

if (shouldVerify) {
  const localCovers = Object.entries(booksByYear).flatMap(([readYear, books]) =>
    books
      .filter(book => book.cover?.startsWith('images/'))
      .map(book => ({ readYear, title: book.title, cover: book.cover }))
  );
  const sizes = [];

  for (const book of localCovers) {
    const filePath = fileURLToPath(new URL(`../src/${book.cover}`, import.meta.url));
    const file = await stat(filePath);
    sizes.push({ ...book, bytes: file.size });
  }

  const failures = sizes.filter(cover => cover.bytes > 500_000);
  const totalBytes = sizes.reduce((sum, cover) => sum + cover.bytes, 0);
  console.log(JSON.stringify({
    verified: sizes.length,
    totalBytes,
    totalMegabytes: Number((totalBytes / 1_000_000).toFixed(2)),
    largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    failures
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}
