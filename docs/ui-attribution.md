# 共用控制台样式来源

本工作台直接复用 `OrangeZh1/qisvc-console-ui` 的共享 CSS 导出，并在现有原生 JavaScript 页面使用其控制台布局与卡片样式。

- 来源仓库：`https://github.com/OrangeZh1/qisvc-console-ui`
- 固定版本：`ec22302d737726314fdb930fc74a23bb47c55186`
- 原文件：`styles/console.css`
- 原 Git blob：`6e8f184cba464d80dfe9f353033d5b331a2fa75c`
- 作者已于 2026-11-12 明确授权本工作台直接使用并公开这部分样式；本次不更改上游仓库的可见性。

保留的上游文件位于 `vendor/qisvc-console-ui/console.css`，校验值与来源信息见同目录 `source.json`。本工作台专属布局写在 `styles/workbench.css`；构建器校验上游文件后合并成 `public/style.css`。生成文件不进入 Git，CI 构建并保留经过浏览器验收的 `viewer-assets` 制品。

页面没有引入 Nuxt/Vue 运行时或复制业务代码。原有本地 Iconify 图标继续使用其独立许可，见 `icon-attribution.md`。
