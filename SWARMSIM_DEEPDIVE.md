# SwarmSim — детали реализации Go-Simulator и ReACT-агента

> **Навигация по документам:**
> - [SWARMSIM_PROJECT.md](SWARMSIM_PROJECT.md) — что за продукт и какую проблему решает
> - [SWARMSIM_ARCHITECTURE.md](SWARMSIM_ARCHITECTURE.md) — архитектура, схема БД, пошаговый план, глоссарий AI-терминов
> - **SWARMSIM_DEEPDIVE.md** *(этот документ)* — код-уровень детали Go-симулятора и ReACT-агента
> - [SWARMSIM_LLM_PROVIDERS.md](SWARMSIM_LLM_PROVIDERS.md) — локальная LLM (Ollama) и абстракция провайдеров

Продолжение [SWARMSIM_ARCHITECTURE.md](SWARMSIM_ARCHITECTURE.md). Здесь — код-уровень деталей для двух самых сложных компонентов. LLM-клиент (`llm.Client` в Go и `OpenAI` в NestJS) везде подразумевается из абстракции, описанной в [SWARMSIM_LLM_PROVIDERS.md](SWARMSIM_LLM_PROVIDERS.md).

---

# Часть A. Go-Simulator

## A.1 Структура проекта

```
apps/simulator/
├── cmd/
│   └── server/
│       └── main.go              # точка входа
├── internal/
│   ├── api/                     # HTTP-хендлеры
│   │   ├── router.go
│   │   ├── simulate.go
│   │   └── health.go
│   ├── engine/                  # ядро симуляции
│   │   ├── engine.go            # SimulationEngine
│   │   ├── agent.go             # тип Agent и его логика
│   │   ├── round.go             # логика одного раунда
│   │   ├── feed.go              # формирование ленты
│   │   └── worker_pool.go       # параллельное выполнение
│   ├── llm/
│   │   ├── client.go            # обёртка над OpenAI
│   │   ├── prompts.go           # шаблоны промптов
│   │   └── rate_limiter.go
│   ├── storage/
│   │   ├── postgres.go          # подключение
│   │   ├── actions.go           # запись действий
│   │   ├── rounds.go
│   │   └── agents.go            # загрузка профилей
│   ├── config/
│   │   └── config.go            # env-переменные
│   └── logger/
│       └── jsonl.go             # JSONL-лог раундов
├── go.mod
├── go.sum
└── Dockerfile
```

## A.2 Основные типы

```go
// internal/engine/agent.go
package engine

import "time"

type Agent struct {
    ID          string            // совпадает с agent_profiles.id
    Name        string
    Biography   string            // текст для system-промпта
    Personality string
    Interests   []string
    Following   []string          // IDs других агентов
    Followers   []string

    // Состояние в рамках симуляции
    RecentFeed  []Action          // последние N действий от подписок
    MyActions   []Action          // что сам делал (короткая память)
}

type ActionType string

const (
    ActionPost    ActionType = "post"
    ActionReply   ActionType = "reply"
    ActionLike    ActionType = "like"
    ActionRepost  ActionType = "repost"
    ActionFollow  ActionType = "follow"
    ActionSkip    ActionType = "skip"   // "сегодня молчу"
)

type Action struct {
    ID             string
    SimulationID   string
    RoundID        string
    AgentID        string
    Type           ActionType
    Content        string      // текст поста или реплая
    TargetActionID *string     // для reply/like/repost
    CreatedAt      time.Time
    VirtualTime    time.Time   // время "внутри" симуляции
}

// internal/engine/engine.go
type SimulationEngine struct {
    simulationID  string
    config        SimulationConfig
    agents        map[string]*Agent
    llm           *llm.Client
    storage       *storage.Store
    logger        *logger.JSONL

    mu            sync.RWMutex   // защищает agents и feeds
    currentRound  int
    cancelCtx     context.Context
    cancelFn      context.CancelFunc
}

type SimulationConfig struct {
    TotalRounds       int           `json:"total_rounds"`
    RoundDuration     time.Duration `json:"round_duration"`      // виртуальное время между раундами
    TriggerEvent      string        `json:"trigger_event"`       // начальный пост
    TriggerAuthorID   string        `json:"trigger_author_id"`
    MaxConcurrentLLM  int           `json:"max_concurrent_llm"`  // 10-20
    FeedSize          int           `json:"feed_size"`           // последних N действий
}
```

