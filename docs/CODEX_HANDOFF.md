# Codex Handoff: LOFT HALL Internship Unified

This file is a compact handoff for future Codex turns. It is not a secret store. Do not put bot tokens or private `.env` values here.

## Current Production

- Project: `loft_hall_internship_unified`
- GitHub: `https://github.com/xk369/lh-stazhirovka`
- Production URL: `https://stazhirovka.151.244.243.164.sslip.io`
- Server: `roma@151.244.243.164`
- Server path: `/opt/loft-hall-internship-unified`
- Docker container: `loft-internship-unified`
- Host port: `127.0.0.1:3500 -> 3000`
- To check the currently deployed commit: `cd /opt/loft-hall-internship-unified && git rev-parse --short HEAD`
- Last verified deployed commit before this handoff was added: `2e07a4d`

## Staging / Manual Copy

Use the server copy for non-urgent product changes before touching production.

- Staging URL: `https://stazhirovka-manual.151.244.243.164.sslip.io`
- Server path: `/opt/loft-hall-internship-unified-manual`
- Docker container: `loft-internship-unified-manual`
- Host port: `127.0.0.1:3501 -> 3000`
- Preferred flow: create a feature branch locally, push it to GitHub, switch the staging copy to that branch, rebuild staging, test there, then merge/deploy production only after user approval.
- Keep staging data close to production for realistic checks: before testing, back up `/opt/loft-hall-internship-unified-manual/data/db.json` and copy `/opt/loft-hall-internship-unified/data/db.json` into the manual copy.
- Keep `SUPPRESS_TRAINEE_NOTIFICATIONS=yes` in the staging `.env` when using real production trainee data. This allows recruiter/mentor flow testing without sending personal Telegram notifications to trainees.
- Current staging branch should include the mentor fallback: `Нет нужного стажёра в списке` opens manual trainee FIO/Telegram fields. Backend then tries to safely bind the report to one matching booking application by FIO, Telegram, and date; ambiguous/manual-only reports remain unlinked.
- Current staging queue experiment: trainees do not see public free dates and can only enter `queue`. Recruiter sends a 3-hour assignment confirmation request from the queue; trainee `Да` moves the application to `confirmed`, while `Нет`/timeout keeps it in `queue`. Before workgroup invite, a confirmed trainee can withdraw back to `queue`; `RECRUITER_WITHDRAWAL_CHAT_ID` receives a service notification.

## Report Routing

Report routing is server-side only. Do not hardcode chat ids in HTML.

- Trainee reports use `TRAINEE_CHAT_ID`.
- Mentor reports use `MENTOR_CHAT_ID`.
- Last verified production values:
  - `TRAINEE_CHAT_ID=-1003951918570`
  - `MENTOR_CHAT_ID=-1001521852218`

## Core Rules

- Production is already live. Avoid broad refactors during urgent UI fixes.
- Preserve the end-to-end chain: booking -> recruiter confirmation -> workgroup invite -> attendance -> mentor report -> trainee result -> registry.
- Do not weaken Telegram `initData` verification or recruiter server-side authorization.
- Do not edit runtime `data/db.json` unless explicitly requested and backed up.
- Keep this file current. Update it in the same commit as any change to production state, deploy procedure, server path, report chat routing, or important UI/business decisions.
- Keep `docs/INTERNSHIP_WORKFLOW.md` current when the actual role flow, statuses, Telegram messages, report side effects, or recruiter/mentor/trainee actions change.
- Before each production deploy:
  - if the change is not an urgent hotfix, test it on the staging/manual copy first;
  - run `npm test`;
  - run `git diff --check`;
  - commit and push to `origin/main`;
  - create a server backup under `backups/deploy-YYYYMMDD-HHMMSS`;
  - pull on the server with fast-forward only;
  - rebuild with `docker compose up -d --build`;
  - check `/api/health` locally and publicly.

## Important Files

- `public/booking.html` - main booking/recruiter UI. Large file; keep edits scoped.
- `src/server.js` - backend API, state commands, Telegram notifications, report side effects.
- `src/report.js` - report role validation and chat routing.
- `src/telegram.js` - Telegram initData validation and Telegram send helpers.
- `test/booking-state.test.js` - state command and status-flow tests.
- `test/booking-ui.test.js` - UI structure regression checks.
- `test/mentor-report-link.test.js` - mentor report, trainee notification, and report-result tests.
- `docs/INTERNSHIP_WORKFLOW.md` - full business workflow by role.

## Recent UI Decisions

- Trainee/candidate cards should not show the old status badge stack.
- Do not show `Комментарий стажеру отправлен` in cards.
- FIO should have its own first row and not conflict with the status.
- Phone must stay visible in trainee cards near the top, under FIO.
- Current status is rendered in a separate full-width row.
- Training and internship type are visually separated as two compact tags without the header `Профиль стажировки`.

## Useful Commands

```bash
npm test
git diff --check
curl -fsS https://stazhirovka.151.244.243.164.sslip.io/api/health
```

Server deploy shape:

```bash
cd /opt/loft-hall-internship-unified
git fetch origin
git merge --ff-only origin/main
docker compose up -d --build
curl -fsS http://127.0.0.1:3500/api/health
```

Staging deploy shape:

```bash
cd /opt/loft-hall-internship-unified-manual
git fetch origin
git switch <feature-branch>
git merge --ff-only origin/<feature-branch>
LOFT_INTERNSHIP_CONTAINER_NAME=loft-internship-unified-manual LOFT_INTERNSHIP_HOST_PORT=127.0.0.1:3501 docker compose up -d --build
curl -fsS http://127.0.0.1:3501/api/health
```
