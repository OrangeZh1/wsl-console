# 图标来源与第三方许可

工作台统一使用 [Iconify](https://iconify.design/) 提供的 [Lucide 图标集](https://icon-sets.iconify.design/lucide/)。本地 SVG sprite 只包含下列必要图标，浏览器运行时不访问 Iconify API 或其他 CDN，也不安装图标运行依赖。内部 symbol 名称用于状态与界面动作，图形路径来自官方 Iconify API，没有另绘一套状态图标。

- 数据取得日期：2026-11-09。
- 官方 API：https://api.iconify.design/lucide.json?icons=activity,chevron-down,chevron-right,circle,circle-check,circle-pause,circle-slash,circle-x,clock,copy,history,list,loader-circle,refresh-cw,server,terminal,triangle-alert
- API 数据 lastModified：1794034857。
- 本次 API 数据 SHA256：`7ef4100c0af0bfa8c4d5e9b8b9875162fbd9689ec74741791c3c685cc3dbf7c1`。
- 官方 SVG API 说明：[Rendering SVG](https://iconify.design/docs/api/svg.html)。
- 许可原文来源：[Lucide LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE) 和 [Lucide License](https://lucide.dev/license)。

| 本地 symbol | Iconify 图标 |
| --- | --- |
| `status-passed` | `lucide:circle-check` |
| `status-running` | `lucide:loader-circle` |
| `status-failed` | `lucide:circle-x` |
| `status-queued` | `lucide:circle` |
| `status-cancelled` | `lucide:circle-slash` |
| `status-interrupted` | `lucide:circle-pause` |
| `status-blocked` | `lucide:triangle-alert` |
| `refresh` | `lucide:refresh-cw` |
| `copy` | `lucide:copy` |
| `chevron-right` | `lucide:chevron-right` |
| `chevron-down` | `lucide:chevron-down` |
| `terminal` | `lucide:terminal` |
| `clock` | `lucide:clock` |
| `activity` | `lucide:activity` |
| `history` | `lucide:history` |
| `list` | `lucide:list` |
| `server` | `lucide:server` |

`history`、`triangle-alert` 为 API 返回的别名，分别解析到 `rotate-ccw-clock`、`triangle-exclamation-point`，图形保持官方内容。所有图标使用 24×24 viewBox 和 currentColor。

以下许可仅适用于这些第三方图标，不构成本项目其他源码的开源授权。Lucide 使用 ISC；其中源自 Feather 的图标同时保留上游 MIT 声明。

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
