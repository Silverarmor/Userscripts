#!/usr/bin/env python3
"""
Canvas Grade Watcher (headless) — a server-side version of
canvas/canvas-grade-watcher.user.js, meant for a Raspberry Pi or any always-on box.

Polls the Canvas API using your browser's logged-in session cookie (UoA disables
personal access tokens; CANVAS_TOKEN still works on Canvas sites that allow them)
and pushes an urgent alert to your phone when a watched assignment:
  * gets marked in Canvas while still hidden   (planner submissions.graded -> true)
  * has its score posted / released             (submission score or posted_at appears)
  * gets feedback                               (planner has_feedback -> true)
  * moves the course Total                      (enrollments grades.current_score)

Alerts go to Pushover. Score released / feedback / total changed use emergency
priority (repeats until you tap Acknowledge). "Marked but still hidden" is high.
Login problems are high, and only sent when you need to do something.

Polling uses only the Python standard library (python3 >= 3.8). Automatic re-login
when the Canvas session expires uses a headless Chromium via Playwright (optional:
pip install playwright). See README.md.

Usage:
  canvas_grade_watcher.py --relogin       # headless browser login (what the service does itself)
  canvas_grade_watcher.py --browser-login # log in by hand in a visible browser window
  canvas_grade_watcher.py --set-cookie    # or paste a browser Cookie header
  canvas_grade_watcher.py                 # run forever (what systemd runs)
  canvas_grade_watcher.py --once          # single poll, then exit
  canvas_grade_watcher.py --list 142383   # list a course's assignments + IDs
  canvas_grade_watcher.py --test          # send an emergency test alert to Pushover
  canvas_grade_watcher.py --status        # print the current state of each watch
Config is read from env vars, or from the file given by --config
(default: ./watcher.env next to this script).
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- config

def load_env_file(path: Path) -> None:
    """Minimal KEY=VALUE loader; real env vars win over the file.

    Values are taken literally: no shell expansion, and # only starts a comment at the
    beginning of a line, so passwords like p@ss#w$rd!"x need no quoting. One matching
    pair of surrounding quotes is removed if present (use it to keep leading/trailing
    spaces); quotes anywhere else are kept.
    """
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        os.environ.setdefault(k.strip(), v)


def cfg(name, default=None):
    v = os.environ.get(name, "").strip()
    return v if v else default


def log(*a):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]", *a, flush=True)


# ---------------------------------------------------------------- canvas api

class AuthError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A logged-out API call may redirect to /login; treat that as an auth failure."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def parse_cookie_header(s: str) -> dict:
    out = {}
    for part in (s or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


class CookieStore:
    """Browser session cookies, persisted and updated from Set-Cookie.

    Canvas rotates its session cookie as you use it, so every response's
    Set-Cookie is saved back to disk. Polling every 15 s keeps the session alive.
    """
    def __init__(self, path: Path, seed: str = None):
        self.path = path
        self.cookies = {}
        try:
            self.cookies = json.loads(path.read_text())
        except Exception:
            pass
        if not self.cookies and seed:
            self.replace(seed)

        self._mtime = self._stat()

    def _stat(self):
        try:
            return self.path.stat().st_mtime_ns
        except OSError:
            return None

    def reload_if_changed(self) -> bool:
        """Pick up a --set-cookie run from another process while the service is running."""
        m = self._stat()
        if m is not None and m != self._mtime:
            try:
                self.cookies = json.loads(self.path.read_text())
                self._mtime = m
                return True
            except Exception:
                pass
        return False

    def replace(self, header: str):
        self.replace_dict(parse_cookie_header(header))

    def replace_dict(self, cookies: dict):
        self.cookies = dict(cookies)
        self.save()

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.cookies, indent=2))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        tmp.replace(self.path)
        self._mtime = self._stat()

    def header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def update_from(self, headers):
        changed = False
        for sc in headers.get_all("Set-Cookie") or []:
            first, *attrs = sc.split(";")
            if "=" not in first:
                continue
            name, value = (x.strip() for x in first.split("=", 1))
            attrs_l = ";".join(attrs).lower()
            expired = (not value or "max-age=0" in attrs_l.replace(" ", "")
                       or "expires=thu, 01 jan 1970" in attrs_l)
            if expired:
                changed |= self.cookies.pop(name, None) is not None
            elif self.cookies.get(name) != value:
                self.cookies[name] = value
                changed = True
        if changed:
            self.save()


class Canvas:
    def __init__(self, base_url: str, token: str = None, cookies: CookieStore = None):
        self.base = base_url.rstrip("/")
        self.token = token
        self.cookies = cookies

    def _request(self, url: str):
        headers = {"Accept": "application/json", "User-Agent": "canvas-grade-watcher/1.1"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self.cookies:
            headers["Cookie"] = self.cookies.header()
        req = urllib.request.Request(url, headers=headers)
        try:
            r = _opener.open(req, timeout=30)
        except urllib.error.HTTPError as e:
            if self.cookies:
                self.cookies.update_from(e.headers)
            if e.code in (301, 302, 303, 307, 308, 401, 403):
                raise AuthError(f"HTTP {e.code} for {url} — Canvas session expired / logged out?") from e
            raise
        with r:
            if self.cookies:
                self.cookies.update_from(r.headers)
            text = r.read().decode("utf-8")
            link = r.headers.get("Link", "")
        if text.startswith("while(1);"):
            text = text[len("while(1);"):]
        try:
            return json.loads(text), link
        except json.JSONDecodeError as e:
            # An HTML login page instead of JSON means the session is gone
            raise AuthError(f"Non-JSON response for {url} — probably the login page") from e

    def get(self, path: str, params=None):
        url = self.base + path
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
        return self._request(url)[0]

    def get_all(self, path: str, params=None):
        """Follow Link: rel=next pagination (used by --list only)."""
        out, params = [], dict(params or {}, per_page=100)
        url = self.base + path + "?" + urllib.parse.urlencode(params, doseq=True)
        while url:
            data, link = self._request(url)
            out.extend(data)
            url = None
            for part in link.split(","):
                if 'rel="next"' in part:
                    url = part[part.find("<") + 1:part.find(">")]
        return out


# ---------------------------------------------------------------- notifier (Pushover)

EMERGENCY, HIGH, NORMAL = 2, 1, 0


def notify(title: str, message: str, priority: int = EMERGENCY, click_url: str = None):
    """Send a Pushover alert. EMERGENCY repeats every PUSHOVER_RETRY seconds until
    you tap Acknowledge (or PUSHOVER_EXPIRE passes). Returns True on success."""
    log(f"ALERT (priority {priority}): {title} — {message}")
    token, user = cfg("PUSHOVER_TOKEN"), cfg("PUSHOVER_USER")
    if not (token and user):
        log("WARNING: PUSHOVER_TOKEN / PUSHOVER_USER not set — alert not sent")
        return False
    data = {"token": token, "user": user, "title": title[:250], "message": message[:1024],
            "priority": priority}
    if priority == EMERGENCY:
        data.update(retry=cfg("PUSHOVER_RETRY", "30"),      # seconds between repeats (min 30)
                    expire=cfg("PUSHOVER_EXPIRE", "300"),  # stop repeating after 5 min (Pushover max 3 h)
                    sound=cfg("PUSHOVER_SOUND", "persistent"))
    if click_url:
        data.update(url=click_url, url_title="Open grades")
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request("https://api.pushover.net/1/messages.json", data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30):
                return True
        except urllib.error.HTTPError as e:
            log("Pushover rejected the alert:", e.code, e.read().decode("utf-8", "replace")[:300])
            return False  # 4xx = bad token/user; retrying won't help
        except Exception as e:
            log(f"Pushover failed (attempt {attempt + 1}/3):", e)
            time.sleep(5)
    return False


# ---------------------------------------------------------------- headless browser login

class BrowserLoginError(Exception):
    pass


def playwright_available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except ImportError:
        return False


def _launch(p, headless: bool):
    """BROWSER_PATH > Playwright's bundled Chromium > system Chromium/Chrome."""
    import shutil
    args = ["--disable-blink-features=AutomationControlled"]
    if cfg("BROWSER_PATH"):
        return p.chromium.launch(executable_path=cfg("BROWSER_PATH"), headless=headless, args=args)
    try:
        return p.chromium.launch(headless=headless, args=args)
    except Exception as first:
        for exe in ("chromium", "chromium-browser", "google-chrome"):
            path = shutil.which(exe)
            if path:
                return p.chromium.launch(executable_path=path, headless=headless, args=args)
        try:
            return p.chromium.launch(channel="chrome", headless=headless, args=args)
        except Exception:
            raise first


