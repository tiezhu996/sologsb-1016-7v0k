import { DOCUMENT_VERSION, estimateCueDuration, scheduleScene, upgradeDocument } from '../src/scheduler'
import type { Cue, CueAnchor, Scene, StudioDocument } from '../src/types'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`✓ ${name}`)
  } else {
    failures += 1
    console.error(`✗ ${name} ${detail}`)
  }
}
function approx(a: number, b: number) {
  return Math.abs(a - b) < 1e-6
}

function cue(id: string, duration: number, anchor: CueAnchor, kind: Cue['kind'] = 'sfx', text = id): Cue {
  return { id, kind, text, emotion: '', rate: 1, transition: '', manualDuration: duration, anchor }
}
function scene(id: string, cues: Cue[]): Scene {
  return { id, code: id, title: id, location: '', timeOfDay: '', transition: '', durationLimit: 999, cues }
}
const doc = (scenes: Scene[]): StudioDocument => ({
  version: DOCUMENT_VERSION,
  title: 't',
  subtitle: '',
  targetDuration: 999,
  characters: [],
  soundEffects: [],
  scenes
})

// 1. 顺序挂点：累加；上游改动立即向下游重算
{
  const s = scene('s', [cue('a', 4, { mode: 'prev', offset: 0 }), cue('b', 2, { mode: 'prev', offset: 0 }), cue('c', 3, { mode: 'prev', offset: 1 })])
  const r = scheduleScene(s, doc([s]))
  check('顺序链求解', approx(r.timing.a.start, 0) && approx(r.timing.b.start, 4) && approx(r.timing.c.start, 7) && approx(r.timing.c.end, 10), JSON.stringify(r.timing))
  check('顺序链场次时长', approx(r.duration, 10))
  s.cues[0].manualDuration = 8
  const r2 = scheduleScene(s, doc([s]))
  check('上游改动后下游立即重算', approx(r2.timing.b.start, 8) && approx(r2.timing.c.start, 11) && approx(r2.duration, 14))
}

// 2. follow：与目标同时起；等目标结束再等几秒
{
  const s = scene('s', [
    cue('a', 10, { mode: 'prev', offset: 0 }),
    cue('b', 2, { mode: 'follow', targetId: 'a', from: 'start', offset: 0 }),
    cue('c', 1, { mode: 'follow', targetId: 'a', from: 'end', offset: 2 })
  ])
  const r = scheduleScene(s, doc([s]))
  check('follow start 与目标同时起', approx(r.timing.b.start, 0))
  check('follow end +偏移', approx(r.timing.c.start, 12))
}

// 3. 固定秒点是传播屏障：上游变长，固定点及其后不动
{
  const s = scene('s', [
    cue('a', 4, { mode: 'prev', offset: 0 }),
    cue('fixed', 1, { mode: 'absolute', time: 20 }),
    cue('after', 2, { mode: 'prev', offset: 0 })
  ])
  const r1 = scheduleScene(s, doc([s]))
  check('固定点保持绝对秒点', approx(r1.timing.fixed.start, 20))
  check('固定点之后跟随固定点', approx(r1.timing.after.start, 21))
  check('无越过时不阻断', !r1.blocked && r1.issues.length === 0, JSON.stringify(r1.issues))
  s.cues[0].manualDuration = 6
  const r2 = scheduleScene(s, doc([s]))
  check('上游变化不越过固定点', approx(r2.timing.fixed.start, 20) && approx(r2.timing.after.start, 21) && !r2.blocked)
}

// 4. 重算越过固定秒点 → cross-fixed，阻断并指出提示
{
  const s = scene('s', [
    cue('a', 25, { mode: 'prev', offset: 0 }),
    cue('fixed', 1, { mode: 'absolute', time: 20 }),
    cue('after', 2, { mode: 'prev', offset: 0 })
  ])
  const r = scheduleScene(s, doc([s]))
  const issue = r.issues.find((item) => item.type === 'cross-fixed')
  check('越过固定秒点被检出', !!issue && issue.cueId === 'a' && issue.relatedIds[0] === 'fixed', JSON.stringify(r.issues))
  check('越过时场次阻断导出', r.blocked)
}

