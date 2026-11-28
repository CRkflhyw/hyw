/**
 * 文字事件的自检脚本。
 *
 * 文字是纯时序逻辑，不用浏览器就能验证：构造一张 1 拍 = 1 秒（BPM 60）的合成谱面，
 * 在各个时刻取当前文字。要盯住的行为是「文字一直显示到下一个文字事件」——
 * 这是 RPE 的实际行为，谱面里写的 endTime 只管「文字什么时候换成 end 那个字符串」。
 *
 *   npm run check:text
 */

import { parseChart, textAt } from '../src/chart/parse';
import type { ChartDataRPE, TextEventData } from '../src/chart/types';

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

function textEvent(startBeats: number, endBeats: number, start: string, end = start): TextEventData {
  return {
    startTime: [startBeats, 0, 1],
    endTime: [endBeats, 0, 1],
    start,
    end,
    font: 'cmdysj',
    easingType: 1,
    easingLeft: 0,
    easingRight: 1,
  };
}

/** 只有一条判定线、只有文字事件，1 拍 = 1 秒 */
function makeChart(events: TextEventData[]): ReturnType<typeof parseChart> {
  const raw: ChartDataRPE = {
    BPMList: [{ bpm: 60, startTime: [0, 0, 1] }],
    META: { name: 'text-test', RPEVersion: 160, offset: 0 },
    judgeLineGroup: ['Default'],
    judgeLineList: [
      {
        Group: 0,
        Name: 'L',
        Texture: 'line.png',
        father: -1,
        isCover: 0,
        zOrder: 0,
        eventLayers: [{}],
        extended: { textEvents: events },
        notes: [],
      },
    ],
  };
  return parseChart(raw);
}

console.log('=== 文字事件：显示到下一个事件为止 ===');
{
  // 4→5 写「第一题」、20→21 写「第二题」：中间的 15 拍也要一直显示「第一题」
  const chart = makeChart([
    textEvent(4, 5, '第一题：1+2=?'),
    textEvent(20, 21, '第二题'),
  ]);
  const track = chart.lines[0].text;
  check('第一个事件之前没有文字', textAt(track, 0), null);
  check('事件开始的瞬间就显示', textAt(track, 4), '第一题：1+2=?');
  check('事件区间内显示', textAt(track, 4.5), '第一题：1+2=?');
  check('过了 endTime 依然显示（关键修复点）', textAt(track, 5.001), '第一题：1+2=?');
  check('一直显示到下一个事件之前', textAt(track, 19.999), '第一题：1+2=?');
  check('下一个事件接管', textAt(track, 20), '第二题');
  check('最后一个事件之后继续显示', textAt(track, 9999), '第二题');
}

console.log('\n=== 空文字事件用来清除 ===');
{
  const chart = makeChart([
    textEvent(10, 11, '(Tap Flick)'),
    textEvent(20, 21, '', ''),
    textEvent(30, 31, 'Tips'),
  ]);
  const track = chart.lines[0].text;
  check('显示', textAt(track, 15), '(Tap Flick)');
  check('空文字事件清除', textAt(track, 20), null);
  check('清除后保持空白', textAt(track, 25), null);
  check('后面的文字照常出现', textAt(track, 30), 'Tips');
}

console.log('\n=== start 与 end 不同：到 endTime 换成 end ===');
{
  const chart = makeChart([textEvent(0, 8, '3', '2')]);
  const track = chart.lines[0].text;
  check('endTime 之前是 start', textAt(track, 7.999), '3');
  check('endTime 之后是 end', textAt(track, 8), '2');
  check('end 一直保持', textAt(track, 500), '2');
}

console.log('\n=== 打字机（start 为空、end 非空）===');
{
  // 0→4 拍打完 "abcd"，easingType 1 = 线性
  const chart = makeChart([textEvent(0, 4, '', 'abcd')]);
  const track = chart.lines[0].text;
  check('起点只露出第一个字', textAt(track, 0), 'a');
  check('中途露出前两个字', textAt(track, 2), 'ab');
  check('结束后是完整文字', textAt(track, 4), 'abcd');
  check('打字机结束后保持完整文字', textAt(track, 99), 'abcd');
}

console.log('\n=== 没有文字事件的判定线 ===');
{
  const chart = makeChart([]);
  check('永远没有文字', textAt(chart.lines[0].text, 10), null);
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} 通过 / ${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
