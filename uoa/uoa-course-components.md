# UoA Course Components Scraper

`uoa-course-components.mjs` scrapes the public University of Auckland course catalogue and builds a small reference list of class component codes.

Script file: [uoa-course-components.mjs](uoa-course-components.mjs)

For example, schedule rows such as `L01C-LEC` and `T01C-TUT` produce component mappings like:

```csv
LEC,Lecture
TUT,Tutorial
```

## Outputs

By default, the script writes:

- `uoa-course-components.csv`: component code list with the first course/section where each component was found.
- `uoa-course-components.json`: the same component data plus run metadata.
- `uoa-course-components.courses.csv`: course code/title list gathered from subject pages.

If you pass custom output paths:

```powershell
node uoa-course-components.mjs --out components.csv --json components.json
```

the course list defaults to:

```text
components.courses.csv
```

You can override it with `--courses-out`.

## How It Works

The catalogue is a PeopleSoft page. The script does not use browser automation; it replays the same form postbacks the page uses:

1. Open the catalogue.
2. Open a letter index, such as `A`.
3. Open each subject, such as `ACADENG`.
4. Record all course codes and titles already visible on the subject page.
5. Open each course detail page.
6. Open the course schedule.
7. Read short component codes from schedule rows, such as `LEC`.
8. For unseen component codes, open the row details and read the long name, such as `Lecture`.

PeopleSoft form state becomes stale after drilling into course details, so each subject starts from a fresh catalogue page before crawling its courses.

## Interrupting

The scraper rewrites output files as it runs. Press `Ctrl+C` once to stop gracefully; it finishes the current web request, writes partial outputs, and exits. Press `Ctrl+C` twice to force exit.

## Useful Commands

Full run:

```powershell
node uoa-course-components.mjs --out components.csv --json components.json
```

Small test run:

```powershell
node uoa-course-components.mjs --subjects ACADENG --letters A
```

Show options:

```powershell
node uoa-course-components.mjs --help
```
