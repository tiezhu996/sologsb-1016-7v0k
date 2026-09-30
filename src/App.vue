<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NConfigProvider,
  NEmpty,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NSelect,
  NSpace,
  NTabPane,
  NTabs,
  NTag
} from 'naive-ui'
import { useStudio } from './useStudio'
import { cueLabel } from './scheduler'
import type { Cue, CueAnchor, CueKind, Rate } from './types'

const studio = useStudio()
const {
  state,
  selectedSceneId,
  selectedCueId,
  selectedScene,
  schedule,
  exportBlocked,
  totalDuration,
  pendingChanges,
  warnings,
  saveState,
  durationOfCue,
  durationOfScene,
  cueTiming,
  cueIssues,
  anchorDescription,
  updateProject,
  updateScene,
  updateCue,
  updateAnchor,
  addScene,
  deleteScene,
  addCue,
  deleteCue,
  moveCue,
  moveScene,
  acceptChange,
  rejectChange,
  acceptAll,
  undo,
  redo,
  freeze,
  downloadVersion,
  resetSample
} = studio

const dragCueId = ref('')
const showFreezeModal = ref(false)
const freezeName = ref('')
const activeRightTab = ref('warnings')

const kindOptions = [
  { label: '台词', value: 'dialogue' },
  { label: '音效', value: 'sfx' },
  { label: '转场', value: 'transition' }
]
const anchorModeOptions = [
  { label: '接上一条（顺序挂点）', value: 'prev' },
  { label: '跟随指定提示', value: 'follow' },
  { label: '固定绝对秒点', value: 'absolute' }
]
const followFromOptions = [
  { label: '同时起（目标开始）', value: 'start' },
  { label: '等目标结束', value: 'end' }
]
const rateOptions: Array<{ label: string; value: Rate }> = [
  { label: '慢 0.8×', value: 0.8 },
  { label: '偏慢 0.9×', value: 0.9 },
  { label: '标准 1.0×', value: 1 },
  { label: '偏快 1.1×', value: 1.1 },
  { label: '快 1.2×', value: 1.2 }
]
const characterOptions = computed(() => state.value.document.characters.map((item) => ({ label: `${item.name} / ${item.voiceActor}`, value: item.id })))
const effectOptions = computed(() => state.value.document.soundEffects.map((item) => ({ label: `${item.name} (${item.duration}s)`, value: item.id })))
const themeOverrides = {
  common: {
    primaryColor: '#73daca',
    primaryColorHover: '#8de7d9',
    primaryColorPressed: '#52b9aa',
    bodyColor: '#0d111b',
    cardColor: '#151b28',
    modalColor: '#171e2c',
    popoverColor: '#1b2332',
    textColorBase: '#e7edf7',
    borderColor: '#2b3445',
    borderRadius: '8px'
  },
  Input: { color: '#101621', colorFocus: '#101621', border: '1px solid #2b3445' },
  InputNumber: { color: '#101621', border: '1px solid #2b3445' },
  Card: { borderColor: '#252f40' },
  Tab: { tabTextColorActiveLine: '#73daca', barColor: '#73daca' }
}
const projectMinutes = computed(() => `${Math.floor(totalDuration.value / 60)}:${String(Math.round(totalDuration.value % 60)).padStart(2, '0')}`)
const pendingCount = computed(() => pendingChanges.value.length)
const warningCount = computed(() => warnings.value.length)
const saveLabel = computed(() => saveState.value === 'saved' ? '已保存到本机' : '正在保存…')

const blockReports = computed(() =>
  schedule.value.issues.map((issue) => {
    const scene = state.value.document.scenes.find((item) => item.id === issue.sceneId)
    const cue = scene?.cues.find((item) => item.id === issue.cueId)
    const typeText = issue.type === 'dangling' ? '依赖脱落' : issue.type === 'cycle' ? '挂点循环' : '越过固定秒点'
    let detail = ''
    if (scene && cue) {
      if (issue.type === 'dangling') detail = `跟随的提示 ${issue.relatedIds[0]} 已不存在`
      else if (issue.type === 'cycle') detail = '与其他提示互相跟随，时间无法求解'
      else detail = `重算到 ${(issue.at ?? 0).toFixed(1)}s，越过固定 ${(issue.fixedTime ?? 0).toFixed(1)}s 秒点`
    }
    return { issue, scene, cue, typeText, detail }
  })
)