## A.3 Главный цикл симуляции

```go
// internal/engine/engine.go
func (e *SimulationEngine) Run(ctx context.Context) error {
    e.cancelCtx, e.cancelFn = context.WithCancel(ctx)
    defer e.cancelFn()

    // Шаг 1: опубликовать триггерное событие
    if err := e.publishTrigger(); err != nil {
        return fmt.Errorf("publish trigger: %w", err)
    }

    // Шаг 2: цикл раундов
    for roundNum := 1; roundNum <= e.config.TotalRounds; roundNum++ {
        select {
        case <-e.cancelCtx.Done():
            return e.cancelCtx.Err()
        default:
        }

        if err := e.runRound(roundNum); err != nil {
            log.Printf("round %d failed: %v", roundNum, err)
            // Продолжаем — один упавший раунд не должен ронять всё
        }
    }

    return nil
}

func (e *SimulationEngine) runRound(roundNum int) error {
    roundID, err := e.storage.CreateRound(e.simulationID, roundNum)
    if err != nil {
        return err
    }

    // Worker pool: N одновременных LLM-вызовов
    pool := NewWorkerPool(e.config.MaxConcurrentLLM)
    actionsChan := make(chan Action, len(e.agents))

    // Все агенты работают параллельно
    for _, agent := range e.agents {
        agent := agent // capture
        pool.Submit(func() {
            action, err := e.runAgent(agent, roundID)
            if err != nil {
                log.Printf("agent %s failed: %v", agent.ID, err)
                return
            }
            if action != nil {
                actionsChan <- *action
            }
        })
    }

    pool.Wait()
    close(actionsChan)

    // Собираем все действия, пишем в БД пачкой
    actions := make([]Action, 0, len(e.agents))
    for a := range actionsChan {
        actions = append(actions, a)
    }

    if err := e.storage.BulkInsertActions(actions); err != nil {
        return fmt.Errorf("bulk insert: %w", err)
    }

    // Обновляем ленты агентов для следующего раунда
    e.updateFeeds(actions)

    // Саммари раунда (опционально — тоже через LLM)
    summary, _ := e.llm.SummarizeRound(actions)
    e.storage.UpdateRoundSummary(roundID, summary)

    // JSONL-лог
    e.logger.LogRound(roundNum, actions, summary)

    return nil
}
```

## A.4 Логика одного агента с tool calling

Ключевой момент: **агент решает через tool calling** какое действие совершить. LLM получает функции (`create_post`, `reply_to`, `like`, `skip`) и выбирает.

```go
// internal/engine/agent.go
func (e *SimulationEngine) runAgent(agent *Agent, roundID string) (*Action, error) {
    // 1. Формируем контекст — лента
    feedText := formatFeed(agent.RecentFeed, e.config.FeedSize)

    // 2. System prompt — роль агента
    systemPrompt := fmt.Sprintf(`Ты %s.

Биография: %s
Характер: %s
Интересы: %s

Ты в социальной сети. Сейчас %d-й раунд симуляции.
Прочитай свою ленту и реши, что сделать. Ты можешь:
- create_post: написать новый пост (если есть что сказать)
- reply_to: ответить на конкретный пост
- like: лайкнуть пост
- repost: репостнуть с комментарием
- skip: промолчать (если тема не твоя или нечего добавить)

