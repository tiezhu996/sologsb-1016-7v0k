import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import { DEFAULT_TIMING, resolveDocumentTimeline } from './timing'
import type { CueTiming } from './timing'
import type { Cue, CueKind, FrozenVersion, PendingChange, Scene, StudioDocument, StudioState, WarningItem } from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const DATA_VERSION = 2
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function estimateCueDuration(document: StudioDocument, cue: Cue): number {
  if (cue.manualDuration !== undefined) return cue.manualDuration
  if (cue.kind === 'sfx') {
    return document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
  }
  if (cue.kind === 'transition') return 3
  const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
  const effectiveRate = cue.rate || 1
  return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
}

/**
 * 旧数据升级：v1 没有挂点概念，所有提示隐式按列表顺序首尾相接。
 * 升级时显式补成“顺接上一条”，之后统一走时间线引擎。
 */
function migrate(state: StudioState): StudioState {
  if ((state.version ?? 1) >= DATA_VERSION) return state
  for (const scene of state.document.scenes) {
    for (const cue of scene.cues) {
      if (!cue.timing) cue.timing = { ...DEFAULT_TIMING }
    }
  }
  state.version = DATA_VERSION
  return state
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = migrate(JSON.parse(raw) as StudioState)
      if (parsed.document?.scenes?.length) return parsed
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
    version: DATA_VERSION,
    document: clone(sampleDocument),
    pending: [],
    frozen: [],
    updatedAt: new Date().toISOString()
  }
}

