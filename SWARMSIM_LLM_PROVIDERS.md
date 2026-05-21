# SwarmSim — локальные LLM и абстракция провайдеров

> **Навигация по документам:**
> - [SWARMSIM_PROJECT.md](SWARMSIM_PROJECT.md) — что за продукт и какую проблему решает
> - [SWARMSIM_ARCHITECTURE.md](SWARMSIM_ARCHITECTURE.md) — архитектура, схема БД, пошаговый план, глоссарий AI-терминов
> - [SWARMSIM_DEEPDIVE.md](SWARMSIM_DEEPDIVE.md) — код-уровень детали Go-симулятора и ReACT-агента
> - **SWARMSIM_LLM_PROVIDERS.md** *(этот документ)* — локальная LLM (Ollama) и абстракция провайдеров

Как дешевле разрабатывать и как не привязаться к одному вендору.

---

## 1. Проблема стоимости

Базовая прикидка для разработки симуляции:
- 1 агент × 1 раунд = ~1 LLM-вызов (~500 токенов input + 150 output)
- 20 агентов × 20 раундов = 400 вызовов на прогон
- На GPT-4o это ~$0.5–1.5 за один прогон
- При разработке ты будешь запускать симуляции десятки раз в день
- Плюс ReACT-агент делает 10–20 итераций по $0.05 = ~$0.5–1 за отчёт

**Итого при активной разработке:** $15–50/день на OpenAI. За месяц набежит заметно.

Решение: **локальная LLM для разработки, облачная для прода и финальных демо**.

---

## 2. Локальные LLM — варианты

### Ollama
**Запуск:**
```bash
brew install ollama
ollama serve                    # демон
ollama pull qwen2.5:7b         # скачать модель
ollama run qwen2.5:7b          # проверить в консоли
```

**Использование через OpenAI SDK:**
```typescript
const openai = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',  // Ollama не проверяет, но SDK требует непустое
});
// Всё остальное — как с настоящим OpenAI
```

### Альтернативы

- **LM Studio** — с GUI, удобно мониторить. Под капотом тот же llama.cpp. Тоже OpenAI-compatible.
- **vLLM** — production-grade, для мощных GPU. Для проекта избыточен.
- **llama.cpp server** — базовый, если хочется минимализма.

---

## 3. Какие модели выбрать

**Критично для SwarmSim:** модель должна хорошо поддерживать **tool calling** (function calling). На этом держится и симуляция, и ReACT-агент.

### Рекомендации

| Модель | Размер | Tool calling | Для чего в SwarmSim |
|---|---|---|---|
| **Qwen2.5 7B** | 4.7GB | ✅ Отличный | Симуляционные агенты, онтология |
| **Qwen2.5 14B** | 9GB | ✅ Отличный | Всё то же, но умнее (если ресурсы позволяют) |
| **Llama 3.1 8B** | 4.7GB | 🟡 Средний | Fallback если Qwen не нравится |
| **DeepSeek-R1-distill 7B** | 4.7GB | 🟡 Слабый | Хорош для рассуждения, не для tool calling |
| **Mistral Nemo** | 7GB | ✅ Хороший | Альтернатива Qwen |

**Выбор для проекта:** `qwen2.5:7b` — соотношение качества и скорости, tool calling «из коробки» ведёт себя почти как GPT-4o-mini.

### Для эмбеддингов отдельная модель

Эмбеддинги считать локально — в разработке их много:

```bash
ollama pull nomic-embed-text     # 274MB, 768 dim
ollama pull mxbai-embed-large    # 670MB, 1024 dim
```

**Важно:** выбранная размерность должна совпадать с тем, что ты сохраняешь в pgvector. При смене — полный пересчёт всех эмбеддингов. **Для этого проекта: `vector(768)`** (nomic-embed-text).

### Практический совет

**Разработка:** Ollama + `qwen2.5:7b` + `nomic-embed-text`
**Продакшен / финальное демо:** OpenAI `gpt-4o-mini` + `text-embedding-3-small`

Для симуляционных агентов разницы в результатах почти нет — локальная модель справляется. Разница заметна в отчёте ReACT-агента: GPT-4o пишет более связные, глубокие отчёты.

---

## 4. OpenAI-compatible

| Провайдер | OpenAI-compatible? | baseURL |
|---|---|---|
| OpenAI | ✅ (оригинал) | `https://api.openai.com/v1` |
| **Ollama** (локальный) | ✅ | `http://localhost:11434/v1` |
| **Qwen / Alibaba DashScope** | ✅ | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| **DeepSeek** | ✅ | `https://api.deepseek.com/v1` |
| **Groq** (быстрый инференс) | ✅ | `https://api.groq.com/openai/v1` |
| **Together.ai** | ✅ | `https://api.together.xyz/v1` |
| **OpenRouter** (агрегатор) | ✅ | `https://openrouter.ai/api/v1` |
| Anthropic Claude | ❌ (свой API) | — |
| Google Gemini | 🟡 (preview OpenAI-compat) | — |

Для 90% случаев **достаточно одного OpenAI SDK** и подмены `baseURL`/`model`. Фабрика с отдельными классами провайдеров в случае добавления Claude/Gemini.

