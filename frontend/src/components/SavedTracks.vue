<script setup lang="ts">
import { computed } from 'vue'
import { savedTracks } from '../telemetry/sessions'
import { t, tn } from '../i18n'
import { selectedTrack } from '../telemetry/store'

const props = defineProps<{ exceptId?: number }>()
const others = computed(() => savedTracks.value.filter((track) => track.id !== props.exceptId))
</script>

<template>
  <div v-if="others.length" class="saved-tracks">
    <span class="label">{{ t('results.otherTracks') }}</span>
    <div class="buttons">
      <button v-for="track in others" :key="track.id" type="button" @click="selectedTrack = String(track.id)">
        {{ track.name }} · {{ tn('unit.drives', track.count) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.saved-tracks {
  display: grid;
  gap: 0.375rem;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

button {
  height: 2rem;
  padding: 0 0.625rem;
  border: 1px solid var(--control-border);
  border-radius: 0.5rem;
  background: var(--card-raised);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

button:hover {
  border-color: var(--you);
}
</style>