Веди себя достоверно — как этот персонаж в реальности. Не пиши ерунду просто ради активности.`,
        agent.Name, agent.Biography, agent.Personality,
        strings.Join(agent.Interests, ", "), e.currentRound)

    userPrompt := fmt.Sprintf("Твоя лента:\n\n%s\n\nЧто ты сделаешь?", feedText)

    // 3. Определяем инструменты
    tools := agentActionTools()

    // 4. Вызываем LLM
    resp, err := e.llm.ChatWithTools(e.cancelCtx, llm.ChatRequest{
        Model: "gpt-4o-mini",  // для агентов хватит mini, дешевле
        Messages: []llm.Message{
            {Role: "system", Content: systemPrompt},
            {Role: "user", Content: userPrompt},
        },
        Tools:      tools,
        ToolChoice: "required",  // обязать выбрать инструмент
    })
    if err != nil {
        return nil, err
    }

    if len(resp.ToolCalls) == 0 {
        return nil, fmt.Errorf("agent didn't call any tool")
    }

    // 5. Парсим выбор
    call := resp.ToolCalls[0]
    return parseToolCall(agent.ID, roundID, call)
}

func agentActionTools() []llm.Tool {
    return []llm.Tool{
        {
            Name:        "create_post",
            Description: "Написать новый пост в ленту",
            Parameters: map[string]interface{}{
                "type": "object",
                "properties": map[string]interface{}{
                    "content": map[string]interface{}{
                        "type":        "string",
                        "description": "Текст поста (до 280 символов)",
                    },
                },
                "required": []string{"content"},
            },
        },
        {
            Name:        "reply_to",
            Description: "Ответить на пост другого агента",
            Parameters: map[string]interface{}{
                "type": "object",
                "properties": map[string]interface{}{
                    "target_action_id": map[string]interface{}{"type": "string"},
                    "content":          map[string]interface{}{"type": "string"},
                },
                "required": []string{"target_action_id", "content"},
            },
        },
        // ... остальные инструменты
        {
            Name:        "skip",
            Description: "Промолчать в этом раунде",
            Parameters:  map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
        },
    }
}
```

## A.5 Worker pool

Простой паттерн — семафор на N слотов. Не тащи сторонние библиотеки для такого:

```go
// internal/engine/worker_pool.go
package engine

import "sync"

type WorkerPool struct {
    sem chan struct{}
    wg  sync.WaitGroup
}

func NewWorkerPool(concurrency int) *WorkerPool {
    return &WorkerPool{sem: make(chan struct{}, concurrency)}
}

func (p *WorkerPool) Submit(task func()) {
    p.wg.Add(1)
    go func() {
        defer p.wg.Done()
        p.sem <- struct{}{}
        defer func() { <-p.sem }()
        task()
    }()
}

func (p *WorkerPool) Wait() { p.wg.Wait() }
```

## A.6 LLM-клиент с rate limiting и ретраями

```go
// internal/llm/client.go
package llm

import (
    "context"
    "time"

    "github.com/sashabaranov/go-openai"
    "golang.org/x/time/rate"
)

type Client struct {
    openai  *openai.Client
    limiter *rate.Limiter
}

func NewClient(apiKey string, rpm int) *Client {
    return &Client{
        openai:  openai.NewClient(apiKey),
        // Например 500 RPM = 500/60 = ~8.3 запросов в секунду
        limiter: rate.NewLimiter(rate.Limit(float64(rpm)/60.0), rpm),
    }
}

func (c *Client) ChatWithTools(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
    if err := c.limiter.Wait(ctx); err != nil {
        return nil, err
    }

    // Ретрай с экспоненциальным бэкоффом
    var lastErr error
    for attempt := 0; attempt < 3; attempt++ {
        resp, err := c.openai.CreateChatCompletion(ctx, toOpenAIRequest(req))
        if err == nil {
            return fromOpenAIResponse(resp), nil
        }
        lastErr = err

        // Если это rate limit — ждём дольше
        if isRateLimitError(err) {
            time.Sleep(time.Duration(1<<attempt) * time.Second)
            continue
        }
        // Другие ошибки — сразу возвращаем
        return nil, err
    }
    return nil, lastErr
}
```

## A.7 HTTP API сервиса

