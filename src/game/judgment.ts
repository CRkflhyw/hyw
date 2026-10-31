/**
 * 判定规则。
 *
 * 这里的数值都是**可以调的**，而且我对 Phigros 具体机制有不确定的地方，
 * 所以全部集中在这个文件里、逐条注明我的假设，方便你按实际手感改。
 */

export const enum Grade {
  Perfect = 0,
  Good = 1,
  Miss = 2,
}

export const GRADE_LABEL: Record<Grade, string> = {
  [Grade.Perfect]: 'Perfect',
  [Grade.Good]: 'Good',
  [Grade.Miss]: 'Miss',
};

/** 每个评级折算的准确率，用于算分 */
export const GRADE_ACCURACY: Record<Grade, number> = {
  [Grade.Perfect]: 1,
  [Grade.Good]: 0.65,
  [Grade.Miss]: 0,
};

export const JUDGMENT = {
  /** Perfect 判定窗口，秒 */
  perfect: 0.08,
  /** Good 判定窗口，秒；超出即 Miss */
  good: 0.16,

  /**
   * 长按松手后允许的宽限时间，秒。手指抖动一下不至于断连击。
   */
  holdGrace: 0.12,

  /**
   * 甩动（Flick）判定：指针从按下到移动超过这个距离就算甩动。
   * 鼠标在桌面上不好做甩动，所以阈值给得比较宽松。
   */
  flickDistance: 18,

  /**
   * 甩动是否必须真的有滑动动作。
   * true（按 Phigros 的手感）：点一下不会命中 Flick 音符，必须滑动。
   * false：点一下也能命中，桌面鼠标操作会轻松很多。
   */
  flickRequiresGesture: true,
} as const;

// 说明：这里没有「位置判定」的开关，因为 Phigros 本来就没有 ——
// 手指点在哪里都算命中，判定只看时间。要改成传统音游那种需要按位置的玩法，
// 得把屏幕坐标换算回 RPE 坐标、再和音符的 positionX 比对，
// 换算需要用到渲染层当前的判定线变换。

/** 星级评价，按总分划档。分段是我按 Phigros 的印象定的，可以改。 */
export const RANKS: readonly { min: number; label: string }[] = [
  { min: 1000000, label: 'Phi' },
  { min: 960000, label: 'V' },
  { min: 900000, label: 'S' },
  { min: 800000, label: 'A' },
  { min: 700000, label: 'B' },
  { min: 600000, label: 'C' },
  { min: 0, label: 'F' },
];

export function rankOf(score: number): string {
  for (const rank of RANKS) {
    if (score >= rank.min) return rank.label;
  }
  return 'F';
}
