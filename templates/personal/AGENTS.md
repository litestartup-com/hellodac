# 个人助理工作区

这是你的工作区。你在这里读写文件，manager 把 `board/` 下的数据渲染成大盘。

> 拓扑与边界见本工作区 `fleet.md`（manager 自动生成）：节点清单、关键地址变量（`$MANAGER_URL`）、跨节点边界——只读写本目录，跨节点一律经 manager 派工。

## 铁律

1. **文件是唯一事实来源。** 不要凭记忆回答，先读文件。
2. **先写文档，再更新大盘。** `board/*.json` 是文档内容的摘要视图，不是原始记录。原始记录写进对应的 markdown，大盘只放结论和数字。
3. **不确定就问，不要编。** 数字对不上时宁可留空并说明，也不要填一个看起来合理的值。
4. **不删历史。** 记录只追加或修正，不整段抹掉。

## 目录

| 路径 | 放什么 |
|---|---|
| `日志/YYYY-MM-DD.md` | 每日流水，按天一个文件 |
| `记账.md` | 收支明细，一行一笔 |
| `计划.md` | 目标与本周计划 |
| `健康.md` | 体重、作息、锻炼记录 |
| `board/*.json` | 大盘数据，见下 |

## 大盘怎么更新

`board/` 下每个 `.json` 就是大盘上的一页，文件自己描述自己：

```json
{
  "label": "总览",
  "order": 1,
  "blocks": [ ... ]
}
```

- 新增一页 = 新建一个 `.json`，不需要改别的文件。
- `board/meta.json` 只放标题和 `asOf`。**每次改动大盘都要把 `asOf` 更新成今天。**

### 可用的组件（只有这些，写别的显示不出来）

| type | 用途 | 必填字段 |
|---|---|---|
| `kpi` | 顶部大数字 | `items[].label`、`items[].value` |
| `metrics` | 当前值 vs 目标 | `items[].name`、`items[].value` |
| `list` | 计划、待办、备忘 | `items[].text` |
| `table` | 多列明细 | `columns`、`rows` |
| `progress` | 预算、完成度进度条 | `items[].label`、`items[].value`、`items[].max` |
| `bars` | 柱状趋势（可为负） | `items[].label`、`items[].value` |
| `pie` | 占比构成 | `items[].label`、`items[].value` |
| `checklist` | 每日习惯打勾 | `items[].text`、`items[].done` |
| `quote` | 每日一句（按天轮换） | `items[].text` |
| `groups` | 分组清单 | `groups[].label`、`groups[].items` |
| `note` | 一段说明文字 | `text` |

可选字段：`title`（卡片标题）、`tone`（`good` / `warn` / `bad` / `info` / `muted`，用来上色）。

### 注意

- 数值字段必须是**数字**，不是字符串。`"value": 71.5` 而不是 `"value": "71.5"`。
- `kpi` 和 `metrics` 的 `value` 是**展示文本**，可以带单位，例如 `"71.5kg"`。
- 写坏了不会让整页崩掉，但那张卡片会变成一个显眼的报错块，并且出现在大盘顶部的问题列表里。看到就修。
