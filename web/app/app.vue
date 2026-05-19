<script setup lang="ts">
import { ref } from 'vue'
import type { IUploadResponse } from '@contracts/upload/upload-response.type'

const config = useRuntimeConfig()
const apiBase = config.public.apiBase as string

const file = ref<File | null>(null)
const result = ref<IUploadResponse | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  file.value = target.files?.[0] ?? null
  result.value = null
  error.value = null
}

async function onSubmit() {
  if (!file.value) {
    error.value = 'Выбери файл'
    return
  }
  loading.value = true
  error.value = null
  result.value = null
  try {
    const formData = new FormData()
    // Field name must match FileInterceptor('file', ...) on the API.
    formData.append('file', file.value)

    result.value = await $fetch<IUploadResponse>(`${apiBase}/upload`, {
      method: 'POST',
      body: formData,
    })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string }; message?: string }
    error.value = e.data?.message ?? e.message ?? 'Ошибка загрузки'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="container">
    <h1>SwarmSim — загрузка документа</h1>
    <p class="hint">
      Поддерживаются: <code>.txt</code>, <code>.md</code>, <code>.pdf</code>.
      Лимит — 10 MB.
    </p>

    <form @submit.prevent="onSubmit">
      <input
        type="file"
        accept=".txt,.md,.markdown,.pdf"
        @change="onFileChange"
      >
      <button type="submit" :disabled="!file || loading">
        {{ loading ? 'Загружаю…' : 'Загрузить' }}
      </button>
    </form>

    <p v-if="error" class="error">Ошибка: {{ error }}</p>

    <section v-if="result" class="result">
      <h2>Загружено</h2>
      <dl>
        <dt>ID</dt><dd><code>{{ result.id }}</code></dd>
        <dt>Имя файла</dt><dd>{{ result.originalName }}</dd>
        <dt>Размер</dt><dd>{{ result.size }} B</dd>
        <dt>MIME</dt><dd><code>{{ result.mimetype }}</code></dd>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.container {
  max-width: 720px;
  margin: 2rem auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  padding: 0 1rem;
}
.hint { color: #666; font-size: 0.9rem; }
form { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0; }
button { padding: 0.5rem 1rem; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: #c00; }
.result { margin-top: 2rem; border-top: 1px solid #ddd; padding-top: 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { font-weight: 600; color: #555; }
pre {
  background: #f6f8fa;
  padding: 1rem;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow: auto;
}
code { background: #f0f0f0; padding: 0 0.25rem; border-radius: 3px; }
</style>
