<script setup lang="ts">
// Тосты о сети: когда источник отказал дважды подряд, человек узнаёт об этом плашкой, а не
// пустым экраном. Текст собирает core/net-toast — здесь только подписка и показ.

import { onBeforeUnmount, onMounted, ref } from 'vue'

import { subscribeNetHealth } from '@/core/net-health'
import { MAX_TOASTS, pickToasts, type NetToast } from '@/core/net-toast'

/** Сколько плашка висит сама. Дольше не надо: человек уже прочитал. */
const LIFT_MS = 9000

const toasts = ref<NetToast[]>([])
let stop: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  stop = subscribeNetHealth((rows) => {
    // Отбор и повторы — в core/net-toast: там их можно проверить, здесь только показ.
    const fresh = pickToasts(
      rows,
      toasts.value.map((t) => t.id),
    )
    if (fresh.length === 0) return

    toasts.value = [...toasts.value, ...fresh].slice(-MAX_TOASTS)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      toasts.value = toasts.value.slice(1)
    }, LIFT_MS)
  })
})

onBeforeUnmount(() => {
  stop?.()
  stop = null
  if (timer) clearTimeout(timer)
  timer = null
})
</script>

<template>
  <div v-if="toasts.length" class="am-toasts" role="status" aria-live="polite">
    <p v-for="toast in toasts" :key="toast.id" class="am-toast">
      <span class="am-toast__src">{{ toast.label }}</span>
      <span class="am-toast__code">{{ toast.code }}</span>
      <span class="am-toast__cause">{{ toast.cause }}.</span>
      <span class="am-toast__advice">{{ toast.advice }}.</span>
    </p>
  </div>
</template>

<style scoped>
/* Правый нижний угол: плашка не должна закрывать заголовок и кнопки экрана. */
.am-toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 36px));
  pointer-events: none;
}

.am-toast {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 9px 12px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--am-text);
  background: var(--am-panel);
  border-left: 2px solid var(--am-bad);
  border-radius: 0 var(--am-r-m) var(--am-r-m) 0;
  box-shadow: 0 6px 22px rgb(0 0 0 / 28%);
}

.am-toast__src {
  font-weight: 600;
}

.am-toast__code {
  color: var(--am-bad);
  font-variant-numeric: tabular-nums;
}

.am-toast__cause {
  color: var(--am-dim);
}

.am-toast__advice {
  color: var(--am-dim);
}
</style>
