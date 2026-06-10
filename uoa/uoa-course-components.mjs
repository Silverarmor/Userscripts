#!/usr/bin/env node

const START_URL =
  "https://www.student.guest.auckland.ac.nz/psc/ps/EMPLOYEE/SA/c/UOA_COMMUNITY_ACCESS_FL.UOA_BRWSE_CTLG_FL.GBL?&languageCd=ENG";
const ORIGIN = "https://www.student.guest.auckland.ac.nz";
const DEFAULT_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const delayMs = Number(args.delay || 250);
const outCsv = args.out || "uoa-course-components.csv";
const outJson = args.json || "uoa-course-components.json";
const coursesCsv = args["courses-out"] || relatedCsvPath(outCsv, "courses");
const letters = args.letters ? args.letters.split(",").map((x) => x.trim()).filter(Boolean) : DEFAULT_LETTERS;
const onlySubjects = new Set((args.subjects || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
const maxSubjects = args["max-subjects"] ? Number(args["max-subjects"]) : Infinity;
const maxCourses = args["max-courses"] ? Number(args["max-courses"]) : Infinity;
const verbose = args.verbose !== "false";

const cookieJar = new Map();

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});

async function main() {
  log("Opening catalogue");
  const components = new Map();
  const coursesByCode = new Map();
  let visitedSubjects = 0;
  let visitedCourses = 0;
  let skippedCourses = 0;
  let stopRequested = false;
  let currentLetter = "";
  let currentSubject = "";
  let currentCourse = "";

  // Ctrl+C should preserve the partial CSV/JSON files.
  const stopHandler = () => {
    if (stopRequested) {
      console.error("\nSecond interrupt received; exiting now.");
      process.exit(130);
    }

    stopRequested = true;
    console.error("\nInterrupt requested. Finishing the current request, then writing partial outputs...");
  };

  const checkStop = () => {
    if (stopRequested) {
      throw new StopRequestedError();
    }
  };

  // Every flush rewrites all outputs so they remain usable mid-run.
  const flushOutputs = async (status) => {
    const componentRows = [...components.values()].sort((a, b) => a.code.localeCompare(b.code));
    const courseRows = [...coursesByCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    await writeOutputs(componentRows, courseRows, {
      visitedSubjects,
      visitedCourses,
      discoveredCourses: coursesByCode.size,
      skippedCourses,
      generatedAt: new Date().toISOString(),
      letters,
      status,
      currentLetter,
      currentSubject,
      currentCourse,
    });
  };

  process.on("SIGINT", stopHandler);

  try {
    for (const letter of letters) {
      checkStop();
      if (visitedSubjects >= maxSubjects) {
        break;
      }

      currentLetter = letter;
      log(`Loading subject index ${letter}`);
      const letterAction = `DERIVED_SSS_BCC_SSR_ALPHANUM_${letter}`;
      const { html: letterStartHtml, url: letterRefererUrl } = await getFollowingRedirects(START_URL);
      checkStop();
      const letterPage = await submitAction(letterStartHtml, letterAction, letterRefererUrl);
      checkStop();
      const subjects = parseSubjects(letterPage)
        .filter((subject) => onlySubjects.size === 0 || onlySubjects.has(subject.code));

      log(`Found ${subjects.length} subject(s) for ${letter}`);

      for (const subject of subjects) {
        checkStop();
        if (visitedSubjects >= maxSubjects) {
          break;
        }

        currentSubject = subject.code;
        currentCourse = "";
        visitedSubjects += 1;
        log(`Subject ${subject.code}: ${subject.name}`);
        await wait(delayMs);
        checkStop();

        // PeopleSoft form state goes stale after drilling into details, so each
        // subject starts from a fresh catalogue page and fresh letter page.
        const { html: subjectStartHtml, url: subjectRefererUrl } = await getFollowingRedirects(START_URL);
        checkStop();
        const freshLetterPage = await submitAction(subjectStartHtml, letterAction, subjectRefererUrl);
        checkStop();
        const subjectPage = await submitAction(freshLetterPage, subject.action, subjectRefererUrl);
        checkStop();
        const allCourses = parseCourses(subjectPage, subject.code);

        // Course rows are already present on the subject page; collecting them
        // here adds no extra requests.
        for (const course of allCourses) {
          coursesByCode.set(course.code, {
            code: course.code,
            title: course.title,
            subject: subject.code,
            subjectName: subject.name,
            number: course.number,
          });
        }

        await flushOutputs("running");

        const courses = allCourses.slice(0, maxCourses);
        log(`  ${courses.length} course(s)`);

        for (const course of courses) {
          checkStop();
          currentCourse = course.code;
          visitedCourses += 1;
          await wait(delayMs);
          checkStop();

          let coursePage;
          try {
            coursePage = await submitAction(subjectPage, course.action, subjectRefererUrl);
          } catch (error) {
            skippedCourses += 1;
            log(`  skip ${course.code}: failed to open course (${error.message})`);
            continue;
          }
          checkStop();

          const scheduleAction = findScheduleAction(coursePage);
          if (!scheduleAction) {
            skippedCourses += 1;
            log(`  skip ${course.code}: no schedule button`);
            continue;
          }

          let schedulePage;
          try {
            schedulePage = await submitAction(coursePage, scheduleAction, subjectRefererUrl);
          } catch (error) {
            skippedCourses += 1;
            log(`  skip ${course.code}: failed to open schedule (${error.message})`);
            continue;
          }
          checkStop();

          const term = parseScheduleTerm(schedulePage);
          const sections = parseSections(schedulePage);
          const newSections = firstByComponentCode(sections).filter((section) => !components.has(section.componentCode));

          if (newSections.length > 0) {
            log(`  ${course.code}: new ${newSections.map((x) => x.componentCode).join(", ")}`);
          }

          for (const section of newSections) {
            checkStop();
            await wait(delayMs);
            checkStop();

            let detailPage;
            try {
              detailPage = await submitAction(schedulePage, section.detailAction, subjectRefererUrl);
            } catch (error) {
              log(`    ${section.componentCode}: failed to open details (${error.message})`);
              continue;
            }
            checkStop();

            const componentName = parseComponentName(detailPage);
            if (!componentName) {
              log(`    ${section.componentCode}: could not read long name`);
              continue;
            }

            components.set(section.componentCode, {
              code: section.componentCode,
              name: componentName,
              firstCourse: course.code,
              firstCourseTitle: course.title,
              firstSection: section.section,
              subject: subject.code,
              subjectName: subject.name,
              term,
            });
            await flushOutputs("running");
          }
        }

        await flushOutputs("running");
      }
    }

    await flushOutputs("complete");
    log(`Done. Components: ${components.size}. Courses visited: ${visitedCourses}. Skipped: ${skippedCourses}.`);
    console.log(`Wrote ${outCsv}`);
    console.log(`Wrote ${outJson}`);
    console.log(`Wrote ${coursesCsv}`);
  } catch (error) {
    if (!(error instanceof StopRequestedError)) {
      throw error;
    }

    await flushOutputs("interrupted");
    console.error(`Partial outputs written after interrupt: ${outCsv}, ${outJson}, ${coursesCsv}`);
    process.exitCode = 130;
  } finally {
    process.off("SIGINT", stopHandler);
  }
}

class StopRequestedError extends Error {}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq >= 0) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        index += 1;
      } else {
        parsed[key] = "true";
      }
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node uoa/uoa-course-components.mjs [options]