```go
// internal/api/simulate.go
func (h *Handler) StartSimulation(w http.ResponseWriter, r *http.Request) {
    var req StartRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        httpError(w, 400, err)
        return
    }

    // Создаём движок
    engine, err := h.buildEngine(req)
    if err != nil {
        httpError(w, 500, err)
        return
    }

    // Запускаем в фоне
    h.registry.Store(req.SimulationID, engine)
    go func() {
        ctx := context.Background()
        if err := engine.Run(ctx); err != nil {
            log.Printf("simulation %s failed: %v", req.SimulationID, err)
            h.storage.SetSimulationStatus(req.SimulationID, "failed")
            return
        }
        h.storage.SetSimulationStatus(req.SimulationID, "completed")
        // Webhook в NestJS
        h.notifier.Notify(req.SimulationID, "completed")
    }()

    w.WriteHeader(202)
    json.NewEncoder(w).Encode(map[string]string{"status": "started"})
}

func (h *Handler) GetStatus(w http.ResponseWriter, r *http.Request) {
    simID := chi.URLParam(r, "id")
    engine, ok := h.registry.Load(simID).(*engine.SimulationEngine)
    if !ok {
        httpError(w, 404, errors.New("not found"))
        return
    }

    status := engine.Status()  // thread-safe метод
    json.NewEncoder(w).Encode(status)
}

func (h *Handler) StopSimulation(w http.ResponseWriter, r *http.Request) {
    simID := chi.URLParam(r, "id")
    engine, ok := h.registry.Load(simID).(*engine.SimulationEngine)
    if !ok {
        httpError(w, 404, errors.New("not found"))
        return
    }
    engine.Cancel()
    w.WriteHeader(200)
}
```

## A.8 Коммуникация с NestJS — REST-контракт

**NestJS → Simulator:**
```http
POST /simulate
{
  "simulation_id": "uuid",
  "project_id": "uuid",
  "agents": [ {...AgentProfile}, ... ],
  "config": { "total_rounds": 20, "trigger_event": "...", ... }
}
→ 202 { "status": "started" }
```

**NestJS → Simulator (опрос):**
```http
GET /simulate/{id}/status
→ 200 { "current_round": 5, "total_rounds": 20, "status": "running" }
```

**Simulator → NestJS (webhook):**
```http
POST {NESTJS_URL}/internal/simulation/{id}/completed
Authorization: Bearer {INTERNAL_TOKEN}
{
  "simulation_id": "uuid",
  "final_status": "completed",
  "total_actions": 347
}
```

## A.9 Gotchas и советы

1. **Context cancellation везде.** Если NestJS говорит «стоп» — все горутины должны завершиться. `ctx` пробрасывай глубоко вниз.

2. **Не держи всех агентов в памяти если их тысячи.** Для MVP с 20–50 агентами это ок. Если масштабируешь — агенты загружаются под раунд.

3. **Bulk insert действий.** Не вставляй в БД после каждого действия — собирай пачку за раунд и одним `COPY` или multi-row `INSERT`.

4. **Идемпотентность:** если сервис упал посреди симуляции, при рестарте можно продолжить с последнего сохранённого раунда. Для проекта — опционально.

5. **LLM иногда возвращает невалидный tool call** (например пустой аргумент). Валидируй и ретрай или fallback на `skip`.

6. **Не шли больше `feed_size` действий в промпт.** Контекст раздуется, стоимость вырастет. 15–25 — нормально.

7. **Модель для агентов — дешёвая.** `gpt-4o-mini` или аналог. Дорогую модель имеет смысл ставить только на ReACT-агента для отчёта.

---

# Часть B. ReACT-агент для отчёта (NestJS)

## B.1 Структура модуля

```
apps/api/src/report/
├── report.module.ts
├── report.controller.ts         # HTTP endpoints
├── report.service.ts            # оркестрация
├── agent/
│   ├── react-agent.ts           # главный цикл
│   ├── tools/
│   │   ├── index.ts             # реестр всех инструментов
│   │   ├── search-graph.tool.ts
│   │   ├── get-agent-actions.tool.ts
│   │   ├── get-round-summary.tool.ts
│   │   ├── interview-agent.tool.ts
│   │   └── get-top-posts.tool.ts
│   ├── prompts.ts               # system-промпт агента
│   └── tool-schemas.ts          # JSON-схемы для OpenAI
├── report.entity.ts
└── report-trace.entity.ts       # лог шагов агента
```

