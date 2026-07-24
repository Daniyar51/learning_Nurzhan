# Деплой

## Вариант A — Vercel + Neon (бесплатный публичный стенд)

Neon даёт управляемый PostgreSQL, Vercel — хостинг Next.js. Репозиторий уже
подготовлен: сборка на Vercel идёт скриптом `vercel-build`
(`prisma migrate deploy && next build`), поэтому миграции применяются
автоматически при каждом деплое.

1. **База.** На neon.tech создать проект (регион ближе к пользователям).
   Скопировать **pooled** строку подключения — вида
   `postgresql://…-pooler.…neon.tech/neondb?sslmode=require`.
2. **Проект.** На vercel.com импортировать репозиторий с GitHub. Framework
   определится как Next.js, команды менять не нужно.
3. **Переменные окружения** (Project → Settings → Environment Variables):

   | Переменная | Значение |
   |---|---|
   | `DATABASE_URL` | pooled-строка Neon |
   | `APP_SECRET` | длинная случайная строка (`openssl rand -hex 32`) |
   | `FILE_STORAGE` | `db` — на Vercel файловая система только для чтения |
   | `PAYMENT_PROVIDER` | `mock` |
   | `SMS_PROVIDER` | `http` (+ `SMS_HTTP_URL`, `SMS_HTTP_TOKEN`) или `dev` для демо |
   | `CRON_SECRET` | случайная строка; без неё `/api/cron/leaderboard` закрыт |
   | `TZ` | `Asia/Almaty` |

4. **Первое наполнение.** Аккаунты и демо-контент создаются с локальной машины
   — со **своим** паролем (иначе на публичном сайте окажется пароль из README,
   сид это проверяет и откажется работать):

   ```bash
   DATABASE_URL="<pooled-строка Neon>" SEED_PASSWORD="ВашСложныйПароль" pnpm db:seed
   ```

5. **Проверка.** `https://<проект>.vercel.app/api/healthz` → `{"ok":true}`,
   затем вход в `/admin` под `admin@bilimhub.local` с заданным паролем.

Особенности платформы, уже учтённые в коде:

- **Файлы** — при `FILE_STORAGE=db` байты лежат в таблице `FileAsset`, отдача
  идёт через `/api/files/[id]` с подписанной ссылкой (интерфейс не изменился).
  Для больших объёмов подключается S3-драйвер.
- **Фоновые задачи** — на Vercel процесс может завершиться сразу после ответа,
  поэтому пересчёт рейтинга выполняется внутри запроса; ночной cron
  (`vercel.json`) перестраховывает.
- **Пароли** — Argon2id считается в WebAssembly, нативные модули не нужны.
- **SMS в демо-режиме.** `SMS_PROVIDER=dev` показывает код входа прямо на
  странице — это удобно для показа, но означает, что войти под чужим номером
  может любой. Для реальных учеников подключайте `http`-провайдер.

## Вариант B — Docker Compose (одна машина)

```bash
cp .env.docker.example .env.docker     # задать APP_SECRET, пароль БД
docker compose --profile app up -d --build
```

Образ собирается из [Dockerfile](../Dockerfile); при старте контейнер выполняет
`prisma migrate deploy` и поднимает `next start` на `:3000`. Файлы пользователей
живут в volume `uploads`, данные БД — в `pg_data`.

Сид демо-данных в production не выполняется (защита в seed.ts). Первого
администратора создайте вручную:

```bash
docker compose exec app node -e "
const argon2=require('argon2');
(async()=>{ console.log(await argon2.hash(process.argv[1],{type:argon2.argon2id})); })()
" 'ВашПароль'
# полученный хэш → INSERT в User/Membership через psql, либо временно
# запустите сид локально и перенесите дампом только справочники.
```

## Вариант B — без Docker (systemd/PM2 + управляемый PostgreSQL)

```bash
pnpm install --frozen-lockfile
pnpm db:deploy
pnpm build
NODE_ENV=production pnpm start   # PORT=3000
```

Перед приложением — обратный прокси (Caddy/Nginx) с TLS; cookie уже
`Secure/SameSite`, security-заголовки и CSP выставляет middleware.

## Секреты и окружение

- Все секреты — только через env (`.env` не коммитится; в репозитории —
  `.env.example` без реальных значений).
- `APP_SECRET` — длинная случайная строка; подписывает файловые ссылки и
  webhook мока платежей.
- `SMS_PROVIDER=http` + `SMS_HTTP_URL`/`SMS_HTTP_TOKEN` — подключение боевого
  SMS-шлюза (dev-провайдер в production бросает ошибку).
- `PAYMENT_PROVIDER`: реальный провайдер реализуется классом `PaymentProvider`
  ([lib/payments.ts](../lib/payments.ts)) — интерфейс checkout + идемпотентный
  webhook уже готовы; платёжные ключи в репозиторий не попадают.

## Миграции

- Продакшен: только `pnpm db:deploy` (без интерактива, без потери данных).
- Новая миграция создаётся в разработке `pnpm db:migrate` и коммитится в
  `prisma/migrations/`.

## Бэкапы

```bash
# ежедневный дамп (cron)
docker exec learning_platform-db-1 pg_dump -U bilimhub -Fc bilimhub \
  > /backups/bilimhub_$(date +%F).dump
# восстановление
docker exec -i learning_platform-db-1 pg_restore -U bilimhub -d bilimhub --clean < dump
```

Каталог загрузок (`uploads`) бэкапится файлово (rsync/tar) вместе с дампом БД.

## Health и логи

- `GET /api/healthz` — проверка приложения и БД (для балансировщика/monit).
- Логи — stdout контейнера (`docker compose logs -f app`); ошибки API пишутся
  единым обработчиком, журнал входов и действий — в БД (LoginEvent, AuditLog).
