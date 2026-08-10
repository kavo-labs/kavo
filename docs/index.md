---
layout: home

hero:
  name: Kavo
  text: Turn models into APIs
  tagline: Define an entity once and get a complete REST, GraphQL, and MCP CRUD API with filtering, sorting, pagination, realtime events, and generated routes. Vibe code it in minutes, on a fraction of the tokens.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/kavo-labs/kavo
---

<script setup lang="ts">
import { ref } from "vue";
import ToolLogoStrip from "./.vitepress/theme/components/ToolLogoStrip.vue";
import QueryGrammarTabs from "./.vitepress/theme/components/QueryGrammarTabs.vue";
import FeatureGrid from "./.vitepress/theme/components/FeatureGrid.vue";
import McpSection from "./.vitepress/theme/components/McpSection.vue";
import RealtimeSection from "./.vitepress/theme/components/RealtimeSection.vue";
import LayerEquation from "./.vitepress/theme/components/LayerEquation.vue";

const queryGrammarTabs = [
  { id: "filter-sort", label: "Filter & sort" },
  { id: "includes", label: "Includes" },
  { id: "fields", label: "Field selection" },
  { id: "pagination", label: "Pagination" },
  { id: "soft-delete", label: "Soft delete" },
];
const activeQueryGrammarTab = ref(queryGrammarTabs[0].id);
</script>

<ToolLogoStrip />

<div class="before-after">
  <p class="before-after-lead ai-title">Stop writing repetitive CRUD endpoints.</p>
  <div class="before-after-col before-after-col--before">
    <div class="before-after-header before-after-header--before before-after-header--stacked">
      <div class="before-after-header-row">
        <span class="before-after-label-title"><span class="before-after-dot before-after-dot--before"></span>Without Kavo</span>
        <span class="before-after-count before-after-count--before">77 lines</span>
      </div>
      <p class="before-after-subtitle before-after-subtitle--before">No pagination, filtering, sorting, or field selection.</p>
    </div>

```ts
@Controller("books")
export class BooksController {
  constructor(private readonly repository: BookRepository) {}

  @Post()
  create(@Body() body: { title: string; author: string }) {
    return this.repository.create({
      data: {
        title: body.title,
        author: body.author,
      },
    });
  }

  @Get()
  findAll() {
    return this.repository.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: {
        id: "desc",
      },
    });
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.repository.findOne({
      where: {
        id,
        deletedAt: null,
      },
    });
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() body: { title?: string; author?: string }) {
    return this.repository.update({
      where: {
        id,
        deletedAt: null,
      },
      data: {
        title: body.title,
        author: body.author,
      },
    });
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.repository.delete({
      where: {
        id,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  @Patch(":id/restore")
  restore(@Param("id", ParseIntPipe) id: number) {
    return this.repository.restore({
      where: {
        id,
      },
      data: {
        deletedAt: null,
      },
    });
  }
}
```

  </div>
  <div class="before-after-col before-after-col--after">
    <div class="before-after-header before-after-header--after before-after-header--stacked">
      <div class="before-after-header-row">
        <span class="before-after-label-title"><span class="before-after-dot before-after-dot--after"></span>With Kavo</span>
        <span class="before-after-count before-after-count--after">3 lines</span>
      </div>
      <p class="before-after-subtitle before-after-subtitle--after">
        <strong>Pagination</strong>, <strong>filtering</strong>, <strong>sorting</strong>, <strong>field selection</strong>, and more — all included.
      </p>
    </div>

```ts
@Kavo(Book)
@Controller("books")
export class BooksController {}
```

  </div>
</div>

<div class="ai-section">
  <p class="ai-title">Built for agentic development</p>
  <p class="ai-subtitle">Built with Claude Code, and shipped with skills so Claude, Codex, Antigravity, and other coding agents move just as fast.</p>
  <div class="ai-install">

```
npx skills add kavo-labs/kavo
```

  <p class="ai-install-note">Fewer tokens, ship faster.</p>
  </div>