## B.2 Контракт инструментов

Каждый инструмент — это класс, реализующий интерфейс:

```typescript
// agent/tools/tool.interface.ts
export interface Tool<TArgs = any, TResult = any> {
  name: string;
  description: string;
  schema: JSONSchema;                // для OpenAI
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

export interface ToolContext {
  simulationId: string;
  projectId: string;
  // DI-сервисы доступны через инъекцию в класс инструмента
}
```

Пример инструмента:

```typescript
// agent/tools/search-graph.tool.ts
@Injectable()
export class SearchGraphTool implements Tool {
  name = 'search_graph';
  description = 'Семантический поиск по графу сущностей. Используй чтобы найти персонажей по смыслу запроса.';

  schema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Поисковый запрос на естественном языке',
      },
      limit: {
        type: 'number',
        description: 'Сколько результатов вернуть',
        default: 10,
      },
    },
    required: ['query'],
  };

  constructor(
    private readonly entities: EntitiesRepository,
    private readonly embeddings: EmbeddingsService,
  ) {}

  async execute(
    args: { query: string; limit?: number },
    ctx: ToolContext,
  ): Promise<SearchResult[]> {
    const embedding = await this.embeddings.embed(args.query);
    const results = await this.entities.findSimilar(
      ctx.projectId,
      embedding,
      args.limit ?? 10,
    );

    return results.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      summary: e.attributes.summary,
      similarity: e.similarity,
    }));
  }
}
```

## B.3 Главный цикл ReACT-агента

```typescript
// agent/react-agent.ts
@Injectable()
export class ReactAgent {
  private readonly MAX_ITERATIONS = 20;

  constructor(
    private readonly openai: OpenAI,
    private readonly tools: ToolRegistry,      // все инструменты с DI
    private readonly traceRepo: ReportTraceRepository,
  ) {}

  async generateReport(
    simulationId: string,
    projectId: string,
    onProgress: (event: ProgressEvent) => void,
  ): Promise<string> {
    const ctx: ToolContext = { simulationId, projectId };
    const toolSchemas = this.tools.getOpenAISchemas();

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: REPORT_AGENT_PROMPT },
      { role: 'user', content: `Сгенерируй отчёт по симуляции ${simulationId}.` },
    ];

    for (let iter = 0; iter < this.MAX_ITERATIONS; iter++) {
      onProgress({ type: 'thinking', iteration: iter });

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',                  // для отчёта модель посильнее
        messages,
        tools: toolSchemas,
        tool_choice: 'auto',
      });

      const message = response.choices[0].message;
      messages.push(message);

      await this.traceRepo.save({
        simulationId,
        iteration: iter,
        message,
        usage: response.usage,
      });

      // Если LLM не вызвала инструмент — значит готов финальный ответ
      if (!message.tool_calls || message.tool_calls.length === 0) {
        onProgress({ type: 'done', content: message.content ?? '' });
        return message.content ?? '';
      }

      // Выполняем все вызванные инструменты (могут быть параллельно)
      const toolResults = await Promise.all(
        message.tool_calls.map(async (call) => {
          onProgress({
            type: 'tool_call',
            name: call.function.name,
            args: JSON.parse(call.function.arguments),
          });

          try {
            const args = JSON.parse(call.function.arguments);
            const result = await this.tools.execute(call.function.name, args, ctx);

            onProgress({ type: 'tool_result', name: call.function.name, result });

            return {
              tool_call_id: call.id,
              role: 'tool' as const,
              content: JSON.stringify(result),
            };
          } catch (err) {
            // Важно: не падаем, возвращаем ошибку обратно в LLM
            return {
              tool_call_id: call.id,
              role: 'tool' as const,
              content: JSON.stringify({ error: err.message }),
            };
          }
        }),
      );

      messages.push(...toolResults);
    }

    throw new Error(`Max iterations (${this.MAX_ITERATIONS}) exceeded`);
  }
}
```

