# Postgres Migration Roadmap

Этот файл нужен как рабочая инструкция для будущих заходов Codex после компактинга контекста. Не содержит секретов, токенов и паролей.

## 1. Текущая ситуация

Проект `loft_hall_internship_unified` уже в продакшене. Главная цепочка:

```text
заявка стажера
-> подтверждение рекрутом
-> отправка рабочей группы
-> отметка выхода
-> отчет наставника
-> итог стажеру
-> реестр
```

Сейчас источник истины - JSON `data/db.json`:

- `shifts` - даты стажировок;
- `applications` - заявки стажеров и их статусы;
- `inviteGroups` - отправленные рабочие группы.

Документы:

- `docs/INTERNSHIP_WORKFLOW.md` - бизнес-цепочка по ролям;
- `docs/DATA_MODEL.md` - текущие поля и связи;
- `docs/CODEX_HANDOFF.md` - краткий handoff по продакшену и деплою.

## 2. Главное правило

Не переписывать прод напрямую. Новую архитектуру делаем через отдельный staging/миграционный контур.

Нужны три контура:

1. `prod` - текущий рабочий проект, пользователи работают здесь.
2. `staging` - копия prod на отдельном домене/порту, с копией prod-данных и выключенными личными уведомлениями стажерам.
3. `migration` - ветка/копия для Postgres и event log.

В staging/test обязательно держать:

```env
SUPPRESS_TRAINEE_NOTIFICATIONS=yes
TELEGRAM_DELIVERY_MODE=dry_run
```

Цель: можно нажимать кнопки рекрута/наставника и проверять цепочку, не отправляя реальные личные уведомления стажерам.
`dry_run` дополнительно запрещает отправку тестовых отчетов в реальные
Telegram-группы; в лог попадают только тип доставки, длина и SHA-256 текста,
без токена, chat id и содержимого отчета.

## 3. Что нельзя потерять

При переходе на Postgres нельзя сломать или потерять:

- ФИО стажера;
- телефон;
- Telegram username;
- Telegram user id/chat id;
- статус заявки;
- дату стажировки;
- количество мест;
- обучение и дату обучения;
- первая/повторная стажировка;
- ограничения стажера;
- рабочую группу;
- площадку/лофт/зал;
- отчет наставника;
- итог наставника;
- статус доставки личного сообщения стажеру;
- признак `Опытный стажер`;
- историю отправленных рабочих групп;
- CSV/реестр;
- автозакрытие дат;
- откаты статусов;
- отмену даты/отмену стажировки конкретному стажеру;
- защиту Telegram initData;
- серверную роль рекрутера.

## 4. Целевая Postgres-модель

Postgres не должен быть одной таблицей `state`. Нужна нормальная структура.

### `telegram_users`

Связка Telegram-пользователя с системой.

Поля:

- `id uuid primary key`;
- `telegram_user_id text unique not null`;
- `telegram_chat_id text`;
- `username text`;
- `first_name text`;
- `last_name text`;
- `language_code text`;
- `created_at timestamptz not null`;
- `updated_at timestamptz not null`.

### `recruiters`

Кто имеет доступ к кабинету рекрута.

Поля:

- `id uuid primary key`;
- `telegram_user_id text unique not null`;
- `name text`;
- `active boolean not null default true`;
- `created_at timestamptz not null`.

На первом этапе можно импортировать из `.env RECRUITER_TELEGRAM_IDS`, но лучше затем управлять таблицей.

### `shifts`

Даты стажировок.

Поля:

- `id uuid primary key`;
- `legacy_id bigint unique`;
- `date date not null unique`;
- `seats integer not null check (seats between 1 and 30)`;
- `open boolean not null default true`;
- `canceled boolean not null default false`;
- `canceled_at timestamptz`;
- `created_at timestamptz not null`;
- `updated_at timestamptz not null`.

### `applications`

Основная таблица заявок.

Поля:

- `id uuid primary key`;
- `legacy_id bigint unique`;
- `shift_id uuid references shifts(id) on delete set null`;
- `trainee_telegram_user_id text`;
- `trainee_telegram_chat_id text`;
- `telegram_username text`;
- `telegram_code text`;
- `name text not null`;
- `phone text not null`;
- `training text not null check (training in ('passed','not_passed'))`;
- `training_date date`;
- `attempt text not null check (attempt in ('first','repeat'))`;
- `limits text`;
- `status text not null`;
- `comment text`;
- `venue_id text`;
- `group_link text`;
- `candidate_report boolean not null default false`;
- `experience text`;
- `created_at timestamptz not null`;
- `updated_at timestamptz not null`;

Индексы:

- `applications(status)`;
- `applications(shift_id)`;
- `applications(trainee_telegram_user_id)`;
- `applications(lower(name))`;
- `applications(telegram_username)`;

Важно: `status` лучше дополнительно проверять через application state machine, а не только DB check.

### `invite_groups`

Факт отправки рабочей группы.

Поля:

- `id uuid primary key`;
- `legacy_id bigint unique`;
- `shift_id uuid not null references shifts(id)`;
- `venue_id text not null`;
- `link text not null`;
- `sent_at timestamptz not null`;
- `created_by_telegram_user_id text`;
- `created_at timestamptz not null`.

### `invite_group_members`

Связь многие-ко-многим между рабочими группами и заявками.

Поля:

- `invite_group_id uuid not null references invite_groups(id) on delete cascade`;
- `application_id uuid not null references applications(id) on delete cascade`;
- `primary key (invite_group_id, application_id)`.

Одна рабочая группа может содержать нескольких стажеров. Одна актуальная заявка обычно привязана к одной рабочей группе.

### `mentor_reports`

Отчет наставника как отдельная сущность.

Поля:

- `id uuid primary key`;
- `application_id uuid not null references applications(id)`;
- `mentor_telegram_user_id text`;
- `mentor_username text`;
- `mentor_name text`;
- `decision text not null`;
- `mastered integer not null`;
- `total integer not null`;
- `venue_id text`;
- `venue_label text`;
- `venue_loft text`;
- `hall text`;
- `mentor_comment text`;
- `trainee_message_text text`;
- `report_text text`;
- `created_at timestamptz not null`.

Ограничение:

- на первом этапе максимум один актуальный отчет на заявку;
- при откате `passed/failed -> feedback` старый отчет можно помечать `voided_at`, а не удалять.

### `mentor_report_topics`

Темы для повторения, которые можно отправлять стажеру.

Поля:

- `id uuid primary key`;
- `mentor_report_id uuid not null references mentor_reports(id) on delete cascade`;
- `topic_order integer not null`;
- `title text not null`.

### `notifications`

Все попытки Telegram-отправок.

Поля:

- `id uuid primary key`;
- `application_id uuid references applications(id)`;
- `mentor_report_id uuid references mentor_reports(id)`;
- `type text not null`;
- `chat_id text`;
- `chat_target text`;
- `text text`;
- `status text not null check (status in ('pending','sent','skipped','failed'))`;
- `telegram_message_id text`;
- `error text`;
- `attempt_count integer not null default 0`;
- `next_attempt_at timestamptz`;
- `sent_at timestamptz`;
- `created_at timestamptz not null`;
- `updated_at timestamptz not null`.

Это база для outbox-паттерна.

### `application_events`

Журнал бизнес-событий.

Поля:

- `id uuid primary key`;
- `application_id uuid references applications(id)`;
- `shift_id uuid references shifts(id)`;
- `event_type text not null`;
- `actor_type text not null`;
- `actor_telegram_user_id text`;
- `payload jsonb not null default '{}'::jsonb`;
- `created_at timestamptz not null`.

Примеры `event_type`:

- `application_created`;
- `application_updated`;
- `application_cancelled`;
- `application_assigned_to_shift`;
- `recruiter_confirmed`;
- `invite_group_sent`;
- `attendance_marked_feedback`;
- `attendance_marked_noshow`;
- `mentor_report_received`;
- `mentor_result_notification_sent`;
- `application_passed`;
- `application_failed`;
- `application_step_back`;
- `internship_cancelled`;
- `shift_cancelled`;
- `shift_capacity_changed`;
- `shift_auto_closed`;
- `experienced_marked`.

## 5. State machine

Статусы заявки вынесены в `src/booking-state-machine.js` и покрыты unit-тестами.

