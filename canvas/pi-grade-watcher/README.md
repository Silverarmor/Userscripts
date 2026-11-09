# Canvas Grade Watcher (headless / Raspberry Pi)

Server-side version of [`canvas-grade-watcher.user.js`](../canvas-grade-watcher.user.js).
No browser tabs: a Python script polls the Canvas API every 15 s using your logged-in
session and sends Pushover alerts. When the session expires, it logs back in by itself
in a headless Chromium.

| Event | How it's detected | Pushover priority |
|---|---|---|
| Marked but still hidden | `/api/v1/planner/items` → `submissions.graded` | **emergency** |
| Score released | `.../submissions/self` → `score` / `posted_at` | **emergency** |
| Submission state changes | `.../submissions/self` → `workflow_state` | **emergency** |
| Approve UoA MFA (during auto re-login) | browser left the password page | high |
| Logged out and auto re-login failed | 401 / redirect to login | high |
| Feedback added | planner `has_feedback` | normal |
| Course total moves | `/enrollments?user_id=self` → `current_score` | normal |

Emergency alerts repeat every 30 s until you tap **Acknowledge**, for up to 3 h. After a
score is released the watcher keeps polling for `POST_RELEASE_MINUTES` (feedback), then
stops. When every watched assignment is released the service exits.

## Requirements

- Raspberry Pi 4/5 (2 GB+ RAM recommended; a Pi 3 works but is slow to log in)
- **64-bit** Raspberry Pi OS (Bookworm or later). Playwright has no 32-bit ARM build;
  check with `uname -m`, which should print `aarch64`.
- A Pushover account and app

Chromium only runs while logging in (about 300 MB of RAM for about 30 s). Normal polling is plain
HTTP and uses a few MB.

## Install (only this folder, via git)

A sparse checkout downloads and checks out only `canvas/pi-grade-watcher`, not the rest
of the repo:

```bash
sudo apt install -y git python3-venv
git clone --filter=blob:none --no-checkout https://github.com/Silverarmor/Userscripts.git ~/Userscripts
cd ~/Userscripts
git sparse-checkout set --no-cone /canvas/pi-grade-watcher/
git checkout master
cd canvas/pi-grade-watcher
```

Python environment and browser:

```bash
python3 -m venv .venv
.venv/bin/pip install playwright
.venv/bin/python -m playwright install chromium
sudo .venv/bin/python -m playwright install-deps chromium
```

If `install chromium` / `install-deps` fail on your OS, use the distro's Chromium instead:
`sudo apt install -y chromium` (older images: `chromium-browser`). The script finds it
automatically, or set `BROWSER_PATH`.

Config:

```bash
cp watcher.env.example watcher.env
chmod 600 watcher.env
nano watcher.env
```

Set `PUSHOVER_TOKEN`, `PUSHOVER_USER` and `WATCH`. To let the Pi log in fully by itself,
also set `UOA_USERNAME` / `UOA_PASSWORD` (see [Login](#login)).

### Update later

```bash
cd ~/Userscripts && git pull && sudo systemctl restart canvas-grade-watcher
```

Your `watcher.env`, `cookies.json`, `browser_state.json` and `state.json` are git-ignored,
so `git pull` never touches them.

## Pushover

1. Install Pushover, then copy your **User Key** from the dashboard to `PUSHOVER_USER`.
2. Create an Application at pushover.net/apps/build. Put its API token in `PUSHOVER_TOKEN`.
3. In the app's settings, allow emergency alerts to override silent / Do Not Disturb
   (iOS: enable Critical Alerts).
4. `.venv/bin/python canvas_grade_watcher.py --test`. It keeps alerting until you acknowledge.

## Login

UoA disables Canvas access tokens, so the watcher uses a real login session. It's
saved in `cookies.json` (Canvas session) and `browser_state.json` (the browser profile,
including the UoA login server's cookies). Both files are equivalent to being logged in.
They are created with mode 600, so don't share them.

When Canvas rejects the session, the service opens a headless Chromium (at most every
`RELOGIN_MIN_INTERVAL`, default 10 min):

1. **Silent:** if the UoA login server (iam.auckland.ac.nz) still remembers you, it
   bounces straight back into Canvas. No typing, no alert.
2. **Password:** if it shows the sign-in form and `UOA_USERNAME`/`UOA_PASSWORD` are set,
   it fills them in. If MFA is asked for, you get a high-priority Pushover alert saying
   *approve UoA sign-in*, and it waits `MFA_WAIT_SECONDS` (default 180) for you to approve.
   If the password is rejected it stops using it until the service restarts, so it
   can't lock your account.
3. **Otherwise** you get a high-priority *logged out* alert. Log in manually as below.
   The running service picks up the new session on its next poll.

### First login (pick one)

- **On the Pi, with your password in `watcher.env`:**
  `.venv/bin/python canvas_grade_watcher.py --relogin`. Approve the MFA prompt when asked.
- **On a computer with a screen:** install the same thing there (`pip install playwright`
  plus `python -m playwright install chromium`, or have Google Chrome installed), run
  `python canvas_grade_watcher.py --browser-login`, log in in the window that opens,
  then copy the two files to the Pi:
  `scp cookies.json browser_state.json pi@<pi-ip>:~/Userscripts/canvas/pi-grade-watcher/`
- **Without a browser at all:** in Chrome DevTools (F12) → **Network**, click any
  `canvas.auckland.ac.nz` request, copy the `cookie:` request header, then run
  `.venv/bin/python canvas_grade_watcher.py --set-cookie` and paste it. That only renews the
  Canvas session, so later automatic re-logins need the password option.

## Run as a service

Edit `User=` and the paths in `canvas-grade-watcher.service` if your username isn't `pi`:

```bash
.venv/bin/python canvas_grade_watcher.py --list 142383   # find assignment IDs for WATCH
.venv/bin/python canvas_grade_watcher.py --once          # one real poll
sudo cp canvas-grade-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now canvas-grade-watcher
journalctl -u canvas-grade-watcher -f
```

To watch something new, edit `WATCH` and run `sudo systemctl restart canvas-grade-watcher`.
Delete `state.json` to reset baselines.

## Commands

| Flag | Does |
|---|---|
| *(none)* | poll forever (the service) |
| `--relogin` | headless browser login now, the same as the automatic one |
| `--browser-login` | log in by hand in a visible browser window |
| `--set-cookie` | paste a browser Cookie header |
| `--list COURSE_ID` | list assignments as `course:assignment` pairs for `WATCH` |
| `--test` | emergency test alert |
| `--once` | single poll |
| `--status` | dump saved state (`state.json`) |