## B.4 System-промпт репорт-агента

Качество отчёта на 80% зависит от этого промпта. Вот базовый вариант, с которого можно стартовать:

```typescript
// agent/prompts.ts
export const REPORT_AGENT_PROMPT = `
Ты — AI-аналитик. Твоя задача — написать подробный отчёт о симуляции социальной динамики.

# Как работать

У тебя есть инструменты для исследования данных. Не пытайся ответить сразу — сначала собери материал через инструменты, потом синтезируй.

Рекомендуемая последовательность:
1. Посмотри общую картину: get_round_summary для нескольких ключевых раундов
2. Найди самые вирусные посты: get_top_posts
3. Найди ключевых действующих лиц: search_graph + get_agent_actions
4. При необходимости проведи интервью с ключевыми агентами: interview_agent
5. Сопоставь и напиши отчёт

# Формат отчёта

Верни Markdown со структурой:

## Резюме
Одним абзацем: что произошло в симуляции.

## Ключевые события
Список поворотных моментов с раундами, когда они произошли.

## Динамика настроений
Как менялась общая тональность. Какие темы доминировали в какие раунды.

## Влиятельные голоса
Кто больше всего повлиял на дискурс. Приведи цитаты.

## Точки зрения
2-4 противоборствующие позиции в симуляции и их аргументы.

## Прогноз
Если бы симуляция продолжилась — что вероятно произошло бы дальше?

# Важно

- Используй конкретные цитаты из постов, а не общие слова
- Ссылайся на агентов по имени
- Если данных для какого-то раздела недостаточно — скажи об этом, не выдумывай
- Отчёт на русском языке
`;
```

## B.5 Stream на фронт через SSE

```typescript
// report.controller.ts
@Controller('api/report')
export class ReportController {
  constructor(private readonly service: ReportService) {}

  @Post(':simulationId/generate')
  @Sse()
  generate(@Param('simulationId') simId: string): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      this.service.generateReport(simId, (event) => {
        subscriber.next({ data: event });
      })
      .then((finalReport) => {
        subscriber.next({ data: { type: 'final', content: finalReport } });
        subscriber.complete();
      })
      .catch((err) => subscriber.error(err));
    });
  }
}
```

На фронте (Nuxt):

```vue
<script setup>
const events = ref([]);
const finalReport = ref(null);

function startGeneration(simId) {
  const es = new EventSource(`/api/report/${simId}/generate`);

  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'final') {
      finalReport.value = event.content;
      es.close();
    } else {
      events.value.push(event);  // thinking, tool_call, tool_result
    }
  };
}
</script>

<template>
  <div>
    <div class="trace">
      <div v-for="e in events" class="step">
        <span v-if="e.type === 'tool_call'">
          🔧 Вызываю {{ e.name }}({{ JSON.stringify(e.args) }})
        </span>
        <span v-else-if="e.type === 'thinking'">💭 Думаю...</span>
      </div>
    </div>
    <div v-if="finalReport" v-html="renderMarkdown(finalReport)" />
  </div>
</template>
```

Такой live-trace — это не просто UX-фича. Это **главная фишка** агентных интерфейсов — пользователь видит как AI «мыслит», и это вызывает доверие.

## B.6 Примеры остальных инструментов