Options:
  --out PATH             CSV output path. Default: uoa-course-components.csv
  --json PATH            JSON output path. Default: uoa-course-components.json
  --courses-out PATH     Course-list CSV path. Default: based on --out
  --letters A,B,C        Limit subject index letters. Default: A-Z,0-9
  --subjects ACADENG     Limit subject codes, comma-separated.
  --max-subjects N       Stop after N subjects.
  --max-courses N        Stop after N courses per subject.
  --delay MS             Delay between requests. Default: 250
  --verbose false        Suppress progress logs.
  --help                 Show this message.

Examples:
  node uoa/uoa-course-components.mjs --subjects ACADENG --letters A
  node uoa/uoa-course-components.mjs --out components.csv --json components.json
`);
}

function relatedCsvPath(path, suffix) {
  return /\.csv$/i.test(path) ? path.replace(/\.csv$/i, `.${suffix}.csv`) : `${path}.${suffix}.csv`;
}

async function getFollowingRedirects(url) {
  for (let index = 0; index < 10; index += 1) {
    const response = await http(url);
    if (!isRedirect(response)) {
      return { html: await response.text(), url };
    }

    url = new URL(response.headers.get("location"), url).href;
  }

  throw new Error("Too many redirects while opening catalogue");
}

async function submitAction(html, actionId, referer) {
  const form = parseForm(html);
  form.fields.set("ICAction", actionId);

  const response = await http(form.action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      referer,
    },
    body: form.fields,
  });

  if (isRedirect(response)) {
    const location = new URL(response.headers.get("location"), form.action).href;
    const redirected = await getFollowingRedirects(location);
    return redirected.html;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function http(url, options = {}) {
  const headers = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0",
    ...(options.headers || {}),
  };
  const cookies = cookieHeader();

  if (cookies) {
    headers.cookie = cookies;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });

  updateCookies(response);
  return response;
}

function updateCookies(response) {
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];

  for (const value of setCookies) {
    const parts = value.split(";").map((part) => part.trim());
    const eq = parts[0].indexOf("=");
    if (eq <= 0) {
      continue;
    }

    const name = parts[0].slice(0, eq);
    const cookieValue = parts[0].slice(eq + 1);
    const expires = parts.find((part) => /^expires=/i.test(part));
    const isExpired = expires && Date.parse(expires.slice(8)) < Date.now();

    // The entry page sends expired cleanup cookies; do not echo them back.
    if (cookieValue === "webroute_removed" || isExpired) {
      cookieJar.delete(name);
    } else {
      cookieJar.set(name, cookieValue);
    }
  }
}

function cookieHeader() {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function isRedirect(response) {
  return response.status >= 300 && response.status < 400 && response.headers.get("location");
}

function parseForm(html) {
  const form = html.match(/<form\b[\s\S]*?<\/form>/i)?.[0];
  if (!form) {
    throw new Error("No PeopleSoft form found");
  }

  const formAttrs = parseAttributes(form.match(/<form\b[^>]*>/i)[0]);
  const fields = new URLSearchParams();

  for (const match of form.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (!attrs.name) {
      continue;
    }

    const type = (attrs.type || "").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(match[0])) {
      continue;
    }

    fields.append(attrs.name, attrs.value || "");
  }

  return {
    action: formAttrs.action,
    fields,
  };
}

function parseSubjects(html) {
  const subjects = [];
  const seen = new Set();
  const re = /<a\b[^>]*id=['"](UOA_FLUID_WRK_BUTTON_FUNC\$\d+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(re)) {
    const text = stripHtml(match[2]);
    const subjectMatch = text.match(/^([A-Z0-9]+)\s+-\s+(.+)$/);
    if (!subjectMatch || seen.has(match[1])) {
      continue;
    }

    seen.add(match[1]);
    subjects.push({
      action: match[1],
      code: subjectMatch[1],
      name: subjectMatch[2],
    });
  }

  return subjects;
}

function parseCourses(html, subjectCode) {
  const byIndex = new Map();

  for (const match of html.matchAll(/<a\b[^>]*id=['"]CRSE_NBR\$(\d+)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const index = match[1];
    const number = stripHtml(match[2]);
    byIndex.set(index, {
      index,
      number,
      code: `${subjectCode} ${number}`,
      action: `CRSE_NBR$${index}`,
    });
  }

  for (const match of html.matchAll(/<a\b[^>]*id=['"]CRSE_TITLE\$(\d+)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const course = byIndex.get(match[1]);
    if (course) {
      course.title = stripHtml(match[2]);
    }
  }

  return [...byIndex.values()].filter((course) => course.number && course.title);
}

function findScheduleAction(html) {
  const match = html.match(/href="javascript:submitAction_win0\(document\.win0,'([^']+)'\);"[^>]*>\s*View Course Schedule\s*<\/a>/i);
  return match?.[1] || null;
}

function parseScheduleTerm(html) {
  const heading = stripHtml(html.match(/<h2\b[^>]*>[\s\S]*?classes for\s+([\s\S]*?)<\/h2>/i)?.[1] || "");
  if (heading) {
    return heading;
  }

  const selected = html.match(/<option\b[^>]*selected[^>]*>([\s\S]*?)<\/option>/i);
  return selected ? stripHtml(selected[1]) : "";
}

function parseSections(html) {
  const sections = [];
  const seen = new Set();
  const re = /id=['"]CLASS_SECTION\$(\d+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(re)) {
    const index = match[1];
    const section = stripHtml(match[2]);
    const codeMatch = section.match(/-([A-Z0-9]{2,6})(?:\s|\()/);

    if (!codeMatch) {
      continue;
    }

    // Details action indexes match CLASS_SECTION indexes on the schedule page.
    const detailAction = `UOA_DERIVED_SSS_DETAILS_PB$${index}`;
    if (!html.includes(`'${detailAction}'`) && !html.includes(`"${detailAction}"`)) {
      continue;
    }

    const key = `${section}|${detailAction}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sections.push({
      section,
      detailAction,
      componentCode: codeMatch[1],
    });
  }

  return sections;
}