function nameOfCue(cue: Cue) {
  return cueLabel(cue, state.value.document)
}

function followTargetOptions(sceneCues: Cue[], selfId: string) {
  return sceneCues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => cue.id !== selfId)
    .map(({ cue, index }) => ({ label: `#${index + 1} ${nameOfCue(cue)}（${durationOfCue(cue).toFixed(1)}s）`, value: cue.id }))
}

function changeAnchorMode(cue: Cue, mode: CueAnchor['mode']) {
  if (cue.anchor?.mode === mode) return
  if (mode === 'prev') updateAnchor(cue.id, { mode: 'prev', offset: cue.anchor?.mode === 'follow' ? cue.anchor.offset : 0 })
  else if (mode === 'absolute') updateAnchor(cue.id, { mode: 'absolute', time: 0 })
  else updateAnchor(cue.id, { mode: 'follow', targetId: '', from: 'end', offset: 0 })
}

function patchFollow(cue: Cue, patch: Partial<Extract<CueAnchor, { mode: 'follow' }>>) {
  const current = cue.anchor?.mode === 'follow' ? cue.anchor : { mode: 'follow' as const, targetId: '', from: 'end' as const, offset: 0 }
  updateAnchor(cue.id, { ...current, ...patch })
}

function sceneStatus(sceneId: string) {
  return warnings.value.some((warning) => warning.sceneId === sceneId) ? 'warning' : 'ok'
}

function dropCue(targetId: string) {
  if (!dragCueId.value || !selectedScene.value) return
  moveCue(selectedScene.value.id, dragCueId.value, targetId)
  dragCueId.value = ''
}

