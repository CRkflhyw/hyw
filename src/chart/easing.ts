/**
 * RPE 的缓动函数。
 *
 * 编号来自谱面里事件的 `easingType` 字段。注意这套编号**不是** easings.net 的顺序，
 * 而是 Re:PhiEdit 自己的定义顺序：2 是 easeOutSine、3 是 easeInSine，24 是 easeOutElastic。
 * 凭直觉按 easings.net 的顺序写会全错。
 */

const linear = (x: number) => x;

const easeOutSine = (x: number) => Math.sin((x * Math.PI) / 2);

const easeInQuad = (x: number) => x ** 2;
const easeInCubic = (x: number) => x ** 3;
const easeInQuart = (x: number) => x ** 4;
const easeInQuint = (x: number) => x ** 5;
const easeInCirc = (x: number) => 1 - Math.sqrt(1 - x ** 2);

const easeOutExpo = (x: number) => (x === 1 ? 1 : 1 - 2 ** (-10 * x));
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
const easeOutElastic = (x: number) => {
  if (x === 0) return 0;
  if (x === 1) return 1;
  return 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
const easeOutBounce = (x: number) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x - 1.5 / d1) ** 2 + 0.75;
  if (x < 2.5 / d1) return n1 * (x - 2.25 / d1) ** 2 + 0.9375;
  return n1 * (x - 2.625 / d1) ** 2 + 0.984375;
};

/** 由 easeOut 反推 easeIn：把曲线水平翻转 */
const mirror = (easeOut: (x: number) => number) => (x: number) => 1 - easeOut(1 - x);

/**
 * 组合 in/out 得到 inOut。
 * 这里刻意不采用 easings.net 的写法（两边的复合方式不同，曲线形状不一样），
 * 而是与 RPE 参考实现保持一致。
 */
const toEaseInOut =
  (easeIn: (x: number) => number, easeOut: (x: number) => number) => (x: number) =>
    x < 0.5 ? easeIn(2 * x) / 2 : (1 + easeOut(2 * x - 1)) / 2;

const easeOutQuad = mirror(easeInQuad);
const easeInSine = mirror(easeOutSine);
const easeOutQuart = mirror(easeInQuart);
const easeOutCubic = mirror(easeInCubic);
const easeOutQuint = mirror(easeInQuint);
const easeOutCirc = mirror(easeInCirc);
const easeInExpo = mirror(easeOutExpo);
const easeInElastic = mirror(easeOutElastic);
const easeInBounce = mirror(easeOutBounce);
const easeInBack = mirror(easeOutBack);

/** 下标就是 `easingType`，严格对应 RPE 的定义顺序。0 在 RPE 里是占位值，按线性处理。 */
export const RPE_EASINGS: readonly ((x: number) => number)[] = [
  linear, // 0 占位
  linear, // 1
  easeOutSine, // 2
  easeInSine, // 3
  easeOutQuad, // 4
  easeInQuad, // 5
  toEaseInOut(easeInSine, easeOutSine), // 6
  toEaseInOut(easeInQuad, easeOutQuad), // 7
  easeOutCubic, // 8
  easeInCubic, // 9
  easeOutQuart, // 10
  easeInQuart, // 11
  toEaseInOut(easeInCubic, easeOutCubic), // 12
  toEaseInOut(easeInQuart, easeOutQuart), // 13
  easeOutQuint, // 14
  easeInQuint, // 15
  easeOutExpo, // 16
  easeInExpo, // 17
  easeOutCirc, // 18
  easeInCirc, // 19
  easeOutBack, // 20
  easeInBack, // 21
  toEaseInOut(easeInCirc, easeOutCirc), // 22
  toEaseInOut(easeInBack, easeOutBack), // 23
  easeOutElastic, // 24
  easeInElastic, // 25
  easeOutBounce, // 26
  easeInBounce, // 27
  toEaseInOut(easeInBounce, easeOutBounce), // 28
  toEaseInOut(easeInElastic, easeOutElastic), // 29
];

/** RPE 把这两个 inOut 变体放在标准数组之外，编号是 101/102 */
const EXTRA_EASINGS: Record<number, (x: number) => number> = {
  101: toEaseInOut(easeInExpo, easeOutExpo),
  102: toEaseInOut(easeInQuint, easeOutQuint),
};

/**
 * 三次贝塞尔缓动（控制点固定为 (0,0) 和 (1,1)，即 CSS 的 cubic-bezier）。
 * 用牛顿迭代反解 x 对应的参数 t。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }

    // 牛顿迭代不收敛时退回二分
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export interface EasingSpec {
  easingType?: number;
  easingLeft?: number;
  easingRight?: number;
  bezier?: number;
  bezierPoints?: number[];
}

/**
 * 构造事件的缓动函数。
 *
 * `easingLeft`/`easingRight` 表示只用缓动曲线的某一段，并把这一段重新归一化到 0→1，
 * 这样端点值依然是 0 和 1。
 */
export function makeEasing(spec: EasingSpec): (t: number) => number {
  const { easingType, easingLeft = 0, easingRight = 1, bezier, bezierPoints } = spec;

  let fn =
    bezier === 1 && bezierPoints?.length === 4
      ? cubicBezier(bezierPoints[0], bezierPoints[1], bezierPoints[2], bezierPoints[3])
      : (RPE_EASINGS[easingType ?? 1] ?? EXTRA_EASINGS[easingType ?? -1] ?? linear);

  if (easingLeft === 0 && easingRight === 1) return fn;

  const leftValue = fn(easingLeft);
  const rightValue = fn(easingRight);
  const delta = rightValue - leftValue;
  if (delta === 0) return fn;

  const timeDelta = easingRight - easingLeft;
  const base = fn;
  fn = (t: number) => (base(easingLeft + timeDelta * t) - leftValue) / delta;
  return fn;
}
