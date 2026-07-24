# Progress — BilimHub

**Last updated:** 2026-07-24 22:40

## Current Task
Код перенесён в Daniyar51/learning_Nurzhan (remote `nurzhan`, вся история,
3 ветки). Старый daniyar3348/math (`origin`) оставлен нетронутым.
Ожидание: пользователь применяет render.yaml на render.com.

ВАЖНО про пуши: аккаунт Daniyar51 ≠ daniyar3348 (под которым авторизован gh).
Доступ выдан приглашением collaborator (Write), принято через
`gh api -X PATCH /user/repository_invitations/<id>`. Пушить: `git push nurzhan main`.

## Completed
- **P0–P2** — инфраструктура (Postgres 16 docker :5433, Prisma 7 driver-adapter),
  auth (argon2id, OTP c SmsProvider, TOTP, ротация refresh + reuse-детекция),
  RBAC, i18n kk/ru, движок тестов (10 типов, частичный балл, снимок раскладки,
  идемпотентный finalize, ручная проверка, диагностика), баллы/лидерборд с
  tie-break, MockPayment + идемпотентный webhook, все публичные API.
- **P3** — публичный сайт (лендинг §6, каталоги с URL-фильтрами, карточки),
  кабинеты ученика/преподавателя/родителя, прохождение теста (серверный таймер,
  автосейв+resume, навигация, авто-сдача), результат с диагностикой, оплата mock,
  сертификаты.
- **P4** — админка: dashboard (метрики+график 30 дней), generic CRUD
  (lib/admin-resources + AdminTable: поиск/фильтры/сортировка/массовые/CSV/URL),
  редактор вопросов всех 10 типов + CSV импорт/экспорт, конструктор тестов
  (секции, банк, random-выборки), челленджи, курсы (+структура: модули/уроки/
  задания/объявления), пользователи (роли/сброс/блок/связь родителя), группы,
  таксономия, записи, баллы (ручная корректировка с обязательным комментарием),
  платежи (grant), отзывы, файлы, уведомления, аудит, настройки (бренд/цвета/
  контакты/hero/FAQ).
- **P5** — тесты и финал:
  - vitest 45: grade-движок (все типы+граничные), TOTP (векторы RFC 6238),
    безопасный Markdown, integration в отдельной PG-схеме (attempt lifecycle,
    двойной finalize, clamp ручной оценки, идемпотентные баллы, лимит попыток,
    i18n-гейт, tie-break лидерборда, платёжный webhook).
  - Playwright 18: золотой путь §18 (админ UI: вопрос→тест→челлендж→публикация;
    ученик OTP-регистрация→участие→прохождение→результат+баллы; админ видит
    начисление), ручная проверка эссе, RBAC (ученик/учитель/гость),
    язык-свитч, фильтры, axe WCAG-AA. Оба прогона re-runnable.
  - Найдено и исправлено тестами: publishedAt на Question (P2002-класс бага),
    потеря debounce-ответа при быстром «Завершить» (flush в finish),
    TEACHER имел users.read (снят), ротация refresh в RSC (D-013 peek-режим),
    контраст вкладок логина, изоляция тестовой схемы (adapter {schema}).
  - Docs §20: README (полный), architecture, data-model (Mermaid ER×3), rbac,
    test-engine, i18n, deployment, openapi.yaml, decisions (13 ADR).
  - Dockerfile + .env.docker.example + .dockerignore; postinstall prisma generate;
    .gitignore: /lib/generated, !.env.example.
  - Гейты: lint 0, typecheck 0, build ✓, 45 unit + 18 e2e ✓; браузерная
    проверка лендинга и dashboard ✓.

## Verified Working
`pnpm lint` / `typecheck` / `build` / `test` (45) / `test:e2e` (18) — все чисто.
Сид-аккаунты: admin/teacher/parent@bilimhub.local (Bilim2026!), ученик +77000000001 (OTP).

## Render — готово
- render.yaml: web (runtime docker, plan free, region frankfurt, healthCheckPath
  /api/healthz) + managed PostgreSQL free; DATABASE_URL подставляется fromDatabase,
  APP_SECRET/CRON_SECRET — generateValue.
- FILE_STORAGE=db (ФС контейнера эфемерна) и JOBS_INLINE=1 (free-инстанс засыпает).
- Проверено локально: контейнер слушает PORT из окружения (запуск с PORT=10000 →
  healthz 200), значит health-check Render пройдёт.
- Наполнение: DATABASE_URL=<External Database URL> SEED_PASSWORD=... pnpm db:seed.
- Бесплатная БД Render временная → при истечении дамп в Neon, меняется только DATABASE_URL.

## Serverless (Vercel + Neon) — тоже готово в коде
- Argon2id → WASM (hash-wasm): нативных модулей нет; старые PHC-хэши проверяются
  (тест tests/unit/passwords.test.ts с реальным хэшем от нативной реализации).
  Проверено и в Alpine-контейнере: вход админа 200.
- FILE_STORAGE=db → байты в FileAsset.data (миграция 20260724200657, аддитивная);
  round-trip проверен скриптом. disk остаётся дефолтом для Docker.
- Рейтинг: enqueueLeaderboardRecompute стал async и на VERCEL/JOBS_INLINE считает
  в запросе; /api/cron/leaderboard (CRON_SECRET) + vercel.json crons — страховка.
- vercel-build = prisma migrate deploy && next build.
- Сид отказывается наполнять нелокальную БД без SEED_PASSWORD (проверено).
- Инструкция: docs/deployment.md → «Вариант A — Vercel + Neon», ADR D-014.
- Секреты, выданные пользователю для env Vercel: APP_SECRET 79aefa65…, CRON_SECRET 01fa3689…

## Notes for Resume
- Docker-образ собран и проверен целиком (compose --profile app): migrate deploy на старте,
  next start в production-режиме, CSP/логин админа/казахский SSR подтверждены curl'ом
  и в браузере; найден и исправлен env-less build (фолбэк DATABASE_URL в lib/db.ts),
  CMD переведён на прямые бинарники (без corepack в рантайме), packageManager закреплён.
- Dev-БД пересоздана 2026-07-24 (схема public была затёрта интеграционными
  тестами до фикса изоляции) — восстановлена migrate deploy + db:seed.
- Тестовая изоляция: DATABASE_URL_TEST `?schema=test` теперь честно работает
  через PrismaPg({...}, {schema}) в lib/db.ts.
- E2E чистит RateEvent в global-setup (иначе OTP-лимит 5/мин ломает повторные прогоны).