async function locate(sceneId?: string, cueId?: string) {
  if (!sceneId) return
  selectedSceneId.value = sceneId
  activeRightTab.value = 'warnings'
  await nextTick()
  if (cueId) {
    selectedCueId.value = cueId
    document.querySelector(`[data-cue-id="${cueId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } else {
    document.querySelector('.editor-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function changeCueKind(cue: Cue, kind: CueKind) {
  updateCue(cue.id, 'kind', kind)
  if (kind === 'dialogue' && !cue.characterId) updateCue(cue.id, 'characterId', state.value.document.characters[0]?.id)
  if (kind === 'sfx' && !cue.soundEffectId) updateCue(cue.id, 'soundEffectId', state.value.document.soundEffects[0]?.id)
  if (kind === 'transition') updateCue(cue.id, 'transition', cue.transition || '淡出')
}

function openFreeze() {
  if (exportBlocked.value) {
    showFreezeModal.value = true
    return
  }
  freezeName.value = `制作稿 v${state.value.frozen.length + 1}`
  showFreezeModal.value = true
}

function confirmFreeze() {
  const version = freeze(freezeName.value)
  if (!version) return
  showFreezeModal.value = false
  downloadVersion(version)
}

function onKeydown(event: KeyboardEvent) {
  const command = event.ctrlKey || event.metaKey
  if (command && event.key.toLowerCase() === 's') {
    event.preventDefault()
    studio.persist()
  }
  if (command && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? redo() : undo()
  }
  if (command && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
  }
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && selectedScene.value) {
    event.preventDefault()
    moveScene(selectedScene.value.id, event.key === 'ArrowUp' ? -1 : 1)
  }
  if (event.key === '[' || event.key === ']') {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === selectedScene.value?.id)
    const next = event.key === '[' ? index - 1 : index + 1
    if (state.value.document.scenes[next]) selectedSceneId.value = state.value.document.scenes[next].id
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">声</div>
          <div>
            <strong>声场制作台</strong>
            <span>RADIO DRAMA STUDIO</span>
          </div>
        </div>
        <div class="project-fields">
          <n-input :value="state.document.title" aria-label="项目标题" @update:value="updateProject('title', $event)" />
          <n-input :value="state.document.subtitle" aria-label="项目副标题" @update:value="updateProject('subtitle', $event)" />
        </div>
        <div class="top-actions">
          <span class="save-state">{{ saveLabel }}</span>
          <n-button quaternary @click="undo">撤销 ⌘Z</n-button>
          <n-button quaternary @click="redo">重做 ⇧⌘Z</n-button>
          <n-button :type="exportBlocked ? 'warning' : 'primary'" @click="openFreeze">
            {{ exportBlocked ? `排程阻断 · ${schedule.issues.length}` : '冻结并导出' }}
          </n-button>
        </div>
      </header>

      <section class="summary-strip">
        <div class="metric">
          <span>重算总时长</span>
          <strong>{{ projectMinutes }}</strong>
          <small>{{ totalDuration.toFixed(1) }} / {{ state.document.targetDuration }} 秒</small>
        </div>
        <div class="target-control">
          <n-progress
            type="line"
            :percentage="Math.min(100, Number(((totalDuration / state.document.targetDuration) * 100).toFixed(1)))"
            :height="8"
            :show-indicator="false"
            :status="totalDuration > state.document.targetDuration ? 'error' : 'success'"
          />
          <n-input-number
            :value="state.document.targetDuration"
            size="small"
            :min="30"
            :step="10"
            @update:value="updateProject('targetDuration', $event ?? 0)"
          >
            <template #suffix>秒目标</template>
          </n-input-number>
        </div>
        <div class="metric compact">
          <span>场次</span><strong>{{ state.document.scenes.length }}</strong>
        </div>
        <div class="metric compact">
          <span>待确认</span><strong class="accent">{{ pendingCount }}</strong>
        </div>
        <div class="metric compact">
          <span>检查项</span><strong :class="{ danger: warningCount }">{{ warningCount }}</strong>
        </div>
      </section>

      <main class="workspace">
        <aside class="scene-sidebar">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">PLAYLIST</span>
              <h2>场次结构</h2>
            </div>
            <n-button circle secondary aria-label="新增场次" @click="addScene">＋</n-button>
          </div>
          <div class="scene-list">
            <button
              v-for="(scene, index) in state.document.scenes"
              :key="scene.id"
              class="scene-item"
              :class="{ active: scene.id === selectedSceneId, warning: sceneStatus(scene.id) === 'warning' }"
              @click="selectedSceneId = scene.id"
            >
              <span class="scene-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="scene-copy">
                <strong>{{ scene.code }} · {{ scene.title }}</strong>
                <small>{{ scene.location }} / {{ scene.timeOfDay }}</small>
              </span>
              <span class="scene-duration">{{ durationOfScene(scene).toFixed(0) }}s</span>
            </button>
          </div>
          <div class="sidebar-tip">
            <strong>挂点工作流</strong>
            <span>顺序挂点：接上一条</span>
            <span>跟随：与指定提示同时起或结束后等几秒</span>
            <span>固定秒点：挡住上游传播</span>
            <span>⌘S 保存 · ⌘Z 撤销</span>
          </div>
          <n-button block quaternary @click="resetSample">恢复示例数据</n-button>
        </aside>

        <section v-if="selectedScene" class="editor-column">
          <div class="scene-title-row">
            <div>
              <span class="eyebrow">SCENE {{ selectedScene.code }}</span>
              <input class="title-input" :value="selectedScene.title" aria-label="场次标题" @change="updateScene(selectedScene.id, 'title', ($event.target as HTMLInputElement).value)" />
            </div>
            <div class="scene-order-actions">
              <n-button size="small" secondary @click="moveScene(selectedScene.id, -1)">上移</n-button>
              <n-button size="small" secondary @click="moveScene(selectedScene.id, 1)">下移</n-button>
              <n-button size="small" type="error" tertiary @click="deleteScene(selectedScene.id)">删除场次</n-button>
            </div>
          </div>

          <div class="scene-meta-grid">
            <n-form-item label="场次号"><n-input :value="selectedScene.code" @update:value="updateScene(selectedScene.id, 'code', $event)" /></n-form-item>
            <n-form-item label="空间"><n-input :value="selectedScene.location" @update:value="updateScene(selectedScene.id, 'location', $event)" /></n-form-item>
            <n-form-item label="时间"><n-input :value="selectedScene.timeOfDay" @update:value="updateScene(selectedScene.id, 'timeOfDay', $event)" /></n-form-item>
            <n-form-item label="场次限额（秒）"><n-input-number :value="selectedScene.durationLimit" :min="5" :step="5" @update:value="updateScene(selectedScene.id, 'durationLimit', $event ?? 0)" /></n-form-item>
            <n-form-item label="场次转场" class="span-2"><n-input :value="selectedScene.transition" @update:value="updateScene(selectedScene.id, 'transition', $event)" /></n-form-item>
          </div>

          <div class="timeline-heading">
            <div>
              <span class="eyebrow">TIMELINE</span>
              <h3>台词与声音提示 · 场次重算 {{ durationOfScene(selectedScene).toFixed(1) }} 秒</h3>
            </div>
            <div class="add-actions">
              <n-button size="small" type="primary" secondary @click="addCue('dialogue')">＋ 台词</n-button>
              <n-button size="small" secondary @click="addCue('sfx')">＋ 音效</n-button>
              <n-button size="small" secondary @click="addCue('transition')">＋ 转场</n-button>
            </div>
          </div>

          <div class="cue-list">
            <article
              v-for="(cue, index) in selectedScene.cues"
              :id="`cue-${cue.id}`"
              :data-cue-id="cue.id"
              :key="cue.id"
              class="cue-card"
              :class="[`kind-${cue.kind}`, { dragging: dragCueId === cue.id, blocked: cueIssues(cue.id).length > 0, selected: selectedCueId === cue.id }]"
              draggable="true"
              @dragstart="dragCueId = cue.id"
              @dragend="dragCueId = ''"
              @dragover.prevent
              @drop="dropCue(cue.id)"
            >
              <div class="cue-grip" title="拖动调整顺序">⋮⋮</div>
              <div class="cue-main">
                <div class="cue-topline">
                  <span class="cue-number">{{ String(index + 1).padStart(2, '0') }}</span>
                  <n-select class="kind-select" size="small" :value="cue.kind" :options="kindOptions" @update:value="changeCueKind(cue, $event)" />
                  <n-tag size="small" :bordered="false">{{ nameOfCue(cue) }}</n-tag>
                  <span class="duration-pill">{{ durationOfCue(cue).toFixed(1) }}s</span>
                  <span class="timing-pill" :class="{ unresolved: !cueTiming(selectedScene.id, cue.id)?.resolved }">
                    {{ cueTiming(selectedScene.id, cue.id)?.resolved ? `@${cueTiming(selectedScene.id, cue.id)?.start.toFixed(1)}s → ${cueTiming(selectedScene.id, cue.id)?.end.toFixed(1)}s` : '时间未求解' }}
                  </span>
                  <n-button size="tiny" tertiary type="error" @click="deleteCue(cue.id)">删除</n-button>
                </div>

                <div v-if="cue.kind === 'dialogue'" class="cue-grid">
                  <n-select :value="cue.characterId" :options="characterOptions" placeholder="选择角色" @update:value="updateCue(cue.id, 'characterId', $event)" />
                  <n-input :value="cue.emotion" placeholder="情绪与表演提示" @update:value="updateCue(cue.id, 'emotion', $event)" />
                  <n-select :value="cue.rate" :options="rateOptions" @update:value="updateCue(cue.id, 'rate', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="自动" :min="0.5" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>手动秒</template>
                  </n-input-number>
                  <n-input class="span-4" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :value="cue.text" @update:value="updateCue(cue.id, 'text', $event)" />
                </div>

                <div v-else-if="cue.kind === 'sfx'" class="cue-grid">
                  <n-select :value="cue.soundEffectId" :options="effectOptions" filterable placeholder="选择音效" @update:value="updateCue(cue.id, 'soundEffectId', $event)" />
                  <n-input :value="cue.text" placeholder="声音动作说明" @update:value="updateCue(cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="使用素材时长" :min="0.2" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>覆盖秒数</template>
                  </n-input-number>
                </div>

                <div v-else class="cue-grid">
                  <n-input :value="cue.transition" placeholder="转场方式" @update:value="updateCue(cue.id, 'transition', $event)" />
                  <n-input :value="cue.text" placeholder="转场说明" @update:value="updateCue(cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" :min="0" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>秒</template>
                  </n-input-number>
                </div>

                <div class="anchor-row">
                  <span class="anchor-label">起播挂点</span>
                  <n-select
                    class="anchor-mode"
                    size="small"
                    :value="cue.anchor?.mode ?? 'prev'"
                    :options="anchorModeOptions"
                    @update:value="changeAnchorMode(cue, $event)"
                  />
                  <template v-if="cue.anchor?.mode === 'prev'">
                    <n-input-number size="small" :value="cue.anchor.offset" :step="0.5" :min="0" @update:value="updateAnchor(cue.id, { mode: 'prev', offset: $event ?? 0 })">
                      <template #suffix>结束后等待秒</template>
                    </n-input-number>
                    <span class="anchor-hint">0 = 紧接上一条；首条锚定场次零点</span>
                  </template>
                  <template v-else-if="cue.anchor?.mode === 'follow'">
                    <n-select
                      class="anchor-target"
                      size="small"
                      filterable
                      :value="cue.anchor.targetId || null"
                      :options="followTargetOptions(selectedScene.cues, cue.id)"
                      placeholder="选择跟随的提示"
                      @update:value="patchFollow(cue, { targetId: $event })"
                    />
                    <n-select
                      class="anchor-from"
                      size="small"
                      :value="cue.anchor.from"
                      :options="followFromOptions"
                      @update:value="patchFollow(cue, { from: $event })"
                    />
                    <n-input-number size="small" :value="cue.anchor.offset" :step="0.5" @update:value="patchFollow(cue, { offset: $event ?? 0 })">
                      <template #suffix>偏移秒</template>
                    </n-input-number>
                  </template>
                  <template v-else-if="cue.anchor?.mode === 'absolute'">
                    <n-input-number size="small" :value="cue.anchor.time" :min="0" :step="0.5" @update:value="updateAnchor(cue.id, { mode: 'absolute', time: Math.max(0, $event ?? 0) })">
                      <template #suffix>场次内绝对秒</template>
                    </n-input-number>
                    <span class="anchor-hint">固定秒点不随上游移动，并挡住顺序链重算</span>
                  </template>
                  <span class="anchor-summary">{{ anchorDescription(cue, selectedScene) }}</span>
                </div>

                <div v-for="issue in cueIssues(cue.id)" :key="`${issue.type}-${issue.cueId}`" class="cue-issue">
                  <n-tag size="small" type="error" :bordered="false">
                    {{ issue.type === 'dangling' ? '依赖脱落' : issue.type === 'cycle' ? '挂点循环' : '越过固定秒点' }}
                  </n-tag>
                  <span v-if="issue.type === 'cross-fixed'">
                    重算 {{ (issue.at ?? 0).toFixed(1) }}s 越过固定 {{ (issue.fixedTime ?? 0).toFixed(1) }}s，已挡住传播
                  </span>
                  <span v-else-if="issue.type === 'dangling'">跟随目标 {{ issue.relatedIds[0] }} 已不存在</span>
                  <span v-else>挂点互相跟随形成循环</span>
                </div>
              </div>
            </article>
            <n-empty v-if="!selectedScene.cues.length" description="这场还没有声音提示">
              <template #extra><n-button @click="addCue('dialogue')">添加第一条台词</n-button></template>
            </n-empty>
          </div>
        </section>

        <aside class="review-column">
          <div class="review-heading">
            <div>
              <span class="eyebrow">REVIEW DESK</span>
              <h2>导演确认区</h2>
            </div>
            <n-button v-if="pendingCount" size="small" type="primary" secondary @click="acceptAll">全部接受</n-button>
          </div>
          <n-tabs v-model:value="activeRightTab" type="line" animated>
            <n-tab-pane name="warnings" :tab="`检查 ${warningCount}`">
              <div class="review-list">
                <div v-for="warning in warnings" :key="warning.id" class="warning-card" :class="warning.level">
                  <div class="warning-title">
                    <n-tag size="small" :type="warning.level === 'error' ? 'error' : 'warning'" :bordered="false">
                      {{ warning.type === 'collision' ? '撞场' : warning.type === 'missing-sfx' ? '引用' : warning.type === 'schedule' ? '排程' : '时长' }}
                    </n-tag>
                    <strong>{{ warning.title }}</strong>
                  </div>
                  <p>{{ warning.detail }}</p>
                  <n-button size="tiny" quaternary @click="locate(warning.sceneId, warning.cueId)">
                    定位到 {{ state.document.scenes.find((scene) => scene.id === warning.sceneId)?.code }}
                  </n-button>
                </div>
                <n-empty v-if="!warnings.length" description="当前没有连续性问题" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="pending" :tab="`待确认 ${pendingCount}`">
              <div class="pending-toolbar">
                <n-alert type="info" :show-icon="false">每次编辑都会形成草稿记录。退回较早记录时，其上方尚未确认的草稿会一并撤销。</n-alert>
              </div>
              <div class="review-list">
                <div v-for="change in state.pending.filter((item) => item.status === 'pending')" :key="change.id" class="pending-card">
                  <div class="pending-meta">
                    <strong>{{ change.label }}</strong>
                    <span>{{ new Date(change.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
                  </div>
                  <p v-if="change.note">{{ change.note }}</p>
                  <div class="pending-actions">
                    <n-button size="small" type="primary" @click="acceptChange(change.id)">接受</n-button>
                    <n-button size="small" tertiary type="warning" @click="rejectChange(change.id)">退回</n-button>
                  </div>
                </div>
                <n-empty v-if="!pendingCount" description="所有修改都已确认" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="versions" :tab="`冻结 ${state.frozen.length}`">
              <div class="review-list">
                <div v-for="version in state.frozen" :key="version.id" class="version-card">
                  <div>
                    <strong>{{ version.name }}</strong>
                    <span>生成时间 {{ new Date(version.createdAt).toLocaleString('zh-CN') }}</span>
                    <small>冻结制作稿 · {{ version.document.scenes.length }} 场 · {{ version.totalDuration.toFixed(1) }} 秒</small>
                  </div>
                  <n-button size="small" type="primary" secondary @click="downloadVersion(version)">导出稿</n-button>
                </div>
                <n-empty v-if="!state.frozen.length" description="冻结后生成只读制作稿（含生成时间）" />
              </div>
            </n-tab-pane>
          </n-tabs>
        </aside>
      </main>
    </div>

    <n-modal v-model:show="showFreezeModal">
      <div class="dialog-card">
        <template v-if="exportBlocked">
          <span class="eyebrow">EXPORT BLOCKED</span>
          <h2>排程未通过，已停止导出</h2>
          <n-alert type="error" :show-icon="false">
            存在依赖脱落、挂点循环或重算越过固定秒点的提示。请先处理下列提示，再冻结制作稿。
          </n-alert>
          <div class="block-list">
            <div v-for="(report, i) in blockReports" :key="`${report.issue.type}-${report.issue.cueId}-${i}`" class="block-item">
              <n-tag size="small" type="error" :bordered="false">{{ report.typeText }}</n-tag>
              <div class="block-copy">
                <strong>{{ report.scene?.code }} · {{ report.cue ? nameOfCue(report.cue) : '未知提示' }}</strong>
                <span>{{ report.detail }}</span>
              </div>
              <n-button size="tiny" quaternary @click="locate(report.scene?.id, report.issue.cueId); showFreezeModal = false">定位</n-button>
            </div>
          </div>
          <div class="dialog-actions">
            <n-button @click="showFreezeModal = false">知道了</n-button>
          </div>
        </template>
        <template v-else>
          <span class="eyebrow">FREEZE VERSION</span>
          <h2>冻结当前版本</h2>
          <p>冻结会保存一份不可变快照并写出生成时间，随后下载纯文本制作稿。当前草稿仍可继续编辑。</p>
          <n-input v-model:value="freezeName" placeholder="版本名称" @keyup.enter="confirmFreeze" />
          <div class="dialog-actions">
            <n-button @click="showFreezeModal = false">取消</n-button>
            <n-button type="primary" @click="confirmFreeze">冻结并导出</n-button>
          </div>
        </template>
      </div>
    </n-modal>
  </n-config-provider>
</template>
