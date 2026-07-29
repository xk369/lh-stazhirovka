# Parallel Agent Coordination

Этот файл описывает, как безопасно вести миграцию двумя агентами: Codex и
Claude. Он не заменяет `MIGRATION_EXECUTION_PLAN.md`; стратегия и порядок
этапов остаются там.

## Текущая Схема

Codex отвечает за:

- общий план миграции;
- проценты прогресса;
- production safety;
- review Claude PR;
- cutover/rollback;
- финальное решение о merge.

Claude отвечает за:

- один маленький work package за раз;
- реализацию только в своей ветке;
- тесты к своему scope;
- отчет `Report For Codex Review`.

## Branch Model

Базовая ветка:

```text
migration/postgres-foundation
```

Claude branch:

```text
migration/postgres-write-adapter-claude
```

Codex branch для QA/review документов:

```text
migration/codex-review-qa-playbook
```

PR targets:

```text
migration/postgres-write-adapter-claude -> migration/postgres-foundation
migration/codex-review-qa-playbook -> migration/postgres-foundation
```

Ни один migration PR не должен идти напрямую в `main`.

## File Ownership На Текущую Итерацию

Claude может трогать:

- новые файлы storage adapter;
- новые Postgres writer/helper files;
- tests для выбранного write path;
- минимальные изменения в `src/server.js`, только если без этого нельзя
  подключить adapter;
- `docs/CODEX_PROGRESS.md` только как фактический worklog без изменения
  процентов и стратегии.

Claude не должен трогать:

- `docs/MIGRATION_EXECUTION_PLAN.md`;
- `docs/POSTGRES_MIGRATION_ROADMAP.md`;
- `docs/CODEX_HANDOFF.md`;
- production deploy files;
- `.env`, `data/db.json`, dumps;
- report chat routing;
- Telegram live delivery.

Codex на параллельной итерации трогает только:

- новые QA/review docs;
- review notes;
- coordination docs.

Codex не трогает до ревью Claude PR:

- storage adapter implementation;
- booking storage mode implementation;
- runtime Postgres write path;
- `src/server.js` write endpoint.

## Merge Order

Рекомендуемый порядок:

1. Сначала merge маленьких docs-only PR, если они не конфликтуют.
2. Потом review Claude PR.
3. Если Claude PR меняет runtime path, Codex обязан проверить diff вручную.
4. После merge Claude PR Codex обновляет:
   - `CODEX_PROGRESS.md`;
   - процент миграции, если этап реально продвинулся;
   - `MIGRATION_EXECUTION_PLAN.md`, если изменился статус этапа.

## Что Считать Конфликтом

Конфликтом считается не только Git conflict, но и:

- Claude меняет стратегию;
- Claude включает production-ready режим раньше времени;
- Claude меняет Telegram live behavior;
- Claude пишет PII в тесты или docs;
- Claude добавляет fallback Postgres -> JSON без явного решения;
- Claude меняет API формы/отчетов вне своего scope.

## Что Делать После Claude Итерации

Codex должен:

1. Прочитать `Report For Codex Review`.
2. Сверить:
   - branch;
   - base commit;
   - head commit;
   - changed files;
   - заявленный scope;
   - реальные diff.
3. Запустить проверки:
   - `npm test`;
   - `git diff --check`;
   - `npm run test:postgres`, если затронут Postgres runtime/tooling.
4. Проверить production safety:
   - default storage remains JSON;
   - no prod deploy changes;
   - no live Telegram in staging;
   - no secrets/PII committed.
5. Только потом принимать или просить правки.
