---
type: project
status: active
date: 2026-05-05
tags: [personal-project]
source: ""
---

# Susurration Backlog

## Bugs

### P1: Daemon 对同一信号重复 react（严重）
- **发现日期**: 2026-05-05
- **现象**: `--once` 模式下 ONDOUSDT 被 +1 react 了 **16 次**（05:40-09:00），1000CATUSDT 被 react **8 次**
- **证据**: `~/.susu/agent-decisions.jsonl` 里 ONDO 16 条、1000CAT 8 条 react+1 记录
- **Root cause**: `susu-agent-daemon@0.0.5` 的 `--once` 模式没有持久化 "this signal already evaluated" 状态。每次 cron 起来重新读 channel 最近 N 条 inbound history，对同一条信号重新 LLM 评估并 react
- **影响**: 
  - LLM 费用浪费（16 次 ≈ 原来估计的 5 倍）
  - @sghy 那边的 native paper engine 没有 cooldown，每收到一次 +1 就开一仓 → $100 → $39.48 资金曲线（多仓叠加亏损）
  - Wizard 这边因 peer_follow 的 24h symbol cooldown 只开了 1 仓，不受影响
- **修复方向**: daemon 在处理前检查是否已对该 signal_id react 过（查 decision log 或维护已处理 set）
- **优先级**: 最高 — @sghy 还在持续被 spam

### P3: entry_ts_ms 字段语义错误
- **发现日期**: 2026-05-05
- **现象**: push 给 @sghy 的信号 entry_ts_ms 字段填的是 1h K 线 open ts（last_bar.ts），不是实际下单时刻
- **Root cause**: `susurration_relay.py:157` — `"entry_ts_ms": p.entry_ts`，而 `p.entry_ts = last_bar.ts`（在 `alert_driven.py:542` 设置）
- **实际 lag**: 15-30min（不是 sghy 感知的 3-4h，感知偏差可能因 P1 排队放大）
- **影响**: @sghy 看到的 entry 时间不准确，误判信号时效性
- **修复**: 改为填实际 broker insert 时刻，约 5 分钟工作量
- **归属**: Wizard 侧代码（panopticon），非 susu-agent-daemon

## 已发版

### daemon 0.0.6 — P1 fix: --once 模式 signal dedup
- `loadAlreadyProcessedIds()` 读 decision log 提取已处理 signal_id/reaction_id
- actionable filter 跳过已评估事件
- 终端输出 skipped 数量

### CLI 0.0.22 — susu join --no-paper
- 交互模式加一步问 "Do you have your own paper trading system?"
- 非交互模式 `--no-paper` flag