```typescript
// agent/tools/get-agent-actions.tool.ts
@Injectable()
export class GetAgentActionsTool implements Tool {
  name = 'get_agent_actions';
  description = 'Получить все действия конкретного агента в симуляции';
  schema = {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      action_types: {
        type: 'array',
        items: { type: 'string', enum: ['post', 'reply', 'like', 'repost'] },
      },
    },
    required: ['agent_id'],
  };

  constructor(private readonly actions: SimulationActionsRepository) {}

  async execute(args, ctx: ToolContext) {
    return this.actions.findByAgent(ctx.simulationId, args.agent_id, args.action_types);
  }
}

// agent/tools/interview-agent.tool.ts
@Injectable()
export class InterviewAgentTool implements Tool {
  name = 'interview_agent';
  description = 'Задать вопрос симулированному агенту и получить ответ в его характере';
  schema = {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      question: { type: 'string' },
    },
    required: ['agent_id', 'question'],
  };

  constructor(
    private readonly profiles: AgentProfilesRepository,
    private readonly actions: SimulationActionsRepository,
    private readonly openai: OpenAI,
  ) {}

  async execute(args, ctx: ToolContext) {
    const profile = await this.profiles.findById(args.agent_id);
    const recentActions = await this.actions.findByAgent(ctx.simulationId, args.agent_id);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Ты ${profile.name}. ${profile.biography}\n\nТвои недавние посты:\n${formatActions(recentActions)}\n\nОтвечай в своём характере от первого лица.`,
        },
        { role: 'user', content: args.question },
      ],
    });

    return { answer: response.choices[0].message.content };
  }
}
```

## B.7 Реестр инструментов

```typescript
// agent/tools/index.ts
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    searchGraph: SearchGraphTool,
    getAgentActions: GetAgentActionsTool,
    getRoundSummary: GetRoundSummaryTool,
    interview: InterviewAgentTool,
    getTopPosts: GetTopPostsTool,
  ) {
    [searchGraph, getAgentActions, getRoundSummary, interview, getTopPosts]
      .forEach(t => this.tools.set(t.name, t));
  }

  getOpenAISchemas(): ChatCompletionTool[] {
    return [...this.tools.values()].map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
  }

  async execute(name: string, args: any, ctx: ToolContext): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(args, ctx);
  }
}
```

## B.8 Gotchas ReACT-агента

1. **Бесконечные циклы.** LLM может застрять, бесконечно вызывая инструменты. Всегда имей `MAX_ITERATIONS` и аварийное завершение.

2. **Стоимость взрывается с ростом истории.** Каждая итерация добавляет tool-результаты в `messages`. К 15-й итерации промпт может быть 30k токенов. Варианты:
   - Ставить `gpt-4o-mini` для «обзорных» шагов, `gpt-4o` только для финального синтеза
   - Суммировать старые tool-результаты когда история > N токенов

3. **LLM возвращает невалидный JSON в tool call.** OpenAI API это обычно не нарушает, но бывает. Оборачивай `JSON.parse` в try/catch и возвращай ошибку обратно в LLM — она обычно исправится на следующей итерации.

4. **Инструменты должны возвращать текст, пригодный для LLM.** Не отдавай сырые UUID и timestamps — переводи в читаемый вид. LLM лучше работает с `"Анна Петрова написала в раунде 3"` чем с `{"agent_uuid": "a1b2...", "round_id": "..."}`.

5. **Параллельные tool_calls.** OpenAI может вернуть сразу несколько `tool_calls` в одном ответе — обрабатывай их параллельно через `Promise.all`, не последовательно.

6. **Тестирование.** Замени `openai.chat.completions.create` на мок, который возвращает заранее записанные ответы с tool calls. Проверяй что инструменты вызываются в ожидаемом порядке.

7. **Наблюдаемость.** Каждую итерацию пиши в `report_traces` — это спасёт когда что-то пойдёт не так. Плюс подключи [Langfuse](https://langfuse.com) на 2-й неделе работы — сэкономит дни дебага.

---

## Резюме

**Go-Simulator** — циклический движок. Каждый раунд: load feed → ask LLM via tool calling → collect actions → persist → update feeds → next round. Ключи: worker pool с ограничением параллелизма, rate limiter для LLM, bulk insert в Postgres, context cancellation для graceful stop.

**ReACT-агент** — while-loop вокруг OpenAI API с tool calling. LLM сама решает какие инструменты дёргать. Ключи: строгий `MAX_ITERATIONS`, стриминг шагов на фронт через SSE, сохранение trace для дебага, модульная структура инструментов через DI.

Оба паттерна — «простой цикл + LLM делает сложное». Весь интеллект в промптах и описаниях инструментов, а не в коде.
