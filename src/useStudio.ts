import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import {
  cueLabel as scheduleCueLabel,
  estimateCueDuration,
  scheduleDocument,
  upgradeDocument
} from './scheduler'
import type {
  Cue,
  CueAnchor,
  CueKind,
  FrozenVersion,
  PendingChange,
  Scene,
  SceneSchedule,
  StudioDocument,
  StudioState,
  WarningItem
} from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const pad2 = (value: number) => String(value).padStart(2, '0')
export function formatGeneratedAt(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        // 旧数据升级：没有挂点的提示按列表顺序补成 prev 顺序挂点。
        upgradeDocument(parsed.document)
        return parsed
      }
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
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

  upgradeDocument(state.value.document)

  const selectedScene = computed(() => state.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? state.value.document.scenes[0])

  /** 全场次挂点排程；文档任意改动后由 Vue 依赖立即驱动重算。 */
  const schedule = computed(() => scheduleDocument(state.value.document))
  const exportBlocked = computed(() => schedule.value.blocked)

  function durationOfCue(cue: Cue): number {
    return estimateCueDuration(cue, state.value.document)
  }

  function sceneSchedule(sceneId: string): SceneSchedule | undefined {
    return schedule.value.scenes[sceneId]
  }

  function durationOfScene(scene: Scene): number {
    return schedule.value.scenes[scene.id]?.duration ?? 0
  }

  function cueTiming(sceneId: string, cueId: string) {
    return schedule.value.scenes[sceneId]?.timing[cueId]
  }

  function cueIssues(cueId: string) {
    return schedule.value.issues.filter((issue) => issue.cueId === cueId)
  }

  const totalDuration = computed(() => schedule.value.totalDuration)
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of state.value.document.scenes) {
      const code = scene.code
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
            title: `${code} 音效引用缺失`,
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
            title: `${code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })

      const sceneScheduleResult = schedule.value.scenes[scene.id]
      for (const issue of sceneScheduleResult?.issues ?? []) {
        const cue = scene.cues.find((item) => item.id === issue.cueId)
        const name = cue ? scheduleCueLabel(cue, state.value.document) : '提示'
        if (issue.type === 'dangling') {
          result.push({
            id: `sched-${issue.type}-${issue.cueId}`,
            type: 'schedule',
            level: 'error',
            sceneId: scene.id,
            cueId: issue.cueId,
            title: `${code} 挂点依赖脱落`,
            detail: `“${name}”设置为跟随指定提示，但被跟随的提示（${issue.relatedIds[0]}）已不存在。请重新指定挂接对象或改回顺序挂点。`
          })
        } else if (issue.type === 'cycle') {
          const others = issue.relatedIds
            .map((id) => scheduleCueLabel(scene.cues.find((item) => item.id === id) as Cue, state.value.document))
            .filter(Boolean)
            .join('、')
          result.push({
            id: `sched-${issue.type}-${issue.cueId}`,
            type: 'schedule',
            level: 'error',
            sceneId: scene.id,
            cueId: issue.cueId,
            title: `${code} 挂点形成循环`,
            detail: `“${name}”${others ? `与“${others}”` : ''}互相跟随，时间无法求解。请打断循环。`
          })
        } else {
          const fixed = scene.cues.find((item) => item.id === issue.relatedIds[0])
          const fixedName = fixed ? scheduleCueLabel(fixed, state.value.document) : '固定秒点提示'
          result.push({
            id: `sched-${issue.type}-${issue.cueId}-${issue.relatedIds[0] ?? ''}`,
            type: 'schedule',
            level: 'error',
            sceneId: scene.id,
            cueId: issue.cueId,
            title: `${code} 重算越过固定秒点`,
            detail: `“${name}”重算到 ${(issue.at ?? 0).toFixed(1)} 秒，越过了“${fixedName}”的固定 ${(issue.fixedTime ?? 0).toFixed(1)} 秒点；固定秒点已挡住传播，请缩短上游内容或后移固定点。`
          })
        }
      }

      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${code} 超出场次限额`,
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
    upgradeDocument(state.value.document)
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
    commit(`修改提示 ${state.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
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

  const anchorLabels: Record<CueAnchor['mode'], string> = {
    prev: '设置为顺序挂点',
    follow: '跟随指定提示',
    absolute: '设置固定绝对秒点'
  }

  function updateAnchor(cueId: string, anchor: CueAnchor) {
    commit(anchorLabels[anchor.mode], (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (cue) {
          cue.anchor = anchor
          break
        }
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
        anchor: { mode: 'prev', offset: 0 }
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

  /** 存在脱落 / 循环 / 越过固定秒点时停止冻结导出，返回 null 由界面指出问题提示。 */
  function freeze(name: string): FrozenVersion | null {
    if (schedule.value.blocked) return null
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: totalDuration.value
    }
    state.value.frozen.unshift(version)
    persist()
    return version
  }

  function anchorDescription(cue: Cue, scene: Scene): string {
    const anchor = cue.anchor ?? { mode: 'prev', offset: 0 }
    if (anchor.mode === 'absolute') return `固定 ${anchor.time.toFixed(1)}s 绝对秒点`
    if (anchor.mode === 'prev') return anchor.offset ? `上一条结束后 +${anchor.offset}s` : '顺序挂点（接上一条）'
    const targetIndex = scene.cues.findIndex((item) => item.id === anchor.targetId)
    if (targetIndex < 0) return `跟随缺失提示 ${anchor.targetId}`
    return `跟随第 ${targetIndex + 1} 条${anchor.from === 'end' ? '结束' : '开始'}${anchor.offset ? ` +${anchor.offset}s` : '（同时起）'}`
  }

  function makeScript(document: StudioDocument, generatedAt: string, versionName?: string): string {
    const lines = [
      document.title,
      document.subtitle,
      `文稿类型：${versionName ? `冻结制作稿（${versionName}）` : '制作稿'}`,
      `生成时间：${formatGeneratedAt(generatedAt)}`,
      `目标时长：${document.targetDuration} 秒`,
      '='.repeat(48),
      ''
    ]
    const result = scheduleDocument(document)
    document.scenes.forEach((scene, sceneIndex) => {
      const sceneResult = result.scenes[scene.id]
      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      lines.push(`转场：${scene.transition}`)
      lines.push(`场次限额：${scene.durationLimit} 秒｜重算时长：${sceneResult?.duration.toFixed(1) ?? '0.0'} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const timingItem = sceneResult?.timing[cue.id]
        const startText = timingItem?.resolved ? `@${timingItem.start.toFixed(1)}s` : '@未求解'
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} ${startText} [${durationOfCue(cue).toFixed(1)}s]`
        const hook = `挂点：${anchorDescription(cue, scene)}`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${hook}`)
          lines.push(`    ${cue.text}`)
        } else if (cue.kind === 'sfx') {
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          lines.push(`${prefix} 音效｜${cue.text}`)
          lines.push(`    ${hook}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        } else {
          lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
          lines.push(`    ${hook}`)
        }
      })
      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([makeScript(version.document, version.createdAt, version.name)], { type: 'text/plain;charset=utf-8' })
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
    schedule,
    exportBlocked,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    durationOfCue,
    durationOfScene,
    sceneSchedule,
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
    makeScript,
    resetSample,
    persist
  }
}
