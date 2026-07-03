# LOFT HALL — объединённая стажировка

Единый серверный Mini App для двух сценариев:

- запись кандидатов на стажировку: даты, очередь, кабинет рекрута, приглашения, Telegram-уведомления;
- отчёты стажёра и наставника: чек-листы, автосбор отчёта и отправка в нужную рабочую группу.

Главный экран находится на `/`, запись открывается кнопкой **Запись на стажировку** и маршрутом `/booking`.

## Что сохранено

- формат отчётов стажёра и наставника;
- серверная проверка `Telegram.WebApp.initData` перед отправкой отчёта;
- выбор группы отчёта только на backend: `trainee -> TRAINEE_CHAT_ID`, `mentor -> MENTOR_CHAT_ID`;
- функционал записи: даты, очередь, статусы кандидатов, приглашения, фото площадок, личные уведомления;
- хранение заявок и дат в `data/db.json`, а не в HTML.

## Переменные

```bash
cp .env.example .env
nano .env
```

```env
BOT_TOKEN=токен_бота_из_BotFather
TRAINEE_CHAT_ID=-100...
MENTOR_CHAT_ID=-100...        # в тестовой копии поставить ID тестовой группы
TELEGRAM_BOT_USERNAME=LOFT_HELPER_V2_BOT
RECRUITER_TELEGRAM_IDS=1294774551,6774493976,1711587497
DATA_DIR=./data
TELEGRAM_POLLING=no
INIT_DATA_TTL_SECONDS=86400
HOST=0.0.0.0
PORT=3000
```

`RECRUITER_TELEGRAM_IDS` — Telegram user ID пользователей, которым разрешён полный кабинет рекрута и запись общего state.

`TELEGRAM_POLLING=no` оставляем, если бот подключён к PuzzleBot. Для Web App-привязки Telegram кандидата polling не нужен.

## Локальная проверка

```bash
npm install
npm test
npm start
```

Проверки:

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/health
```

Прямое открытие `/` вне Telegram покажет экран доступа, потому что отчёты защищены `initData`. Маршрут `/booking` открывается как форма записи и при запуске с сервера получает состояние из `data/db.json`.

## Docker-копия

В этом проекте compose использует отдельный контейнер и порт, чтобы не конфликтовать с текущим рабочим приложением:

```bash
docker compose up -d --build
curl http://127.0.0.1:3500/api/health
```

Контейнер:

```text
loft-internship-unified
```

Порт на хосте:

```text
127.0.0.1:3500
```

## Безопасный порядок на сервере

1. Сделать архив/копию текущего рабочего проекта:

```bash
cp -a /opt/loft-hall-internship /opt/loft-hall-internship.backup-$(date +%Y%m%d-%H%M)
```

2. Поднять объединённый проект рядом, отдельной директорией:

```bash
git clone https://github.com/USERNAME/REPO.git /opt/loft-hall-internship-unified
cd /opt/loft-hall-internship-unified
cp .env.example .env
nano .env
```

3. В `.env` тестовой копии поставить новый `MENTOR_CHAT_ID` группы, куда должен приходить отчёт во время проверки.

4. Запустить тестовую копию. Если на сервере уже есть общий Caddy в сети
   `loft-hall-internship_default`, используйте override:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.proxy.yml up -d --build
curl http://127.0.0.1:3500/api/health
```

5. Добавить тестовый домен в общий Caddy, например:

```caddy
internship-copy.77.110.122.36.sslip.io {
    encode zstd gzip
    reverse_proxy loft-internship-unified:3000
}
```

6. Проверить запись, кабинет рекрута и отправку отчётов.

7. Только после проверки заменить рабочий проект или переключить reverse proxy на объединённый контейнер.

## PuzzleBot

Главная ссылка Mini App:

```text
https://ваш-домен/?registered_fio=lh_user_fio&old_fio=Fio_registr_in_bot&first_name=FIRST_NAME_TEXT&last_name=LAST_NAME_TEXT&username=USERNAME_TEXT&user_id=USER_ID_TEXT&categories=CATEGORIES_NAMES
```

Тест переменных:

```text
https://ваш-домен/puzzlebot-vars-test
```

Прямая ссылка на запись:

```text
https://ваш-домен/booking
```

## API

- `POST /api/auth/telegram` — проверка запуска через Telegram для отчётов.
- `GET /api/report/trainees` — список приглашённых стажёров для отчёта наставника.
- `POST /api/report` — отправка отчёта стажёра или наставника.
- `GET /api/state` — состояние записи с `version/updatedAt`; полный state отдаётся только рекрутерам из `RECRUITER_TELEGRAM_IDS`.
- `POST /api/state` — командное изменение state с `action` и `baseVersion`; устаревшая версия отклоняется `409 BOOKING_VERSION_CONFLICT`.
- `POST /api/telegram/link` — привязка заявки к Telegram user id.
- `POST /api/notify` — личное уведомление кандидата.
- `GET /api/health` и `GET /health` — health check.
