# Codex Notes For This Repository

Before making changes in this project, read:

- `docs/CODEX_HANDOFF.md` for current production state, deploy rules, and recent decisions.
- `docs/INTERNSHIP_WORKFLOW.md` for the full user-flow and role logic.

Production is live, so keep changes small, tested, and deploy with a server backup first. Do not change report chat routing, Telegram auth, state-versioning, or runtime data unless the user explicitly asks for that change.

Always run `npm test` and `git diff --check` before deploying. For deploys, use GitHub first, then pull on the server and rebuild the existing Docker container.

Documentation is part of done:

- Update `docs/CODEX_HANDOFF.md` whenever production state, deploy steps, server paths, chat routing, recent UI decisions, or critical operational notes change.
- Update `docs/INTERNSHIP_WORKFLOW.md` whenever roles, statuses, Telegram messages, report routing, recruiter actions, trainee actions, or mentor-report side effects change.
- If a change is code-only and does not affect workflow or operations, explicitly say in the final answer that these docs did not need updates.
