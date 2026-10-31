import { strFromU8, unzipSync } from 'fflate';
import type { ChartDataRPE } from './types';

/**
 * `.pez` 谱面包的解包。
 *
 * 它就是个 ZIP，里面通常有四个文件：
 *   <id>.json  谱面（RPE 格式）
 *   <id>.mp3   曲子
 *   <id>.jpg   插画
 *   info.txt   元信息
 *
 * 文件名是无规律的数字 ID，所以必须读 info.txt 的 `Song:` / `Chart:` 字段
 * 才知道哪个文件是什么。
 */
export interface PezPackage {
  /** 谱面元信息，键来自 info.txt */
  info: Record<string, string>;
  chart: ChartDataRPE;
  /** 包内文件名 -> 原始字节 */
  files: Map<string, Uint8Array>;
  /** 音频文件名，没找到就是 null */
  audioName: string | null;
  /** 插画文件名 */
  imageName: string | null;
}

const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a', '.flac'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function hasExt(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

/** 解析 `Key: Value` 形式的元信息文件（info.txt / info.yml 都能凑合读） */
function parseInfo(text: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value && value !== 'null') info[key] = value;
  }
  return info;
}

export function isPez(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return head[0] === 0x50 && head[1] === 0x4b; // "PK"
}

export function loadPez(buffer: ArrayBuffer): PezPackage {
  const entries = unzipSync(new Uint8Array(buffer));

  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // 目录项
    // 只取文件名，忽略目录前缀
    const base = name.split('/').pop()!;
    files.set(base, data);
  }

  const names = [...files.keys()];

  // 优先 info.txt，其次 info.yml
  let info: Record<string, string> = {};
  for (const candidate of ['info.txt', 'info.yml', 'info.yaml', 'info.json']) {
    const data = files.get(candidate);
    if (!data) continue;
    const text = strFromU8(data);
    if (candidate.endsWith('.json')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        info = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]),
        );
      } catch {
        info = {};
      }
    } else {
      info = parseInfo(text);
    }
    if (Object.keys(info).length) break;
  }

  // 定位谱面文件：优先 info 里指定的，其次找唯一的 json
  let chartName = info.Chart && files.has(info.Chart) ? info.Chart : null;
  if (!chartName) chartName = names.find((n) => n.toLowerCase().endsWith('.json')) ?? null;
  if (!chartName) throw new Error('谱面包里没有找到 JSON 谱面文件');

  const chart = JSON.parse(strFromU8(files.get(chartName)!)) as ChartDataRPE;

  const audioName =
    (info.Song && files.has(info.Song) ? info.Song : null) ??
    names.find((n) => hasExt(n, AUDIO_EXT)) ??
    null;

  const imageName =
    (info.Picture && files.has(info.Picture) ? info.Picture : null) ??
    names.find((n) => hasExt(n, IMAGE_EXT)) ??
    null;

  return { info, chart, files, audioName, imageName };
}