export function useStudio() {
  const state = ref<StudioState>(loadState())
  const selectedSceneId = ref(state.value.document.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])
  let saveTimer: number | undefined

  const selectedScene = computed(() => state.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? state.value.document.scenes[0])

  function durationOfCue(cue: Cue): number {
    return estimateCueDuration(state.value.document, cue)
  }

  // 时间线是响应式的：任何上游时长、挂点、顺序改动都会立即重算所有下游起点，
  // 固定秒点在引擎中作为无来源节点，天然挡住传播。
  const timeline = computed(() => resolveDocumentTimeline(state.value.document, (cue) => estimateCueDuration(state.value.document, cue)))
  const timelineErrors = computed(() => timeline.value.errors)
  const blockingErrors = computed(() => timelineErrors.value)
  const canExport = computed(() => blockingErrors.value.length === 0)

  function timelineOfScene(sceneId: string) {
    return timeline.value.scenes.find((item) => item.sceneId === sceneId)
  }

  function durationOfScene(scene: Scene): number {
    const resolved = timeline.value.scenes.find((item) => item.sceneId === scene.id)
    if (resolved) return resolved.duration
    // 冻结快照等非当前文档：按纯顺序兜底估算。
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() => timeline.value.duration)
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  const blockingTitle: Record<string, string> = {
    'dangling-target': '跟随目标缺失',
    'timing-cycle': '挂点循环',
    'crossed-fixed': '冲破固定秒点'
  }

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []

    // 时间线阻断错误（拿掉依赖、形成循环、越过固定秒点）：停止导出并指出提示。
    for (const error of timelineErrors.value) {
      const scene = state.value.document.scenes.find((item) => item.id === error.sceneId)
      result.push({
        id: `timing-${error.code}-${error.cueId}`,
        type: error.code,
        level: 'error',
        sceneId: error.sceneId,
        cueId: error.cueId,
        blocking: true,
        title: `${scene?.code ?? ''} ${blockingTitle[error.code] ?? '时间线错误'}`,
        detail: error.message
      })
    }

    for (const scene of state.value.document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = state.value.document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !state.value.document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneId: scene.id,
            cueId: cue.id,
            title: `${scene.code} 音效引用缺失`,
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
          })
        }
      }
      actorRoles.forEach((roles, actor) => {
        const uniqueRoles = [...new Set(roles)]
        if (uniqueRoles.length > 1) {
          result.push({
            id: `collision-${scene.id}-${actor}`,
            type: 'collision',
            level: 'error',
            sceneId: scene.id,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })
      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    return result
  })

  function persist() {
    state.value.updatedAt = new Date().toISOString()
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      saveState.value = 'saved'
    }, 180)
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(state.value.document)
    const document = clone(state.value.document)
    mutator(document)
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = document
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note,
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
    })
    if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    persist()
  }

  function replaceDocument(next: StudioDocument, label: string) {
    const before = clone(state.value.document)
    state.value.document = clone(next)
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(next)
    })
    persist()
  }

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') scene[field] = String(value)
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${state.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        if (field === 'rate') cue.rate = Number(value) as Cue['rate']
        else if (field === 'manualDuration') cue.manualDuration = value === '' || value === undefined ? undefined : Number(value)
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
        break
      }
    })
  }

  function updateCueTiming(cueId: string, timing: CueTiming) {
    commit('调整提示挂点', (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        cue.timing = clone(timing)
        break
      }
    })
  }

  function addScene() {
    const nextNumber = state.value.document.scenes.length + 1
    const id = uid('scene')
    commit(`新增场次 S${String(nextNumber).padStart(2, '0')}`, (document) => {
      document.scenes.push({
        id,
        code: `S${String(nextNumber).padStart(2, '0')}`,
        title: '未命名场次',
        location: '待填写',
        timeOfDay: '待填写',
        transition: '淡入',
        durationLimit: 150,
        cues: []
      })
    })
    selectedSceneId.value = id
  }

  function deleteScene(sceneId: string) {
    if (state.value.document.scenes.length <= 1) return
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = state.value.document.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = uid('cue')
    commit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      scene.cues.push({
        id,
        kind,
        characterId: kind === 'dialogue' ? document.characters[0]?.id : undefined,
        text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
        emotion: kind === 'dialogue' ? '自然' : '',
        rate: 1,
        soundEffectId: kind === 'sfx' ? document.soundEffects[0]?.id : undefined,
        transition: kind === 'transition' ? '淡出' : '',
        manualDuration: kind === 'transition' ? 3 : undefined,
        timing: { ...DEFAULT_TIMING }
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

  function moveCue(sceneId: string, cueId: string, targetCueId: string) {
    if (cueId === targetCueId) return
    commit('拖动调整台词与音效顺序', (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const fromIndex = scene.cues.findIndex((cue) => cue.id === cueId)
      const toIndex = scene.cues.findIndex((cue) => cue.id === targetCueId)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = scene.cues.splice(fromIndex, 1)
      scene.cues.splice(toIndex, 0, moved)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= state.value.document.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  function acceptChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId)
    if (!change || change.status !== 'pending') return
    change.status = 'accepted'
    persist()
  }

  function rejectChange(changeId: string) {
    const index = state.value.pending.findIndex((item) => item.id === changeId && item.status === 'pending')
    if (index < 0) return
    const change = state.value.pending[index]
    undoStack.value.push(clone(state.value.document))
    state.value.document = clone(change.before)
    for (let i = 0; i <= index; i += 1) {
      if (state.value.pending[i].status === 'pending') state.value.pending[i].status = 'rejected'
    }
    persist()
  }

  function acceptAll() {
    for (const change of state.value.pending) {
      if (change.status === 'pending') change.status = 'accepted'
    }
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(state.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(state.value.document))
    replaceDocument(next, '重做修改')
  }

  function freeze(name: string): { version: FrozenVersion | null; blocked: WarningItem[] } {
    // 存在缺依赖、循环或越过固定点的提示时，停止导出并指出对应提示。
    if (blockingErrors.value.length) return { version: null, blocked: warnings.value.filter((item) => item.blocking) }
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: totalDuration.value
    }
    state.value.frozen.unshift(version)
    persist()
    return { version, blocked: [] }
  }

  function formatGeneratedAt(iso: string): string {
    const date = new Date(iso)
    return `${date.toLocaleString('zh-CN', { hour12: false })}（${iso}）`
  }

  function makeScript(document: StudioDocument, generatedAt = new Date().toISOString()): string {
    const documentTimeline = resolveDocumentTimeline(document, (cue) => estimateCueDuration(document, cue))
    const lines = [
      document.title,
      document.subtitle,
      `目标时长：${document.targetDuration} 秒｜预计总时长：${documentTimeline.duration.toFixed(1)} 秒`,
      `生成时间：${formatGeneratedAt(generatedAt)}`,
      '='.repeat(48),
      ''
    ]
    document.scenes.forEach((scene, sceneIndex) => {
      const resolved = documentTimeline.scenes[sceneIndex]
      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      lines.push(`转场：${scene.transition}`)
      lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${resolved.duration.toFixed(1)} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const timed = resolved.cues[cueIndex]
        const timing = cue.timing ?? DEFAULT_TIMING
        const pin = timing.mode === 'absolute' ? '｜固定' : timed.pinned ? '｜固定' : ''
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${timed.start.toFixed(1)}-${timed.end.toFixed(1)}s / ${timed.duration.toFixed(1)}s${pin}]`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${cue.text}`)
        } else if (cue.kind === 'sfx') {
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          lines.push(`${prefix} 音效｜${cue.text}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        } else {
          lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
        }
        if (timing.mode === 'follow' && timing.targetId) {
          const targetIndex = scene.cues.findIndex((item) => item.id === timing.targetId)
          const anchorLabel = timing.anchor === 'start' ? '起点' : '终点'
          lines.push(`    挂点：跟随 #${targetIndex + 1}${anchorLabel}${timing.offset ? ` ${timing.offset > 0 ? '+' : ''}${timing.offset}s` : ''}`)
        } else if (timing.mode === 'after') {
          lines.push('    挂点：顺接上一条')
        }
      })
      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    lines.push('='.repeat(48))
    lines.push(`制作稿生成时间：${formatGeneratedAt(generatedAt)}（冻结稿，不可修改）`)
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([makeScript(version.document, version.createdAt)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = clone(sampleDocument)
      Object.assign(document, next)
    })
    selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
  }

  watch(state, persist, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    timeline,
    timelineErrors,
    blockingErrors,
    canExport,
    timelineOfScene,
    durationOfCue,
    durationOfScene,
    updateProject,
    updateScene,
    updateCue,
    updateCueTiming,
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
    makeScript,
    resetSample,
    persist
  }
}