</div>

<FeatureGrid />

<McpSection />

<div class="query-section">
  <p class="query-title">The query grammar, on the wire</p>
  <p class="query-subtitle">Filtering, sorting, pagination, and includes — all driven by the query string, no extra code.</p>
  <QueryGrammarTabs v-model="activeQueryGrammarTab" :tabs="queryGrammarTabs" />

  <div class="query-demo">
    <div class="query-demo-col">
      <span class="query-demo-label">Request</span>
      <div v-show="activeQueryGrammarTab === 'filter-sort'">

```http
GET /books
  ?filter[status][eq]=published
  &filter[publishedAt][gte]=2020-01-01
  &sort=-publishedAt
  &include=author
  &limit=2
```

  </div>
      <div v-show="activeQueryGrammarTab === 'includes'">

```http
GET /books/42
  ?include=author,reviews.user
```

  </div>
      <div v-show="activeQueryGrammarTab === 'fields'">

```http
GET /books
  ?fields=id,title,status
  &fields[author]=id,name
```

  </div>
      <div v-show="activeQueryGrammarTab === 'pagination'">

```http
GET /books
  ?sort=title
  &limit=25
  &offset=50
```

  </div>
      <div v-show="activeQueryGrammarTab === 'soft-delete'">

```http
GET /books
  ?withDeleted=true
  &filter[status][eq]=archived
```

  </div>
    </div>
    <div class="query-demo-col">
      <span class="query-demo-label">Response</span>
      <div v-show="activeQueryGrammarTab === 'filter-sort'">

```json
{
  "items": [
    {
      "id": 42,
      "title": "The Left Hand of Darkness",
      "status": "published",
      "author": { "id": 7, "name": "Ursula K. Le Guin" }
    },
    {
      "id": 41,
      "title": "Kindred",
      "status": "published",
      "author": { "id": 3, "name": "Octavia E. Butler" }
    }
  ],
  "limit": 2,
  "offset": 0,
  "total": 128
}
```

  </div>
      <div v-show="activeQueryGrammarTab === 'includes'">

```json
{
  "id": 42,
  "title": "The Left Hand of Darkness",
  "author": { "id": 7, "name": "Ursula K. Le Guin" },
  "reviews": [
    {
      "id": 101,
      "rating": 5,
      "user": { "id": 3, "name": "Alex Chen" }
    }
  ]
}
```

  </div>
      <div v-show="activeQueryGrammarTab === 'fields'">

```json
{
  "items": [
    { "id": 42, "title": "The Left Hand of Darkness", "status": "published" },
    { "id": 41, "title": "Kindred", "status": "published" }
  ],
  "limit": 20,
  "offset": 0,
  "total": 128
}
```

  </div>
      <div v-show="activeQueryGrammarTab === 'pagination'">

```json
{
  "items": [
    { "id": 63, "title": "Annihilation", "status": "published" },
    { "id": 88, "title": "Binti", "status": "published" }
  ],
  "limit": 25,
  "offset": 50,
  "total": 128
}
```

  </div>
      <div v-show="activeQueryGrammarTab === 'soft-delete'">

```json
{
  "items": [
    {
      "id": 17,
      "title": "The Dispossessed",
      "status": "archived",
      "deletedAt": "2026-03-14T09:22:00.000Z"
    }
  ],
  "limit": 20,
  "offset": 0,
  "total": 1
}
```

  </div>
    </div>
  </div>
</div>

<div class="realtime-section">
  <p class="realtime-title">Realtime, without a second system</p>
  <p class="realtime-subtitle">
    Every create, update, patch, and delete already flows through one engine — publishing it as an event is a config flag, not a new pipeline. SSE ships today; WebSocket, RabbitMQ, and Kafka plug into the same <code>RealtimeTransport</code> interface.
  </p>

  <RealtimeSection />
</div>

<LayerEquation />
