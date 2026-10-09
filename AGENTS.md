# Drew Coffman Site

This is Drew Coffman's personal website and reading/watching archive. It is an Eleventy site whose editable content lives primarily in `src/data/`.

## Content conventions

- Preserve Drew's supplied writing exactly unless he explicitly asks for revisions. Do not silently fix wording, punctuation, capitalization, or grammar.
- A `♡` beside a submitted title means it is a favorite. Store that using the same heart badge value as existing entries (`"❤"`). Otherwise follow the existing null/empty badge convention.
- Add new books and movies to the beginning of the current calendar year's array, while keeping the work's original publication or release year in its `year` field when that field is used.
- Match the surrounding JSON structure and formatting.

## Movies

- Movie entries live in `src/data/movies.json`.
- Include the correct release year.
- Use `scripts/backfill-movie-posters.mjs` to locate and optimize missing poster URLs.
- Visually verify that a selected poster belongs to the correct movie and edition before publishing; titles can be ambiguous.

## Books

- Book entries live in `src/data/books.json`.
- Include the correct author and ISBN where the existing format calls for them.
- Covers are stored locally under `src/images/book-covers/remote/` and managed by `scripts/localize-book-covers.mjs`.
- Visually verify each cover. If an automated source returns a placeholder, printer proof, interior page, or wrong edition, add a deterministic source override to the localization script and replace the local image.

## Homepage and other content

- Homepage biography lists are in `src/data/about.json`.
- Writing and essay data live in the other files under `src/data/`.
- Preserve established ordering, link behavior, and writing style unless Drew requests a change.

## Verification and Git

- Check `git status` before editing. Existing changes belong to Drew; do not alter, discard, or commit unrelated files.
- Validate edited JSON, run `git diff --check`, and run the Eleventy build with `npm run build` (or the installed Eleventy binary when appropriate).
- Use the relevant image verification script when adding or changing posters or covers.
- After a requested site update is verified, stage only the files for that update, commit with a concise message, and push `main` to `origin`, unless Drew asks for a different workflow.
