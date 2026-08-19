# AI Searcher

Веб-сервис: один поисковый запрос отправляется в несколько ИИ-провайдеров; в ответе показывается текст каждой модели и **список ссылок**, извлечённых из ответа (URL в тексте и в Markdown `[текст](url)`).

## Возможности

- Ввод запроса на естественном языке (например, подбор SEO-агентств, сервисов, обзоров).
- **Пакет запросов:** в поле ввода **список** — каждая непустая строка это отдельный запрос (до 120 строк).
- **Экспорт в Excel** (`.xlsx`): таблица с запросом, моделью, ошибкой, длительностью, токенами, текстом и ссылками.
- Выбор **всех настроенных** моделей или **отдельных** (чекбоксы в интерфейсе).
- Провайдеры: **ChatGPT**, **DeepSeek**, **Perplexity**, **Google Gemini**, **Алиса AI**, **Алиса в Поиске** (Yandex Search API GenSearch).
- Маршрутизация через **Polza.ai** (5 из 6 провайдеров одним ключом).
- Личный кабинет: баланс, история, API-ключи, балансы провайдеров.
- Админ-панель: управление пользователями, лимитами, аудит.
- Оплата через Robokassa.
- REST API для интеграций.

## Требования

- [Node.js](https://nodejs.org/) 18+ (рекомендуется актуальный LTS).
- PostgreSQL 14+.

## Установка

```bash
git clone https://github.com/zdanovichd/ai-searcher.git
cd ai-searcher
npm install
cp .env.example .env   # заполните переменные
```

## Запуск

```bash
npm start        # продакшен
npm run dev      # разработка (с авто-перезапуском)
```

Откройте [http://localhost:3847](http://localhost:3847).

## Продакшен

Развёрнуто на **Ubuntu + nginx + PM2**, HTTPS через Let's Encrypt.

- Сайт: [https://gpt.seo-performance.ru](https://gpt.seo-performance.ru)
- Ключи на сервере в `.env` (не коммитить).

Деплой:

```bash
./scripts/deploy-production.sh
```

## Настройка ключей

Все переменные описаны в `.env.example`. Основные:

| Переменная | Провайдер |
|------------|-----------|
| `POLZA_API_KEY` | Polza.ai (единый ключ на ChatGPT, DeepSeek, Perplexity, Gemini, Алиса AI) |
| `YANDEX_CLOUD_FOLDER_ID`, `YANDEX_CLOUD_API_KEY` | Алиса в Поиске (Search API, напрямую) |
| `DATABASE_URL` | PostgreSQL |
| `JWT_SECRET`, `APP_ENCRYPTION_KEY` | Авторизация и шифрование |

Файл `.env` не должен попадать в git (уже в `.gitignore`).

## HTTP API

Авторизация — заголовок `X-API-Key` или `Authorization: Bearer <ключ>`.

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| `POST` | `/api/query` | Поисковый запрос (один или пакет) |
| `POST` | `/api/query/stream` | Потоковый поиск (SSE) |
| `GET` | `/api/v1/providers` | Список провайдеров и их статус |
| `GET` | `/api/v1/balances` | Балансы провайдеров (Polza, Yandex и др.) |

### Swagger (OpenAPI)

- **Swagger UI:** [/api-docs/](https://gpt.seo-performance.ru/api-docs/)
- **Спецификация:** `/openapi.json`

### Пример

```bash
curl -sS -X POST "http://localhost:3847/api/query" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ВАШ_КЛЮЧ" \
  -d '{"query":"тест","providers":["all"]}'
```

## Структура проекта

```
├── server.js              # Express, маршруты API и раздача public/
├── openapi/               # openapi.json — контракт API (Swagger UI)
├── postman/               # Коллекция Postman
├── public/                # Статика: интерфейс, кабинет, админка
│   ├── admin/             # Админ-панель
│   ├── cabinet/           # Личный кабинет
│   ├── auth/              # Страницы авторизации
│   └── shared/            # Общие стили и утилиты
├── schema/                # init.sql — DDL PostgreSQL
├── scripts/               # Деплой, бэкап, CLI-утилиты
└── src/
    ├── providers.js       # Вызовы API провайдеров
    ├── searchService.js   # Оркестрация параллельных запросов
    ├── tokenUsage.js      # Нормализация usage
    ├── extractLinks.js    # Парсинг URL из ответа
    ├── auth/              # JWT, пароли, сессии, middleware
    ├── routes/            # Express-роуты (auth, cabinet, admin, payments)
    ├── services/          # Бизнес-логика (пользователи, баланс, лимиты, биллинг)
    └── utils/             # Общие утилиты
```

## Замечания по провайдерам

- **DeepSeek:** ошибка `402` — нехватка средств на счёте.
- **Gemini:** идентификаторы моделей меняются; при «model not found» задайте `GOOGLE_GEMINI_MODEL`.
- **Perplexity:** вызов идёт на `POST /v1/sonar`, модель по умолчанию — `sonar`.
- **`alice_search`:** GenSearch в Yandex Cloud (поиск + генеративный ответ), не скрейпинг yandex.ru.

## Лицензия

Проект приватный (`private` в `package.json`).
