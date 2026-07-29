# Migration PR Safety Check

Этот документ описывает быстрый автоматический фильтр для ревью migration PR.
Он не заменяет ручное Codex-ревью, но помогает сразу поймать запрещенные
изменения до глубокого чтения diff.

## Command

```bash
node scripts/check-migration-pr-safety.js \
  migration/postgres-foundation \
  origin/migration/postgres-write-adapter-claude
```

Для локальной ветки:

```bash
node scripts/check-migration-pr-safety.js migration/postgres-foundation HEAD
```

## Что Блокируется

Скрипт возвращает non-zero exit code, если PR меняет:

- `data/db.json`;
- `.env` или `.env.*`, кроме `.env.example`;
- `docs/MIGRATION_EXECUTION_PLAN.md`;
- `docs/POSTGRES_MIGRATION_ROADMAP.md`;
- `docs/CODEX_HANDOFF.md`;
- `data/`, `backups/`, `migration-source/`;
- файлы дампов/архивов: `.dump`, `.backup`, `.sqlite`, `.db`, `.tar`,
  `.tgz`, `.gz`, `.zip`.

## Что Только Подсвечивается

Скрипт не блокирует, но требует ручного Codex-ревью:

- `src/server.js`;
- Telegram/report файлы;
- `package.json` / `package-lock.json`;
- deploy/Docker/compose/Caddyfile;
- `public/booking.html`;
- `db/migrations/*`.

## Как Использовать В Ревью Claude

1. Запустить safety-check.
2. Если `FAIL` - не принимать PR до исправления или явного решения Codex.
3. Если `PASS`, но есть `Manual review required` - читать эти файлы вручную.
4. После этого запускать:

```bash
npm test
git diff --check
```

Если менялся Postgres runtime/tooling:

```bash
npm run test:postgres
```