Разрешенные переходы:

```text
queue -> pending
pending -> confirmed
confirmed -> invited
invited -> feedback
invited -> noshow
feedback -> passed
feedback -> failed
invited -> passed
invited -> failed
feedback -> invited
passed -> feedback
failed -> feedback
noshow -> invited
```

Условия:

- `queue -> pending`: должна быть дата со свободными местами;
- `pending -> confirmed`: заявку подтверждает рекрут;
- `confirmed -> invited`: должна создаться рабочая группа;
- `invited -> feedback`: рекрут нажал `Вышел`;
- `invited -> noshow`: рекрут нажал `Не вышел`;
- `invited/feedback -> passed/failed`: только отчет наставника. `invited` сохранен как
  допустимый источник, потому что текущий список наставника позволяет отправить
  отчет и до ручной отметки рекрута `Вышел`;
- `passed -> feedback` и `failed -> feedback`: откат очищает/void старый отчет;
- `passed -> experienced`: не статус заявки, а отдельный флаг `experience = experienced`.

Текущий интерфейс также содержит корректирующее действие `Вернуть в новые
заявки`, которое через общий `set_application_status` допускает:

- `confirmed -> pending`;
- `invited -> pending`;
- `feedback -> pending`.

До включения Postgres-записи это действие нужно заменить отдельной бизнес-командой:
она обязана явно решить, очищаются ли старая рабочая группа, площадка и связь с
архивом. Нельзя механически переносить этот переход в SQL, иначе старая и новая
группы одной заявки могут смешаться.

## 6. Event log: зачем и как

Event log нужен, чтобы расследовать жалобы без ручного копания в JSON.

Пример проблемы:

> Наставник отправил отчет, но рекрут не видит итог.

С event log проверяем:

1. Было ли событие `mentor_report_received`.
2. Какая заявка была найдена.
3. Был ли переход `feedback -> passed/failed`.
4. Было ли создано уведомление стажеру.
5. Ушло ли уведомление или получило `failed/skipped`.

Сейчас без event log приходится вручную искать заявку, сравнивать статус, группу, отчет и Telegram.

## 7. Outbox для Telegram

Проблема: Telegram-отправка и запись state не являются одной транзакцией.

Целевая схема:

1. API валидирует действие.
2. В одной DB-транзакции:
   - пишет бизнес-изменение;
   - пишет `application_events`;
   - пишет `notifications(status='pending')`.
3. Worker берет pending-уведомления.
4. Worker отправляет Telegram.
5. Worker обновляет `notifications` в `sent/failed/skipped`.

Так отчет не может попасть в Telegram-группу и не попасть в базу. Если Telegram упал, база все равно знает, что надо отправить позже.

## 8. Staging-процесс

Для каждой крупной архитектурной задачи:

1. Создать ветку от актуального `origin/main`.
2. Поднять отдельный staging-контейнер.
3. Скопировать prod `data/db.json` в staging.
4. Включить `SUPPRESS_TRAINEE_NOTIFICATIONS=yes`.
5. Если появляется Postgres, поднять отдельную staging-БД.
6. Прогнать мигратор JSON -> Postgres.
7. Сравнить:
   - количество заявок;
   - количество дат;
   - количество рабочих групп;
   - статусы;
   - свободные места;
   - список наставника;
   - реестр;
   - архив групп.
8. Прогнать ручной сценарий:
   - новая заявка;
   - подтверждение;
   - группа;
   - вышел;
   - отчет наставника;
   - итог;
   - реестр;
   - откат;
   - отмена стажировки;
   - изменение мест;
   - некорректная ссылка;
   - двойной клик.
9. Только после этого обсуждать перенос в prod.

## 9. План миграции по этапам

### Этап A: подготовка без смены базы

- Зафиксировать `docs/DATA_MODEL.md`.
- Добавить тесты на текущие edge cases.
- [x] Вынести state machine в отдельный модуль.
- [x] Добавить unit-тесты матрицы статусов и запрета пропуска этапов.
- Добавить event log пока в JSON или отдельный append-only файл, если нужно быстро.

### Этап B: Postgres рядом с JSON