def totp(secret: str, offset: int = 0, step: int = 30, digits: int = 6) -> str:
    """RFC 6238 code from a base32 authenticator secret (same as Google/Microsoft Authenticator)."""
    import base64, hashlib, hmac, struct
    secret = secret.replace(" ", "").upper()
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = int(time.time() // step) + offset
    h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return str((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


def _submit(field):
    """Submit the field's form the way a person would: click its Sign in button.

    UoA's Shibboleth forms need the button's name (_eventId_proceed) in the POST, and a
    form with no submit button ignores Enter, so Enter is only the fallback.
    """
    btn = field.locator("xpath=ancestor::form[1]").locator(
        "button[name=_eventId_proceed], button[type=submit], input[type=submit], button:not([type])")
    if btn.count():
        btn.first.click()
    else:
        field.press("Enter")


# Visible form fields on the current page: type/name/id/autocomplete only, never values.
_INPUTS_JS = """() => [...document.querySelectorAll('input,button,select')]
  .filter(e => e.offsetParent !== null && e.type !== 'hidden')
  .map(e => [e.tagName.toLowerCase(), e.type, e.name || e.id, e.autocomplete,
             (e.placeholder || e.innerText || '').trim().slice(0, 25)].filter(Boolean).join(':'))"""


def browser_login(base: str, store: CookieStore, interactive: bool = False) -> str:
    """Log in to Canvas in a real Chromium and copy its session into `store`.

    Order of attempts (headless):
      1. Saved browser profile (browser_state.json): if the UoA login server still
         remembers you, Canvas logs straight back in with no typing.
      2. UOA_USERNAME / UOA_PASSWORD from watcher.env, if set. If MFA is asked for,
         a Pushover alert tells you to approve it, and it waits MFA_WAIT_SECONDS.
    interactive=True opens a visible window and waits for you to log in by hand.
    Returns the Canvas user's name on success; raises BrowserLoginError otherwise.
    """
    from playwright.sync_api import sync_playwright

    state_path = Path(cfg("BROWSER_STATE_FILE", str(HERE / "browser_state.json")))
    host = urllib.parse.urlparse(base).hostname
    user, pw = cfg("UOA_USERNAME"), cfg("UOA_PASSWORD")
    wait_s = 600 if interactive else int(cfg("MFA_WAIT_SECONDS", "180"))

    with sync_playwright() as p:
        browser = _launch(p, headless=not interactive)
        try:
            ctx_args = {}
            if state_path.is_file():
                ctx_args["storage_state"] = str(state_path)
            if not interactive:
                # Headless Chromium announces itself as "HeadlessChrome"; look like normal Chrome.
                ua = ("Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) "
                      f"Chrome/{browser.version} Safari/537.36")
                ctx_args.update(user_agent=ua, viewport={"width": 1280, "height": 800})
            ctx = browser.new_context(**ctx_args)
            if store.cookies:  # newest Canvas cookies (they rotate while polling)
                ctx.add_cookies([{"name": k, "value": v, "domain": host, "path": "/",
                                  "secure": True, "httpOnly": True} for k, v in store.cookies.items()])
            page = ctx.new_page()
            log(f"browser: opening {base} ({'visible window' if interactive else 'headless'})")
            page.goto(base + "/", wait_until="domcontentloaded", timeout=60000)

            submitted_at = None
            mfa_alerted = False
            token_sent_at, tries = 0.0, 0
            deadline = time.time() + wait_s
            debug = interactive or cfg("BROWSER_DEBUG") == "1"
            last_seen = None
            while time.time() < deadline:
                url = urllib.parse.urlparse(page.url)
                if debug:
                    try:
                        sig = (url.hostname, url.path, page.evaluate(_INPUTS_JS))
                    except Exception:
                        sig = (url.hostname, url.path, "?")
                    if sig != last_seen:
                        log(f"browser: at {sig[0]}{sig[1]}  inputs={sig[2]}")
                        last_seen = sig
                if url.hostname == host and not url.path.startswith("/login"):
                    r = ctx.request.get(base + "/api/v1/users/self",
                                        headers={"Accept": "application/json"})
                    if r.ok:
                        me = json.loads(r.text().replace("while(1);", "", 1))
                        ctx.storage_state(path=str(state_path))
                        try:
                            os.chmod(state_path, 0o600)
                        except OSError:
                            pass
                        store.replace_dict({c["name"]: c["value"] for c in ctx.cookies(base)})
                        log(f"browser: logged in as {me.get('name')}")
                        return me.get("name") or "?"
                if not interactive:
                    pw_box = page.locator("input[type=password]:visible")
                    on_login_form = pw_box.count() > 0
                    token_box = page.locator("input[name=j_token]:visible, "
                                             "input[autocomplete=one-time-code]:visible")
                    if on_login_form and submitted_at is None:
                        if not (user and pw):
                            raise BrowserLoginError(
                                "UoA login server wants a password (its session expired) and "
                                "UOA_USERNAME/UOA_PASSWORD are not set")
                        log("browser: filling UoA login form")
                        page.locator("input[name=j_username], input[type=email], "
                                     "input[autocomplete=username]").first.fill(user)
                        pw_box.first.fill(pw)
                        _submit(pw_box.first)
                        submitted_at = time.time()
                    elif on_login_form and submitted_at and time.time() - submitted_at > 10:
                        raise BrowserLoginError(
                            "UoA rejected the username/password (still on the login form)")
                    elif token_box.count() > 0 and not on_login_form:
                        # UoA two-factor page: "Enter your two-factor token" + "Remember me"
                        if token_sent_at and time.time() - token_sent_at < 12:
                            pass  # just submitted a code; give it time to go through
                        else:
                            if token_sent_at:
                                tries += 1
                                token_sent_at = 0.0
                                if tries >= 3:
                                    raise BrowserLoginError("UoA rejected the two-factor code 3 times")
                                log("browser: two-factor code not accepted, trying again")
                            if not cfg("UOA_TOTP_SECRET"):
                                raise BrowserLoginError(
                                    "UoA asked for a two-factor code and UOA_TOTP_SECRET is not set")
                            # on a retry, use the next 30 s window in case the clock is slightly off
                            code = totp(cfg("UOA_TOTP_SECRET"), offset=1 if tries else 0)
                            log("browser: entering generated two-factor code")
                            remember = page.locator("input[name=rememberMe]:visible")
                            if remember.count() and cfg("MFA_REMEMBER", "1") == "1":
                                remember.first.check()
                            token_box.first.fill(code)
                            _submit(token_box.first)
                            token_sent_at = time.time()
                    elif (submitted_at and not mfa_alerted and not on_login_form
                          and token_box.count() == 0 and url.hostname != host
                          and time.time() - submitted_at > 15):
                        # Some other MFA step (e.g. a push to approve): tell the user
                        notify("Canvas watcher: approve UoA sign-in",
                               f"The watcher is logging back in to Canvas and UoA is waiting on "
                               f"MFA. Approve it within {wait_s // 60} min.", priority=HIGH)
                        mfa_alerted = True
                page.wait_for_timeout(1000)
            raise BrowserLoginError(f"not logged in after {wait_s}s (stuck at {page.url.split('?')[0]})")
        finally:
            browser.close()


# ---------------------------------------------------------------- watching

def parse_watches(spec: str):
    """WATCH="142383:520781, 140000:500000" -> [(course, assignment), ...]"""
    out = []
    for part in (spec or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        c, a = part.split(":")
        out.append((int(c), int(a)))
    return out


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot(canvas: Canvas, course: int, aid: int, meta: dict):
    """Collect every signal for one assignment.

    A signal whose request fails is left OUT of the result (not set to None), so the
    caller keeps the last known value. Otherwise one timed-out request would record
    score=None and the next good poll would announce the same release again.
    """
    s = {"checkedAt": iso(datetime.now(timezone.utc))}

    # 1. planner: graded flips true when marked, even while hidden from students
    due = meta.get("due_at")
    base = datetime.fromisoformat(due.replace("Z", "+00:00")) if due else datetime.now(timezone.utc)
    span = timedelta(days=7 if due else 60)
    try:
        items = canvas.get("/api/v1/planner/items", {
            "start_date": iso(base - span), "end_date": iso(base + span),
            "per_page": 100, "context_codes[]": f"course_{course}"})
        item = next((i for i in items if i.get("plannable_type") == "assignment"
                     and i.get("plannable_id") == aid), None)
        if item:
            sub = item.get("submissions") or {}
            s["graded"] = bool(sub.get("graded"))
            s["needsGrading"] = bool(sub.get("needs_grading"))
            s["hasFeedback"] = bool(sub.get("has_feedback"))
        else:
            log("  planner: assignment not in the returned items, keeping last values")
    except AuthError:
        raise
    except Exception as e:
        log(f"  planner failed (keeping last values): {e}")

    # 2. own submission: score/grade only appear once posted
    try:
        sub = canvas.get(f"/api/v1/courses/{course}/assignments/{aid}/submissions/self")
        s["workflowState"] = sub.get("workflow_state")
        s["gradedAt"] = sub.get("graded_at")
        s["postedAt"] = sub.get("posted_at")
        s["score"] = sub.get("score")
        s["grade"] = sub.get("grade")
    except AuthError:
        raise
    except Exception as e:
        log(f"  submission failed (keeping last values): {e}")

    # 3. course total
    try:
        enr = canvas.get(f"/api/v1/courses/{course}/enrollments",
                         {"user_id": "self", "type[]": "StudentEnrollment"})
        g = (next((e for e in enr if e.get("type") == "StudentEnrollment"), None) or
             (enr[0] if enr else {})).get("grades") or {}
        if g.get("current_score") is not None:
            s["total"] = g["current_score"]
    except AuthError:
        raise
    except Exception as e:
        log(f"  enrollments failed (keeping last value): {e}")

    return s


def diff(prev: dict, now: dict, pts):
    """Return [(message, pushover_priority)] for changes worth alerting about.

    Emergency: score released / posted, feedback added.
    High: marked while still hidden.
    Normal: submission state change on its own.
    (Course total changes are tracked once per course in Watcher.poll_once.)
    """
    out = []
    if now.get("graded") is True and prev.get("graded") is not True:
        out.append(("Marked in Canvas (still hidden) — release is probably close", HIGH))
    if now.get("score") is not None and prev.get("score") != now.get("score"):
        out.append((f"Score released: {now['score']}/{pts}", EMERGENCY))
    elif now.get("postedAt") and not prev.get("postedAt"):
        out.append((f"Grade posted at {now['postedAt']}", EMERGENCY))
    if (now.get("workflowState") and prev.get("workflowState")
            and now["workflowState"] != prev["workflowState"]):
        out.append((f"Submission state {prev['workflowState']} → {now['workflowState']}", NORMAL))
    if now.get("hasFeedback") and not prev.get("hasFeedback"):
        out.append(("Feedback added", EMERGENCY))
    if any(m.startswith(("Score released", "Grade posted")) for m, _ in out):
        # "marked (hidden)" and "submitted → graded" are implied by the release itself
        out = [(m, p) for m, p in out if not m.startswith(("Marked in Canvas", "Submission state"))]
    return out


class Watcher:
    def __init__(self):
        base = cfg("CANVAS_URL", "https://canvas.auckland.ac.nz")
        token = cfg("CANVAS_TOKEN")
        self.cookie_store = CookieStore(Path(cfg("COOKIE_FILE", str(HERE / "cookies.json"))),
                                        seed=cfg("CANVAS_COOKIE"))
        self.browser = (not token and cfg("BROWSER_RELOGIN", "1") == "1" and playwright_available())
        self.relogin_every = int(cfg("RELOGIN_MIN_INTERVAL", "600"))
        self.last_relogin = 0.0
        self.creds_rejected = False
        self.relogin_errors = 0
        if not token and not self.cookie_store.cookies and not self.browser:
            sys.exit("No auth: run --set-cookie or --browser-login (or set CANVAS_TOKEN). See README.")
        self.canvas = Canvas(base, token, None if token else self.cookie_store)
        self.base = base.rstrip("/")
        self.watches = parse_watches(cfg("WATCH", ""))
        self.state_path = Path(cfg("STATE_FILE", str(HERE / "state.json")))
        self.state = self._load()
        self.post_release_s = int(cfg("POST_RELEASE_MINUTES", "60")) * 60
        self.auth_alerted = False

    def _load(self):
        try:
            return json.loads(self.state_path.read_text())
        except Exception:
            return {}

    def _save(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2))
        tmp.replace(self.state_path)

    def _meta(self, course, aid):
        key = f"{course}:{aid}"
        entry = self.state.setdefault(key, {})
        if "meta" not in entry:
            a = self.canvas.get(f"/api/v1/courses/{course}/assignments/{aid}")
            entry["meta"] = {"name": a.get("name") or f"Assignment {aid}",
                             "points": a.get("points_possible"),
                             "due_at": a.get("due_at")}
            log(f"Watching {key}: {entry['meta']['name']} (due {entry['meta']['due_at']})")
        return entry

    def _course_name(self, course):
        c = self.state.setdefault("_courses", {}).setdefault(str(course), {})
        if not c.get("name"):
            try:
                info = self.canvas.get(f"/api/v1/courses/{course}")
                c["name"] = info.get("course_code") or info.get("name")
            except Exception:
                pass
        return c.get("name") or f"Course {course}"

    def poll_once(self):
        if not self.watches:
            log("WATCH is empty — nothing to do. Use --list <course_id> to find IDs.")
            return
        if self.cookie_store.reload_if_changed():
            log("cookies.json changed on disk — using the new session")
        events = []  # (priority, line, course): one alert each, sent at the end of the poll
        try:
            try:
                totals = {}  # course -> course total seen this poll
                for course, aid in self.watches:
                    entry = self._meta(course, aid)
                    meta = entry["meta"]
                    if entry.get("done"):
                        continue
                    prev = entry.get("last")
                    # signals that failed this poll are missing from the snapshot: carry the
                    # last known values forward so a hiccup never looks like a change
                    now = {**(prev or {}), **snapshot(self.canvas, course, aid, meta)}
                    log(f"{meta['name']}: graded={now.get('graded')} state={now.get('workflowState')} "
                        f"score={now.get('score')} posted={now.get('postedAt')} "
                        f"feedback={now.get('hasFeedback')} total={now.get('total')}")
                    if prev is None:
                        log("  baseline stored")
                        if now.get("graded"):
                            events.append((HIGH, f"{meta['name']}: already marked (hidden) at watcher start",
                                           course))
                    else:
                        for msg, pr in diff(prev, now, meta.get("points")):
                            events.append((pr, f"{meta['name']}: {msg}", course))
                    if now.get("total") is not None:
                        totals.setdefault(course, now["total"])
                    # once released, keep watching a while for feedback, then stop
                    if now.get("score") is not None and not entry.get("releasedAt"):
                        entry["releasedAt"] = time.time()
                    if entry.get("releasedAt") and time.time() - entry["releasedAt"] > self.post_release_s:
                        entry["done"] = True
                        log(f"  released > {self.post_release_s // 60} min ago — no longer polling this one")
                    entry["last"] = now

                # The course total belongs to the course, not to each watched assignment:
                # compare it once per course so 3 watches in one course give 1 line, not 3 alerts.
                courses = self.state.setdefault("_courses", {})
                for course, total in totals.items():
                    c = courses.setdefault(str(course), {})
                    if c.get("total") is not None and c["total"] != total:
                        events.append((EMERGENCY,
                                       f"{self._course_name(course)}: course total {c['total']}% → {total}%",
                                       course))
                    c["total"] = total
                self.auth_alerted = False
            finally:
                # Send whatever was found even if a later request failed, then save, so a
                # change is never recorded as "seen" without having been alerted.
                # One alert per change (score released and feedback added are separate,
                # as are two assignments released together), most urgent first.
                for pr, line, course in sorted(events, key=lambda e: -e[0]):
                    notify(line, line, priority=pr, click_url=f"{self.base}/courses/{course}/grades")
                self._save()
        except AuthError as e:
            log(str(e))
            reason = "Canvas session expired."
            if self.browser and time.time() - self.last_relogin >= self.relogin_every:
                self.last_relogin = time.time()
                if self.creds_rejected:  # never hammer the login server with a bad password
                    os.environ.pop("UOA_PASSWORD", None)
                try:
                    browser_login(self.base, self.cookie_store)
                    self.auth_alerted = False
                    self.relogin_errors = 0
                    return  # next poll uses the fresh session
                except BrowserLoginError as be:  # needs you: bad password, no TOTP secret, ...
                    log("browser re-login failed:", be)
                    if "rejected the username/password" in str(be):
                        self.creds_rejected = True
                    reason = f"Automatic re-login needs you: {be}."
                except Exception as be:  # network/browser hiccup: retry quietly, alert if it persists
                    self.relogin_errors += 1
                    log(f"browser re-login error ({self.relogin_errors} in a row):", repr(be))
                    if self.relogin_errors < 3:
                        return
                    reason = f"Automatic re-login keeps failing: {be}."
            elif self.browser:
                return  # waiting out RELOGIN_MIN_INTERVAL before the next browser attempt
            if not self.auth_alerted:
                notify("Canvas grade watcher: logged out",
                       f"{reason} Run --browser-login or --set-cookie for the Pi. "
                       "Keeps retrying meanwhile.", priority=HIGH)
                self.auth_alerted = True

    def run(self, interval):
        log(f"Polling {len(self.watches)} assignment(s) every {interval}s")
        while True:
            try:
                self.poll_once()
            except Exception as e:  # network blips, Canvas 5xx, etc.
                log("poll error:", repr(e))
            if self.watches and all(self.state.get(f"{c}:{a}", {}).get("done") for c, a in self.watches):
                log("All watched assignments released. Exiting.")
                return
            time.sleep(interval)


# ---------------------------------------------------------------- cli

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(HERE / "watcher.env"))
    ap.add_argument("--once", action="store_true", help="poll once and exit")
    ap.add_argument("--list", metavar="COURSE_ID", type=int, help="list assignments in a course")
    ap.add_argument("--test", action="store_true", help="send a test alert")
    ap.add_argument("--status", action="store_true", help="print stored state")
    ap.add_argument("--set-cookie", action="store_true",
                    help="paste a browser Cookie header on stdin to (re)authenticate")
    ap.add_argument("--browser-login", action="store_true",
                    help="log in through a visible browser window (needs a display)")
    ap.add_argument("--relogin", action="store_true",
                    help="run the headless automatic re-login now (what the service does)")
    args = ap.parse_args()
    load_env_file(Path(args.config))

    if args.browser_login or args.relogin:
        if not playwright_available():
            sys.exit("Playwright is not installed (see README: pip install playwright)")
        store = CookieStore(Path(cfg("COOKIE_FILE", str(HERE / "cookies.json"))))
        base = cfg("CANVAS_URL", "https://canvas.auckland.ac.nz").rstrip("/")
        try:
            name = browser_login(base, store, interactive=args.browser_login)
        except BrowserLoginError as e:
            sys.exit(f"Login failed: {e}")
        print(f"OK — logged in as {name}. Saved cookies.json + browser_state.json.", file=sys.stderr)
        return

    if args.set_cookie:
        print("Paste the Cookie header from a canvas request (DevTools > Network), then Enter:",
              file=sys.stderr)
        header = sys.stdin.readline().strip()
        if header.lower().startswith("cookie:"):
            header = header[7:].strip()
        store = CookieStore(Path(cfg("COOKIE_FILE", str(HERE / "cookies.json"))))
        store.replace(header)
        me = Canvas(cfg("CANVAS_URL", "https://canvas.auckland.ac.nz"), cookies=store).get(
            "/api/v1/users/self")
        print(f"OK — logged in as {me.get('name')}. Saved {len(store.cookies)} cookies.", file=sys.stderr)
        return

    if args.test:
        ok = notify("Canvas grade watcher: test",
                    "Emergency test — this repeats until you tap Acknowledge.", priority=EMERGENCY)
        sys.exit(0 if ok else 1)

    w = Watcher()
    if args.list:
        for a in w.canvas.get_all(f"/api/v1/courses/{args.list}/assignments", {"order_by": "due_at"}):
            print(f"{args.list}:{a['id']:<10} due {a.get('due_at') or '-':<22} {a['name']}")
        return
    if args.status:
        print(json.dumps(w.state, indent=2))
        return
    if args.once:
        w.poll_once()
        return
    w.run(int(cfg("POLL_SECONDS", "15")))


if __name__ == "__main__":
    main()
