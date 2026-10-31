/**
 * 判定逻辑的自检脚本。
 *
 * 判定是纯时序逻辑，不需要浏览器就能严格验证：构造一张 BPM 60（1 拍 = 1 秒）的
 * 合成谱面，按精确的时刻喂输入，断言每种评级和边界。改完判定参数跑一下：
 *
 *   npm run check:judgment
 */

import { parseChart } from '../src/chart/parse';
import type { ChartDataRPE } from '../src/chart/types';
import { Grade } from '../src/game/judgment';
import { PlaySession } from '../src/game/session';

const FRAME = 1 / 60;

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** BPM 60、速度恒定的单判定线谱面，1 拍 = 1 秒，方便算时间 */
function makeChart(notes: ChartDataRPE['judgeLineList'][number]['notes']): ChartDataRPE {
  return {
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    META: { name: 'judgment-test', RPEVersion: 160, offset: 0 },
    judgeLineGroup: ['Default'],
    judgeLineList: [
      {
        Group: 0,
        Name: 'L',
        Texture: 'line.png',
        father: -1,
        isCover: 0,
        zOrder: 0,
        eventLayers: [
          {
            alphaEvents: [{ startTime: [0, 0, 1], endTime: [0, 0, 1], start: 255, end: 255 }],
            speedEvents: [{ startTime: [0, 0, 1], endTime: [9999, 0, 1], start: 10, end: 10 }],
          },
        ],
        notes,
      },
    ],
  };
}

const tap = (beat: number) => ({
  type: 1,
  startTime: [beat, 0, 1] as [number, number, number],
  endTime: [beat, 0, 1] as [number, number, number],
  positionX: 0,
  yOffset: 0,
  speed: 1,
  size: 1,
  above: 1,
  alpha: 255,
  isFake: 0,
  visibleTime: 999999,
});

/** 逐帧推进到 to 秒，模拟真实每帧调用 update */
function advance(session: PlaySession, from: number, to: number, pointersDown = 0): number {
  for (let t = from; t <= to; t += FRAME) session.update(t, pointersDown);
  session.update(to, pointersDown);
  return to;
}

const chart = parseChart(makeChart([
  tap(1),
  tap(2),
  { ...tap(3), type: 4 }, // Drag
  { ...tap(4), type: 3 }, // Flick
  // Hold：5 拍按下，7 拍结束
  { ...tap(5), type: 2, endTime: [7, 0, 1] },
]));

console.log('\n=== Tap 判定窗口 ===');
{
  const s = new PlaySession();
  s.setChart(chart);
  s.handleInput({ seconds: 1.0, kind: 'down', x: 0, y: 0 });
  check('正中命中 → Perfect', s.stats.perfect, 1);

  const s2 = new PlaySession();
  s2.setChart(chart);
  s2.handleInput({ seconds: 1.079, kind: 'down', x: 0, y: 0 });
  check('+79ms → Perfect（窗口边界内）', s2.stats.perfect, 1);

  const s3 = new PlaySession();
  s3.setChart(chart);
  s3.handleInput({ seconds: 1.081, kind: 'down', x: 0, y: 0 });
  check('+81ms → Good（刚出 Perfect 窗口）', s3.stats.good, 1);

  const s4 = new PlaySession();
  s4.setChart(chart);
  s4.handleInput({ seconds: 1.159, kind: 'down', x: 0, y: 0 });
  check('+159ms → Good（Good 窗口内）', s4.stats.good, 1);

  const s5 = new PlaySession();
  s5.setChart(chart);
  s5.handleInput({ seconds: 1.161, kind: 'down', x: 0, y: 0 });
  check('+161ms → 超出窗口，不判定', s5.stats.judged, 0);

  const s6 = new PlaySession();
  s6.setChart(chart);
  s6.handleInput({ seconds: 0.9, kind: 'down', x: 0, y: 0 });
  check('-100ms → Good（提前也算）', s6.stats.good, 1);
}

console.log('\n=== 漏掉就是 Miss ===');
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 1.2); // 一直不点
  check('过了窗口还没点 → Miss', s.stats.miss, 1);
  check('连击被清零', s.stats.combo, 0);
}

