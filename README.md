# AI Searcher

Локальный веб-сервис: один поисковый запрос отправляется в несколько ИИ-провайдеров; в ответе показывается текст каждой модели и **список ссылок**, извлечённых из ответа (URL в тексте и в Markdown `[текст](url)`).

## Возможности

- Ввод запроса на естественном языке (например, подбор SEO-агентств, сервисов, обзоров).
- Выбор **всех настроенных** моделей или **отдельных** (чекбоксы в интерфейсе).
- Провайдеры: **ChatGPT** (OpenAI), **DeepSeek**, **Perplexity**, **Google Gemini**, **Алиса AI** (Yandex Cloud).
- REST API для интеграций.

## Индексация поисковиками

Сайт **не предназначен** для выдачи в поиске: `public/robots.txt` (`Disallow: /`), в HTML — `<meta name="robots" content="noindex, nofollow">`, для всех ответов Express выставляется заголовок **`X-Robots-Tag: noindex, nofollow`**. Это снижает вероятность индексации, но не гарантирует её на 100% (боты могут игнорировать правила).

## Требования

- [Node.js](https://nodejs.org/) 18+ (рекомендуется актуальный LTS).

## Установка

```bash
git clone https://github.com/zdanovichd/ai-searcher.git
cd ai-searcher
npm install
```

## Продакшен (gpt.seo-performance.ru)

Развёрнуто на **Ubuntu + nginx + PM2**: приложение в `/var/www/gpt`, прокси на порт **3847**, HTTPS через Let’s Encrypt.

- Сайт: [https://gpt.seo-performance.ru](https://gpt.seo-performance.ru)
- На сервере должны лежать ключи в **`/var/www/gpt/.env`** (не коммитить).

Повторная выгрузка с локальной машины (из корня репозитория):

```bash
chmod +x scripts/deploy-production.sh
./scripts/deploy-production.sh
```

Или вручную: `ssh root@85.198.69.22`, затем `cd /var/www/gpt && git pull` / `rsync` и `pm2 restart ai-searcher`.

Удобный SSH-алиас (в `~/.ssh/config`):

```sshconfig
Host seo-performance gpt-server
  HostName 85.198.69.22
  User root
```

Подключение: `ssh seo-performance`.

## Настройка ключей

Скопируйте шаблон и заполните переменные:

```bash
cp .env.example .env
```

| Переменная | Провайдер |
|------------|-----------|
| `OPENAI_API_KEY` | ChatGPT |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `PERPLEXITY_API_KEY` | Perplexity ([консоль API](https://console.perplexity.ai/)) |
| `GOOGLE_AI_API_KEY` | Gemini ([Google AI Studio](https://aistudio.google.com/apikey)) |
| `YANDEX_CLOUD_FOLDER_ID`, `YANDEX_CLOUD_API_KEY` | Алиса AI |
| `YANDEX_CLOUD_MODEL` | Опционально, по умолчанию `aliceai-llm/latest` |

Дополнительно (необязательно):

- `OPENAI_MODEL` — по умолчанию `gpt-4o-mini`
- `DEEPSEEK_MODEL` — по умолчанию `deepseek-chat`
- `PERPLEXITY_MODEL` — по умолчанию `sonar`
- `GOOGLE_GEMINI_MODEL` — если не задано, используется цепочка моделей (`gemini-2.5-flash`, затем запасные варианты)
- `PORT` — порт HTTP-сервера (по умолчанию `3847`)

Файл `.env` не должен попадать в git (уже в `.gitignore`).

## Запуск

```bash
npm start
```

Откройте в браузере: [http://localhost:3847](http://localhost:3847) (или `http://localhost:$PORT`).

То же самое поднимает `node alice-ai.js`.

## HTTP API

### `GET /api/meta`

Список провайдеров и флаг, задан ли для каждого ключ в `.env`.

**Ответ:** `{ "providers": [ { "id", "label", "configured" }, ... ] }`

### `POST /api/query`

**Тело (JSON):**

```json
{
  "query": "лучшее SEO-агентство в Москве",
  "providers": ["all"]
}
```

- `query` — строка, 1…8000 символов.
- `providers` — массив из `["all"]` или идентификаторов: `chatgpt`, `deepseek`, `perplexity`, `google`, `alice`. Пустой или некорректный массив трактуется как `["all"]`.

**Успешный ответ:** `{ "results", "skippedLabels", "error": null }`

- `results[]` — для каждой модели: `id`, `label`, `text`, `links[]`, `durationMs`, при успехе — `usage`: `{ input, output, total }` (токены prompt / completion / всего за **этот** запрос; остаток квоты API не возвращается), при ошибке — поле `error`.
- `skippedLabels` — человекочитаемые названия провайдеров без ключей в `.env`.

## Где в API смотреть токены (официально)

В интерфейсе мы показываем `usage.input` / `usage.output` / `usage.total`. Откуда это берётся у каждого провайдера:

| Провайдер | Где в ответе | Документация |
|-----------|----------------|--------------|
| **ChatGPT** (OpenAI) | Объект **`usage`**: `prompt_tokens`, `completion_tokens`, `total_tokens` | [Chat Completions — response](https://platform.openai.com/docs/api-reference/chat/object) |
| **DeepSeek** | Как у OpenAI: **`usage`** в JSON ответа `POST /chat/completions` | [Create chat completion](https://api-docs.deepseek.com/api/create-chat-completion) |
| **Perplexity** | **`usage`** в ответе **`POST /v1/sonar`** (`prompt_tokens`, `completion_tokens`, `total_tokens`, плюс свои поля вроде `cost`) | [Sonar / chat completions](https://docs.perplexity.ai/api-reference/chat-completions-post) |
| **Gemini** | **`usageMetadata`**: `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount` | [generateContent — ответ](https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse) |
| **Алиса** (Yandex, OpenAI-compatible Responses) | **`usage`**: `input_tokens`, `output_tokens`, `total_tokens` (как у OpenAI Responses API) | [OpenAI Responses — usage](https://platform.openai.com/docs/api-reference/responses/object#responses/object-usage) (совместимый контракт) |

**Лимиты и деньги** по ключу (остаток квоты, баланс) смотрите в **консолях биллинга** провайдера — в теле одного запроса это обычно не приходит.

В коде разбор унифицирован в `src/tokenUsage.js` (разные имена полей сводятся к одному виду).

**Реализация:** ChatGPT, DeepSeek, Perplexity и Yandex Алиса вызываются через **`fetch` + сырой JSON** (не OpenAI SDK), чтобы в ответе гарантированно читать `usage` так, как отдаёт провайдер. У Gemini по-прежнему `generateContent` по REST.

## Почему 403 (ChatGPT, Gemini, Алиса)

- **OpenAI:** запрет по **геолокации IP** сервера («Country, region, or territory not supported»). Часто при VPS в РФ и ряде других регионов. Нужен исходящий трафик из поддерживаемой зоны (другой хостинг, прокси) или вызов API не с этого IP.
- **Google Gemini (AI Studio):** аналогично — **«User location is not supported»** завязан на регион запроса; с IP РФ запрос с сервера часто отклоняется. Варианты: инфраструктура в поддерживаемом регионе, **Vertex AI** в GCP, прокси.
- **Yandex Алиса:** `403 Forbidden` чаще про **права и ключ**: роль `ai.languageModels.user`, верный каталог в `YANDEX_CLOUD_FOLDER_ID`, неистёкший API-ключ, доступ к модели в каталоге. Иногда политика облака к иностранным IP — уточняйте в документации Yandex Cloud.

## Структура проекта

```
├── server.js           # Express, маршруты API и раздача public/
├── alice-ai.js         # Точка входа: импортирует server.js
├── public/             # Статика: интерфейс (HTML, CSS, JS)
└── src/
    ├── providers.js    # Вызовы API провайдеров
    ├── searchService.js
    ├── tokenUsage.js   # Нормализация usage из разных форматов ответов
    ├── extractLinks.js # Парсинг URL из ответа
    └── prompt.js       # Общий системный промпт
```

## Замечания по провайдерам

- **DeepSeek:** ошибка `402` означает нехватку средств на счёте в [platform.deepseek.com](https://platform.deepseek.com).
- **Gemini:** идентификаторы моделей меняются; при ошибке «model not found» задайте рабочую модель в `GOOGLE_GEMINI_MODEL` или проверьте список:  
  `GET https://generativelanguage.googleapis.com/v1beta/models?key=ВАШ_КЛЮЧ`
- **Perplexity:** вызов идёт на официальный **`POST /v1/sonar`** (не `/v1/chat/completions`), чтобы в ответе был блок **`usage`** с токенами. Модель по умолчанию — `sonar`, переопределение — `PERPLEXITY_MODEL`.

## Лицензия

Проект приватный (`private` в `package.json`); уточните лицензию при публикации.
