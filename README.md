# AI Searcher

Локальный веб-сервис: один поисковый запрос отправляется в несколько ИИ-провайдеров; в ответе показывается текст каждой модели и **список ссылок**, извлечённых из ответа (URL в тексте и в Markdown `[текст](url)`).

## Возможности

- Ввод запроса на естественном языке (например, подбор SEO-агентств, сервисов, обзоров).
- Выбор **всех настроенных** моделей или **отдельных** (чекбоксы в интерфейсе).
- Провайдеры: **ChatGPT** (OpenAI), **DeepSeek**, **Perplexity**, **Google Gemini**, **Алиса AI** (Yandex Cloud).
- REST API для интеграций.

## Требования

- [Node.js](https://nodejs.org/) 18+ (рекомендуется актуальный LTS).

## Установка

```bash
git clone https://github.com/zdanovichd/ai-searcher.git
cd ai-sercher
npm install
```

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

- `results[]` — для каждой модели: `id`, `label`, `text`, `links[]`, `durationMs`, при ошибке вызова — поле `error`.
- `skippedLabels` — человекочитаемые названия провайдеров без ключей в `.env`.

## Структура проекта

```
├── server.js           # Express, маршруты API и раздача public/
├── alice-ai.js         # Точка входа: импортирует server.js
├── public/             # Статика: интерфейс (HTML, CSS, JS)
└── src/
    ├── providers.js    # Вызовы API провайдеров
    ├── searchService.js
    ├── extractLinks.js # Парсинг URL из ответа
    └── prompt.js       # Общий системный промпт
```

## Замечания по провайдерам

- **DeepSeek:** ошибка `402` означает нехватку средств на счёте в [platform.deepseek.com](https://platform.deepseek.com).
- **Gemini:** идентификаторы моделей меняются; при ошибке «model not found» задайте рабочую модель в `GOOGLE_GEMINI_MODEL` или проверьте список:  
  `GET https://generativelanguage.googleapis.com/v1beta/models?key=ВАШ_КЛЮЧ`
- **Perplexity:** для актуального **Agent API** (Responses + пресеты) может потребоваться отдельная доработка `src/providers.js`; сейчас используется путь `chat.completions` с базой `https://api.perplexity.ai` и моделью по умолчанию `sonar`.

## Лицензия

Проект приватный (`private` в `package.json`); уточните лицензию при публикации.