console.log('\n=== Drag 不需要点，只要有手指按着 ===');
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 3.05, 1); // 全程按着
  const stats = s.stats;
  check('有手指 → 3 拍之前的 Tap 全 Miss，Drag 命中', { miss: stats.miss, perfect: stats.perfect }, { miss: 2, perfect: 1 });
}
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 3.2, 0); // 一直没手指
  check('无手指 → Drag 也 Miss', s.stats.miss, 3);
}

console.log('\n=== Flick 需要滑动 ===');
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 3.3); // 把前三个音符耗掉，让第 4 拍的 Flick 成为最近的一个
  s.handleInput({ seconds: 4.0, kind: 'down', x: 0, y: 0 });
  check('只点一下不判 Flick', s.stats.judged, 3);

  const s2 = new PlaySession();
  s2.setChart(chart);
  advance(s2, 0, 3.3);
  s2.handleInput({ seconds: 3.98, kind: 'down', x: 0, y: 0 });
  s2.handleInput({ seconds: 4.0, kind: 'flick', x: 40, y: 0 });
  check('滑动 → Flick 判定为 Perfect', { judged: s2.stats.judged, perfect: s2.stats.perfect }, { judged: 4, perfect: 1 });
}

console.log('\n=== 长按 ===');
// 下面每个用例都先 advance 到 4.3 秒把前面 4 个音符漏掉，
// 所以断言要看**增量**，不然会把基线里的 4 个 Miss 算进来。
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 4.3);
  const missedBefore = s.stats.miss;

  s.handleInput({ seconds: 5.0, kind: 'down', x: 0, y: 0 });
  check('按下头部 → 立刻算 Perfect 并加连击', { perfect: s.stats.perfect, combo: s.stats.combo }, { perfect: 1, combo: 1 });
  advance(s, 5.01, 7.05, 1); // 一直按到结束
  check(
    '按满全程 → 保持 Perfect',
    { perfect: s.stats.perfect, miss: s.stats.miss - missedBefore },
    { perfect: 1, miss: 0 },
  );
}
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 4.3);
  const missedBefore = s.stats.miss;

  s.handleInput({ seconds: 5.0, kind: 'down', x: 0, y: 0 });
  advance(s, 5.01, 6.0, 0); // 中途松手
  check(
    '中途松手 → 降级为 Miss，头部评级被撤回',
    { perfect: s.stats.perfect, miss: s.stats.miss - missedBefore },
    { perfect: 0, miss: 1 },
  );
  check('连击断了', s.stats.combo, 0);
}
{
  const s = new PlaySession();
  s.setChart(chart);
  advance(s, 0, 4.3);
  const missedBefore = s.stats.miss;

  s.handleInput({ seconds: 5.0, kind: 'down', x: 0, y: 0 });
  // 松手 0.08 秒后又按住，在宽限期内不该断
  advance(s, 5.01, 5.08, 0);
  advance(s, 5.09, 7.05, 1);
  check(
    '宽限期内松手不断连',
    { perfect: s.stats.perfect, miss: s.stats.miss - missedBefore },
    { perfect: 1, miss: 0 },
  );
}

console.log('\n=== 计分 ===');
{
  const s = new PlaySession();
  s.setChart(chart);
  // 全部完美命中
  advance(s, 0, 0.5);
  s.handleInput({ seconds: 1.0, kind: 'down', x: 0, y: 0 });
  s.handleInput({ seconds: 2.0, kind: 'down', x: 0, y: 0 });
  advance(s, 2.1, 2.9, 1); // Drag（有手指）
  s.handleInput({ seconds: 4.0, kind: 'flick', x: 40, y: 0 });
  s.handleInput({ seconds: 5.0, kind: 'down', x: 0, y: 0 });
  advance(s, 5.1, 7.1, 1);

  const stats = s.stats;
  check('全 Perfect：连击拉满', stats.maxCombo, 5);
  check('全 Perfect：满分 1000000', stats.score, 1000000);
  check('全 Perfect：准确率 100%', stats.accuracy, 1);
  check('全 Perfect：评级 Phi', stats.rank, 'Phi');
  check('没有 Miss', stats.miss, 0);
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} 通过 / ${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
