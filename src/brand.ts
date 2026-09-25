/**
 * 品牌单一真相源（DAC v1.0.0）。
 *
 * 产品名、仓库地址、站点、口号只在这里出现一次：页面渲染（pages.ts 的
 * {{BRAND}}/{{REPO_URL}} 等占位符）、侧栏入口、⋮ 菜单页脚全部从这里取。
 * 散写 URL 的代价是改域名时要满仓 grep，而且总有一处漏掉——正是 UI.md 里
 * 「单一真相源」那条的由来。
 *
 * 注意：这里是**产品品牌**，不是代码标识符。把 `dac` 换成 `dac` 的机械
 * 更名（B2）走的是另一条路径（包名/路径/env/cookie），两者互不替代。
 */
export interface Brand {
  /** 对外产品名（页面标题、侧栏、页脚）。 */
  name: string
  /** 展开全称（README、关于弹窗）。 */
  fullName: string
  /** 一句话定位。 */
  tagline: string
  /** 侧栏品牌副行（短，一行放得下）。 */
  sub: string
  /** 公开仓库。 */
  repoUrl: string
  /** 站点。 */
  homepage: string
  /** 支持邮箱（关于弹窗里的联系方式）。 */
  supportEmail: string
  /** 品牌标记（单字符，侧栏方块）。 */
  mark: string
}

export const BRAND: Brand = {
  name: 'DAC',
  fullName: 'Dispatched Agent Cluster',
  tagline: 'One Manager. A Fleet of Agents.',
  sub: 'Dispatched Agent Cluster',
  repoUrl: 'https://github.com/litestartup-com/hellodac',
  homepage: 'https://hellodac.com',
  supportEmail: 'support@hellodac.com',
  mark: 'D',
}