function firstByComponentCode(sections) {
  const byCode = new Map();

  for (const section of sections) {
    if (!byCode.has(section.componentCode)) {
      byCode.set(section.componentCode, section);
    }
  }

  return [...byCode.values()];
}

function parseComponentName(html) {
  // Class detail pages expose text like "Tutorial Class 55864".
  const direct = html.match(/id=['"]DERIVED_SSR_FL_SSR_SESSION_TRAN['"][^>]*>([\s\S]*?)<\/span>/i);
  const text = direct ? stripHtml(direct[1]) : stripHtml(html);
  const directMatch = text.match(/^(.+?)\s+Class\s+\d+\b/i);
  if (directMatch) {
    return cleanComponentName(directMatch[1]);
  }

  const fallback = text.match(/\b(?:Open|Closed|Wait List)?\s*(?:Session\s+)?([A-Z][A-Za-z0-9 &/()-]+?)\s+Class\s+\d+\b/);
  return fallback ? cleanComponentName(fallback[1]) : "";
}

function cleanComponentName(value) {
  return value.replace(/\b(?:Open|Closed|Wait List|Session)\b/g, " ").replace(/\s+/g, " ").trim();
}

function parseAttributes(tag) {
  const attrs = {};
  tag.replace(/([\w:$-]+)\s*=\s*(['"])(.*?)\2/g, (_, name, _quote, value) => {
    attrs[name.toLowerCase()] = decodeHtml(value);
  });
  return attrs;
}

function stripHtml(html) {
  return decodeHtml(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

async function writeOutputs(rows, courseRows, meta) {
  const csv = [
    ["component_code", "component_name", "first_course", "first_course_title", "first_section", "subject", "subject_name", "term"].join(","),
    ...rows.map((row) =>
      [
        row.code,
        row.name,
        row.firstCourse,
        row.firstCourseTitle,
        row.firstSection,
        row.subject,
        row.subjectName,
        row.term,
      ].map(csvCell).join(",")
    ),
  ].join("\n");

  const courseCsv = [
    ["course_code", "course_title", "subject", "subject_name", "course_number"].join(","),
    ...courseRows.map((row) =>
      [
        row.code,
        row.title,
        row.subject,
        row.subjectName,
        row.number,
      ].map(csvCell).join(",")
    ),
  ].join("\n");

  await import("node:fs/promises").then(async (fs) => {
    await fs.writeFile(outCsv, `${csv}\n`, "utf8");
    await fs.writeFile(outJson, `${JSON.stringify({ meta, components: rows }, null, 2)}\n`, "utf8");
    await fs.writeFile(coursesCsv, `${courseCsv}\n`, "utf8");
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  if (verbose) {
    console.error(message);
  }
}