// 4b. 偏移等待把顺序链推过固定点也算越过
{
  const s = scene('s', [
    cue('a', 10, { mode: 'prev', offset: 0 }),
    cue('b', 2, { mode: 'prev', offset: 10 }),
    cue('fixed', 1, { mode: 'absolute', time: 15 })
  ])
  const r = scheduleScene(s, doc([s]))
  check('等待偏移越过固定点被检出', r.issues.some((item) => item.type === 'cross-fixed' && item.cueId === 'b'), JSON.stringify(r.issues))
}

// 5. 依赖脱落：跟随目标不存在
{
  const s = scene('s', [cue('a', 4, { mode: 'follow', targetId: 'ghost', from: 'start', offset: 0 })])
  const r = scheduleScene(s, doc([s]))
  check('依赖脱落被检出', r.issues.some((item) => item.type === 'dangling' && item.cueId === 'a' && item.relatedIds[0] === 'ghost'))
  check('脱落提示无求解时间', !r.timing.a.resolved)
  check('脱落阻断导出', r.blocked)
}

// 6. 循环挂接
{
  const s = scene('s', [
    cue('a', 4, { mode: 'follow', targetId: 'b', from: 'end', offset: 0 }),
    cue('b', 4, { mode: 'follow', targetId: 'a', from: 'end', offset: 0 })
  ])
  const r = scheduleScene(s, doc([s]))
  check('循环被检出', r.issues.some((item) => item.type === 'cycle' && item.cueId === 'a') && r.issues.some((item) => item.type === 'cycle' && item.cueId === 'b'))
  check('循环阻断导出', r.blocked)
}

// 6b. 间接循环 a→b→c→a
{
  const s = scene('s', [
    cue('a', 1, { mode: 'follow', targetId: 'c', from: 'start', offset: 0 }),
    cue('b', 1, { mode: 'follow', targetId: 'a', from: 'start', offset: 0 }),
    cue('c', 1, { mode: 'follow', targetId: 'b', from: 'start', offset: 0 })
  ])
  const r = scheduleScene(s, doc([s]))
  check('间接循环全部标记', ['a', 'b', 'c'].every((id) => r.issues.some((item) => item.type === 'cycle' && item.cueId === id)))
}

// 7. 固定点把场次时长拉长
{
  const s = scene('s', [cue('a', 2, { mode: 'prev', offset: 0 }), cue('fixed', 1, { mode: 'absolute', time: 30 })])
  const r = scheduleScene(s, doc([s]))
  check('固定点拉长场次时长', approx(r.duration, 31))
}

// 8. 旧数据升级：补顺序挂点
{
  const legacy = doc([scene('s', [{ id: 'x', kind: 'sfx', text: 'x', emotion: '', rate: 1, transition: '', manualDuration: 3 } as unknown as Cue])])
  legacy.version = 1
  upgradeDocument(legacy)
  check('旧数据版本升级', legacy.version === DOCUMENT_VERSION)
  check('旧数据补成顺序挂点', legacy.scenes[0].cues[0].anchor?.mode === 'prev')
  const r = scheduleScene(legacy.scenes[0], legacy)
  check('升级后排程可解', r.timing.x.resolved && approx(estimateCueDuration(legacy.scenes[0].cues[0], legacy), 3))
}

// 9. 被脱落/循环拖住的 prev 下游不产生假时间
{
  const s = scene('s', [
    cue('a', 4, { mode: 'follow', targetId: 'ghost', from: 'end', offset: 0 }),
    cue('b', 2, { mode: 'prev', offset: 0 })
  ])
  const r = scheduleScene(s, doc([s]))
  check('脱落上游导致下游 prev 同样未求解', !r.timing.a.resolved && !r.timing.b.resolved)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