---

## 5. Дизайн абстракции

Два уровня:

### Уровень 1 (минимум): конфиг + OpenAI SDK

Для поддержки только OpenAI-compatible провайдеров — достаточно конфига (фабрики не нужны):

```typescript
// apps/api/src/llm/llm.config.ts
export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  models: {
    chat: string;           // 'qwen2.5:7b' или 'gpt-4o-mini'
    chatSmart: string;      // для ReACT: 'gpt-4o' или 'qwen2.5:14b'
    embedding: string;      // 'nomic-embed-text' или 'text-embedding-3-small'
  };
  embeddingDimensions: number;
}

// .env переключает профиль
LLM_PROFILE=local    # или openai, qwen, deepseek
```

```typescript
// llm.module.ts
@Module({
  providers: [
    {
      provide: OpenAI,
      useFactory: (config: ConfigService) => {
        const profile = config.get<LLMConfig>(`llm.${config.get('LLM_PROFILE')}`);
        return new OpenAI({
          baseURL: profile.baseURL,
          apiKey: profile.apiKey,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [OpenAI],
})
export class LlmModule {}
```

В коде `this.openai.chat.completions.create(...)`. Разница откуда пришел ответ нет.

### Уровень 2: честная абстракция провайдера

Нужна, если в случае использования Claude или Gemini так как у них другой API-формат.

```typescript
// apps/api/src/llm/provider.interface.ts
export interface LLMProvider {
  name: string;

  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncIterable<ChatChunk>;
  embed(text: string | string[]): Promise<number[][]>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: 'auto' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | { type: 'json_schema'; schema: JSONSchema };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'stop' | 'tool_use' | 'max_tokens' | 'other';
}
```

Этот интерфейс **не копирует OpenAI API 1-в-1**, а делает общий знаменатель всех провайдеров.

### Реализации

```typescript
// openai-compatible.provider.ts — покрывает OpenAI, Ollama, Qwen, DeepSeek, Groq
@Injectable()
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly client: OpenAI, readonly name: string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const resp = await this.client.chat.completions.create({
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      tools: req.tools?.map(toOpenAITool),
      tool_choice: req.toolChoice,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    });
    return fromOpenAIResponse(resp);
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const input = Array.isArray(text) ? text : [text];
    const resp = await this.client.embeddings.create({
      model: EMBEDDING_MODEL,
      input,
    });
    return resp.data.map(d => d.embedding);
  }
  // chatStream аналогично
}

// anthropic.provider.ts
@Injectable()
export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  constructor(private readonly client: Anthropic) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const resp = await this.client.messages.create({
      model: req.model,
      messages: req.messages.map(toAnthropicMessage),  // другой формат!
      tools: req.tools?.map(toAnthropicTool),           // другой формат!
      max_tokens: req.maxTokens ?? 4096,
    });
    return fromAnthropicResponse(resp);
  }

  async embed(): Promise<number[][]> {
    throw new Error('Anthropic не предоставляет embeddings API');
    // Для эмбеддингов держи отдельный провайдер (OpenAI/Ollama)
  }
}
```

### Фабрика

```typescript
// llm.factory.ts
@Injectable()
export class LLMFactory {
  private readonly providers = new Map<string, LLMProvider>();

  constructor(
    openai: OpenAICompatibleProvider,
    anthropic: AnthropicProvider,
    // ... другие
  ) {
    this.providers.set('openai', openai);
    this.providers.set('ollama', openai);       // тот же класс, другая конфигурация
    this.providers.set('qwen', openai);
    this.providers.set('anthropic', anthropic);
  }

  get(name?: string): LLMProvider {
    const key = name ?? process.env.LLM_PROVIDER ?? 'ollama';
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Unknown LLM provider: ${key}`);
    return provider;
  }
}
```

Использование:

```typescript
@Injectable()
export class ReactAgent {
  constructor(private readonly llm: LLMFactory) {}

  async run() {
    // По умолчанию берёт провайдер из env
    const response = await this.llm.get().chat({
      model: this.llm.get().name === 'ollama' ? 'qwen2.5:7b' : 'gpt-4o',
      messages: [...],
      tools: [...],
    });
  }
}
```

### Выбор модели при разных провайдерах

Удобный паттерн — **логические имена моделей** в конфиге, а не физические:

```yaml
# config.yaml
llm:
  profiles:
    local:
      provider: ollama
      baseURL: http://localhost:11434/v1
      models:
        fast:  qwen2.5:7b       # для агентов симуляции
        smart: qwen2.5:14b      # для ReACT
        embed: nomic-embed-text
    production:
      provider: openai
      baseURL: https://api.openai.com/v1
      models:
        fast:  gpt-4o-mini
        smart: gpt-4o
        embed: text-embedding-3-small
```

В коде тогда логические: `llm.chat({ model: config.models.fast, ... })`. Переключение профилей через env-переменную.

---

## 6. Аналогично для Go-симулятора

Интерфейс:

```go
// internal/llm/provider.go
type Provider interface {
    Name() string
    Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)
    Embed(ctx context.Context, texts []string) ([][]float32, error)
}

