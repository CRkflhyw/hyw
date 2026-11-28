import { Texture } from 'pixi.js';
import type { Chart } from './types';

/**
 * 判定线贴图的加载。
 *
 * 谱面里每条判定线都有个 `Texture` 字段，指向谱面包内的一张 PNG。
 * 把这些 PNG 解成 Pixi 贴图之后，判定线就不再是白条，而是图上画的东西
 * —— 自制谱大量用这个手法来显示图片、立绘、甚至整张背景。
 *
 * 尺寸约定：**1 贴图像素 = 1 个 RPE 坐标单位**。
 * 这条是从实测推出来的：Algebra 里有两条线用插画尺寸的贴图（1310×816px）
 * 配 scaleX/scaleY = 1.15，算出来 1506×938 单位，刚好略微铺满 1350×900 的设计画布。
 */

/**
 * 贴图不在谱面包里时用的兜底尺寸。
 *
 * `line.png` 是编辑器/游戏内置资源，谱面包里通常没有它，而绝大多数判定线用的就是它，
 * 所以这个值决定了普通判定线的长度和粗细：
 *
 * - 长度 4000：PhiEdit 自带的 `Resources/Texture/line.png` 就是 4000×5 像素，
 *   按「1 像素 = 1 单位」正好 4000 单位（≈ 3 个屏宽，所以线永远横穿整个画面）；
 *   两个第三方实现（kipphi-player 用 4050、phi-chart-render 用 4000）也是这个量级。
 * - 粗细取 6.75：编辑器那张图只有 5 像素高，但两个实现都把它画得比图粗
 *   （kipphi-player 6.75、phi-chart-render ≈7.2），那是照着游戏里的观感调的。
 *   觉得细了就改这个数。
 */
export const DEFAULT_LINE_UNITS: readonly [number, number] = [4000, 6.75];

export interface LineTextures {
  /** 贴图名 -> Pixi 贴图 */
  map: Map<string, Texture>;
  /** 判定线下标 -> 该线贴图在 RPE 单位下的自然尺寸 */
  unitsByLine: [number, number][];
  /** 谱面引用了但包里没有的贴图名 */
  missing: string[];
}

export async function loadLineTextures(
  chart: Chart,
  files: Map<string, Uint8Array>,
): Promise<LineTextures> {
  // 包内文件名按小写建索引，谱面里的引用大小写不一定完全一致
  const byLowerName = new Map<string, Uint8Array>();
  for (const [name, data] of files) byLowerName.set(name.toLowerCase(), data);

  const map = new Map<string, Texture>();
  const missing = new Set<string>();

  const uniqueNames = new Set(chart.lines.map((l) => l.textureName));

  await Promise.all(
    [...uniqueNames].map(async (name) => {
      const data = files.get(name) ?? byLowerName.get(name.toLowerCase());
      if (!data) {
        missing.add(name);
        return;
      }
      try {
        const blob = new Blob([data as BlobPart], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        map.set(name, Texture.from(bitmap));
      } catch {
        // 解不出来的就当缺失，走兜底
        missing.add(name);
      }
    }),
  );

  const unitsByLine: [number, number][] = chart.lines.map((line) => {
    const texture = map.get(line.textureName);
    return texture && texture.width > 0 && texture.height > 0
      ? [texture.width, texture.height]
      : [DEFAULT_LINE_UNITS[0], DEFAULT_LINE_UNITS[1]];
  });

  return { map, unitsByLine, missing: [...missing] };
}

export function disposeLineTextures(textures: LineTextures): void {
  for (const texture of textures.map.values()) texture.destroy(true);
  textures.map.clear();
}
