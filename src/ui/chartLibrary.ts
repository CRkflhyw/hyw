/**
 * 谱面库。
 *
 * `charts/` 目录下所有 `.pez` 都会被构建期扫描到，页面一刷新就出现在导入列表里，
 * 不用每次开文件对话框。想把谱面加进来，把 .pez 复制进 `charts/` 就行。
 */
const modules = import.meta.glob('../../charts/*.pez', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface LibraryEntry {
  /** 显示名（去掉扩展名） */
  name: string;
  /** 可以直接 fetch 的地址 */
  url: string;
}

export const chartLibrary: readonly LibraryEntry[] = Object.entries(modules)
  .map(([path, url]) => ({
    name: path.split('/').pop()!.replace(/\.pez$/i, ''),
    url,
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