type ChatRequest struct {
    Model       string
    Messages    []Message
    Tools       []Tool
    ToolChoice  string
    Temperature float32
    MaxTokens   int
}

type ChatResponse struct {
    Content   string
    ToolCalls []ToolCall
    Usage     Usage
}
```

Реализация для OpenAI-compatible покрывает и Ollama:

```go
// internal/llm/openai_compatible.go
type OpenAICompatibleProvider struct {
    client *openai.Client
    name   string
}

func NewOpenAICompatibleProvider(baseURL, apiKey, name string) *OpenAICompatibleProvider {
    cfg := openai.DefaultConfig(apiKey)
    cfg.BaseURL = baseURL
    return &OpenAICompatibleProvider{
        client: openai.NewClientWithConfig(cfg),
        name:   name,
    }
}

func (p *OpenAICompatibleProvider) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
    // ... mapping ...
}
```

Фабрика на основе env:

```go
// internal/llm/factory.go
func NewFromEnv() (Provider, error) {
    profile := os.Getenv("LLM_PROFILE")
    switch profile {
    case "local", "":
        return NewOpenAICompatibleProvider(
            "http://localhost:11434/v1", "ollama", "local",
        ), nil
    case "openai":
        return NewOpenAICompatibleProvider(
            "https://api.openai.com/v1", os.Getenv("OPENAI_API_KEY"), "openai",
        ), nil
    case "qwen":
        return NewOpenAICompatibleProvider(
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            os.Getenv("QWEN_API_KEY"), "qwen",
        ), nil
    default:
        return nil, fmt.Errorf("unknown profile: %s", profile)
    }
}
```

---

## 7. Сетап разработки

**#1:**
```bash
# Устанавливаешь Ollama
brew install ollama
ollama serve &

# Качаешь модели
ollama pull qwen2.5:7b
ollama pull nomic-embed-text

# В .env проекта
LLM_PROFILE=local
```

**Что работает сразу:**
- Онтология — `qwen2.5:7b` справляется отлично
- Извлечение сущностей — тоже
- Симуляционные агенты — tool calling работает
- Эмбеддинги — через `nomic-embed-text` (не забудь `vector(768)` в pgvector)

**API нужен для:**
- Финальный отчёт ReACT-агента (качество заметно выше на GPT-4o/Claude)
- Демо
- Обкатка production-режима перед релизом

---

## 8. Gotchas с локальными LLM

1. **Контекстное окно меньше.** Qwen2.5 7B — 128k (неплохо), но если грузить несколько PDF сразу в онтологию — может не влезть. Нужно разбивать на чанки.

2. **Tool calling «подтекает».** Локальные модели иногда вместо `tool_call` возвращают текст типа «я вызову функцию create_post с аргументом...». Обрабатывай: если `tool_calls` пустой, но в тексте похоже на вызов — парсить вручную или ретрай.

3. **JSON-режим не всегда работает идеально.** OpenAI `response_format: json_object` гарантирован. На Ollama — best effort. Нужна валидация результата через `zod` к примеру.

4. **Скорость.** На M1/M2 Mac с 16GB qwen2.5:7b даёт ~30-50 токенов/сек. Симуляция 20 агентов × 20 раундов ≈ 15-30 минут. Для сравнения GPT-4o-mini — минуты. Для разработки ok, для демо — лучше API.

5. **Параллельные запросы.** Ollama обрабатывает запросы последовательно по умолчанию. Для параллельности есть `OLLAMA_NUM_PARALLEL=4`. Это важно для Go-симулятора с worker pool.

6. **Память.** `qwen2.5:7b` ест ~5-6GB. `14b` — ~10GB. .

---

## 9. Чек-лист по шагам

- [ ] Установить Ollama, скачать `qwen2.5:7b` и `nomic-embed-text`
- [ ] Выбрать и зафиксировать размерность эмбеддингов (рекомендую 768 — поменьше, побыстрее)
- [ ] Создать `LLMConfig` с профилями `local` и `openai`
- [ ] Реализовать для NestJS: `LlmModule` с инъекцией `OpenAI` через фабрику на основе профиля
- [ ] Реализовать для Go: `llm.NewFromEnv()`
- [ ] Установить env-переменную `LLM_PROFILE=local` в dev-окружении
- [ ] При необходимости Claude/Gemini — добавить `LLMProvider` интерфейс и отдельные имплементации
- [ ] В README проекта задокументировать как переключаться между профилями

---

## Резюме

1. Для разработки — **Ollama + qwen2.5:7b + nomic-embed-text**. Бесплатно, локально, tool calling работает.
2. OpenAI-compatible API покрывает **большинство провайдеров** (OpenAI, Ollama, Qwen, DeepSeek, Groq) — хватит одного SDK с разным `baseURL`.
3. **Фабрика нужна только для Claude/Gemini** — у них свой API. Не усложняй если они тебе не нужны.
4. **Логические имена моделей** в конфиге (`fast`/`smart`/`embed`) вместо физических — переключение профиля одной env-переменной.
5. В продакшене/финальном демо — включаешь `LLM_PROFILE=openai`, остальное работает без изменений в коде.