- [x] Добавить зависимость `pg`.
- [x] Добавить первую миграцию целевой схемы.
- [x] Добавить `DATABASE_URL` только для migration/staging-инструментов.
- [x] Написать транзакционный мигратор `data/db.json -> Postgres`, который
  отказывается писать в непустую базу, блокирует параллельный импорт, проверяет
  counts/statuses до commit и останавливается на неизвестных JSON-полях.
- [x] Прогнать схему и импорт на реальном временном PostgreSQL 14.
- [x] Сделать read-only инструмент обратного чтения и полевого сравнения JSON
  с PostgreSQL; временный интеграционный тест включает эту проверку.
- [x] Прогнать импорт и полевое сравнение на свежей read-only копии реального
  prod `data/db.json`, не подключая PostgreSQL к runtime приложения:
  2026-07-26, state version 912, 15 дат, 79 заявок, 35 групп, 37 связей
  участников и 20 отчетов наставников; паритет подтвержден.

### Этап C: чтение из Postgres на staging

- Переключить staging на чтение из Postgres.
- JSON оставить как backup/fallback.
- Прогнать полный QA.

### Этап D: запись в Postgres на staging

- Все команды `/api/state` переписать на транзакции Postgres.
- Добавить `application_events`.
- Добавить `notifications`.
- Добавить outbox worker.
- Прогнать полный QA.

### Этап E: production migration

- Остановить запись в prod на короткое окно.
- Сделать backup:
  - `data/db.json`;
  - git commit;
  - Docker config;
  - Postgres dump, если уже есть.
- Прогнать мигратор.
- Проверить counts и выборочные заявки.
- Запустить prod на Postgres.
- Проверить `/api/health`, `/api/state`, отчеты, реестр.
- Держать rollback-план на JSON-версию.

## 10. Что поручать Claude по UX/UI

Claude не должен менять backend-цепочку без отдельного согласования.

Для Claude давать только задачи:

- дизайн карточек;
- сетка и размеры;
- читаемость реестра;
- темная/светлая тема;
- Telegram WebView mobile;
- hover/tap/focus;
- состояния кнопок;
- переполнение текста;
- UX поиска/фильтров;
- визуальная иерархия.

Перед Claude обязательно дать:

- `docs/INTERNSHIP_WORKFLOW.md`;
- `docs/DATA_MODEL.md`;
- скриншоты проблем;
- запрет ломать статусы и API;
- требование Playwright/визуальной проверки.

Рекомендуемый промпт для Claude держать отдельно, когда начнется UX/UI этап.

## 11. Модель для работы

Для архитектуры, Postgres, миграций и backend-цепочки использовать сильную reasoning/coding модель.

Текущая рекомендация:

- архитектура и миграция: `GPT-5.6 Sol` (`gpt-5.6-sol` / alias `gpt-5.6`);
- точечные задачи и ревью: `GPT-5.6 Terra`, если нужно экономить;
- UX/UI дизайн-проработка: Claude Sonnet 5 или Opus 4.8, но только с жестким промптом и без самостоятельного изменения бизнес-логики.

## 12. Проверки перед любым prod deploy

Обязательно:

```bash
npm test
git diff --check
```

На сервере перед обновлением:

- сделать backup в `/opt/loft-hall-internship-unified/backups/...`;
- `git pull --ff-only`;
- `docker compose up -d --build`;
- проверить локальный health;
- проверить публичный health;
- проверить логи контейнера.

Не деплоить, если:

- есть непонятные изменения в `src/server.js`;
- изменились report chat ids без подтверждения;
- staging не проверен;
- тестовая версия отправляет реальные сообщения стажерам;
- миграция не имеет rollback-плана.

## 13. Open questions

Перед стартом Postgres нужно согласовать:

1. Оставляем ли Telegram-группы отчетов как основной архив отчетов или начинаем хранить полный текст отчетов в базе.
2. Нужна ли таблица наставников или пока достаточно логировать mentor Telegram user id.
3. Какой срок хранения персональных данных.
4. Нужна ли админка для рекрутеров/наставников или пока `.env`/DB руками.
5. Какой домен/порт закрепить за staging.
6. Нужно ли обезличивать prod-копию данных для staging или достаточно `SUPPRESS_TRAINEE_NOTIFICATIONS=yes`.
