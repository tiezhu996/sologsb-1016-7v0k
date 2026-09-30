import type {
  Cue,
  Scene,
  ScheduleIssue,
  SceneSchedule,
  StudioDocument
} from './types'

export const DOCUMENT_VERSION = 2
const EPS = 1e-6

/** 旧数据（v1，无挂点）升级：按列表顺序补成 prev 顺序挂点。 */
export function upgradeDocument(document: StudioDocument): StudioDocument {
  if (document.version >= DOCUMENT_VERSION) return document
  for (const scene of document.scenes) {
    for (const cue of scene.cues) {
      if (!cue.anchor) cue.anchor = { mode: 'prev', offset: 0 }
    }
  }
  document.version = DOCUMENT_VERSION
  return document
}

/** 纯时长估算（不含挂点语义），与挂点求解解耦，便于单测。 */
export function estimateCueDuration(cue: Cue, document: StudioDocument): number {
  if (cue.manualDuration !== undefined) return cue.manualDuration
  if (cue.kind === 'sfx') {
    return document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
  }
  if (cue.kind === 'transition') return 3
  const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
  const effectiveRate = cue.rate || 1
  return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * 求解单场挂点排程。
 *
 * 挂点接法：
 * - prev：接上一条。起点 = 列表上一条结束点 + offset（0 即紧接，首条锚定场次 0 秒）。
 * - follow：跟随本场指定提示的开始/结束点 + offset；from 'start' 且 offset 0
 *   即“和那条同时起”。目标被删除即依赖脱落。
 * - absolute：固定绝对秒点，不依赖任何提示。
 *
 * 传播与屏障：上游改动沿 prev 顺序链立即向下游重算；遇到 absolute 提示即停止，
 * 固定点本身不动。若顺序链重算出的时间越过了下游某个固定秒点（内容顶过固定点），
 * 报 cross-fixed。follow/prev 形成环时报 cycle。出现任一问题则 blocked，导出停止。
 */
export function scheduleScene(scene: Scene, document: StudioDocument): SceneSchedule {
  const cues = scene.cues
  const timing: SceneSchedule['timing'] = {}
  const issues: ScheduleIssue[] = []
  const byId = new Map(cues.map((cue, index) => [cue.id, { cue, index }]))
  const color = new Map<string, 0 | 1 | 2>() // 0 白 / 1 灰(在递归栈) / 2 黑(已解)
  const broken = new Set<string>()

  function addIssue(issue: ScheduleIssue) {
    const signature = `${issue.type}|${issue.cueId}|${issue.relatedIds.join(',')}|${issue.fixedTime ?? ''}`
    if (!issues.some((item) => `${item.type}|${item.cueId}|${item.relatedIds.join(',')}|${item.fixedTime ?? ''}` === signature)) {
      issues.push(issue)
    }
  }

  function resolve(id: string, stack: string[]): boolean {
    const entry = byId.get(id)
    if (!entry) return false
    const state = color.get(id)
    if (state === 2) return !broken.has(id)
    if (state === 1) {
      const cycleStart = stack.indexOf(id)
      const cycleNodes = cycleStart >= 0 ? stack.slice(cycleStart) : [id]
      for (const nodeId of cycleNodes) {
        broken.add(nodeId)
        addIssue({ type: 'cycle', cueId: nodeId, relatedIds: cycleNodes.filter((node) => node !== nodeId) })
      }
      return false
    }
    color.set(id, 1)
    stack.push(id)

    const cue = entry.cue
    const anchor = cue.anchor ?? { mode: 'prev', offset: 0 }
    let start: number | null = null

    if (anchor.mode === 'absolute') {
      start = Math.max(0, anchor.time)
    } else if (anchor.mode === 'prev') {
      if (entry.index === 0) {
        start = Math.max(0, anchor.offset)
      } else {
        const prevCue = cues[entry.index - 1]
        if (resolve(prevCue.id, stack)) {
          const prevTiming = timing[prevCue.id]
          start = Math.max(0, round1(prevTiming.end + anchor.offset))
        } else {
          broken.add(id)
        }
      }
    } else if (anchor.targetId === id) {
      broken.add(id)
      addIssue({ type: 'cycle', cueId: id, relatedIds: [] })
    } else {
      const target = byId.get(anchor.targetId)
      if (!target) {
        broken.add(id)
        addIssue({ type: 'dangling', cueId: id, relatedIds: [anchor.targetId] })
      } else if (resolve(target.cue.id, stack)) {
        const targetTiming = timing[anchor.targetId]
        start = Math.max(0, round1((anchor.from === 'end' ? targetTiming.end : targetTiming.start) + anchor.offset))
      } else {
        broken.add(id)
      }
    }

    stack.pop()
    color.set(id, 2)

    if (start === null || broken.has(id)) {
      timing[id] = { start: NaN, end: NaN, resolved: false }
      return false
    }
    const duration = round1(estimateCueDuration(cue, document))
    timing[id] = { start, end: round1(start + duration), resolved: true }
    return true
  }

  for (const cue of cues) resolve(cue.id, [])

  // 固定秒点屏障检测：每个 absolute 提示挡住从上方顺序链（prev）传来的重算。
  // 紧邻它上方、由 prev 连续挂接的那一条若结束时间越过固定秒点，即为越过传播。
  cues.forEach((cue, index) => {
    if (cue.anchor?.mode !== 'absolute' || index === 0) return
    const fixedTime = round1(Math.max(0, cue.anchor.time))
    for (let i = index - 1; i >= 0; i -= 1) {
      const upper = cues[i]
      if (upper.anchor?.mode !== 'prev') break
      const item = timing[upper.id]
      if (item?.resolved && item.end > fixedTime + EPS) {
        addIssue({ type: 'cross-fixed', cueId: upper.id, relatedIds: [cue.id], at: item.end, fixedTime })
      }
      break // 只看紧邻固定点的那一条（顺序链上它最晚结束）
    }
  })

  let duration = 0
  for (const cue of cues) {
    const item = timing[cue.id]
    if (item?.resolved && item.end > duration) duration = item.end
  }

  return { timing, duration: round1(duration), issues, blocked: issues.length > 0 }
}

export interface DocumentScheduleView {
  scenes: Record<string, SceneSchedule>
  totalDuration: number
  issues: Array<ScheduleIssue & { sceneId: string }>
  blocked: boolean
}

export function scheduleDocument(document: StudioDocument): DocumentScheduleView {
  const scenes: Record<string, SceneSchedule> = {}
  const issues: DocumentScheduleView['issues'] = []
  let totalDuration = 0
  for (const scene of document.scenes) {
    const result = scheduleScene(scene, document)
    scenes[scene.id] = result
    totalDuration += result.duration
    for (const issue of result.issues) issues.push({ ...issue, sceneId: scene.id })
  }
  return { scenes, totalDuration: round1(totalDuration), issues, blocked: issues.length > 0 }
}

export function cueLabel(cue: Cue, document: StudioDocument): string {
  if (cue.kind === 'dialogue') {
    return document.characters.find((item) => item.id === cue.characterId)?.name ?? '未指定角色'
  }
  if (cue.kind === 'sfx') return cue.text || '音效提示'
  return cue.text || cue.transition || '转场'
}
