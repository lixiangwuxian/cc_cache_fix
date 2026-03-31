# Claude Code 缓存修复补丁说明

## 背景

Claude Code standalone binary（228MB ELF）存在两个独立的 prompt cache bug，会导致缓存失效、费用膨胀 10-20x。详见 [analyze.md](analyze.md)。

本补丁通过 **提取 JS → 脱离定制 Bun 运行 → 运行时 hook 规范化请求** 的方式修复。

---

## 补丁做了什么

### 第一层：JS 提取（`extract_claude.py`）

从 standalone binary 的 `.bun` ELF section 中提取出 JS 源码（~12MB），脱离 Anthropic 定制 Bun fork，改用系统已安装的 Bun 运行。

**这一步本身就完整修复了 Bug 1**：native sentinel scanner 是定制 Bun fork 的原生代码（Zig 层），提取 JS 后用标准 Bun 运行，scanner 完全不存在。JS 源码无需任何修改——`cch=00000` 原样保留在 `system[0]` 的 billing header 中，但 `system[0]` 的 `cache_control` 值为 `null`（即不是缓存断点），其内容无论怎么变化都不影响 prompt cache 命中。`cc_version` hash（`[4,7,20]`）同理，也只写入 `system[0]`。

**信息损失**：无。提取出的 JS 与 binary 内嵌的完全相同，零修改。

### 第二层：运行时 fetch hook（`cache_fix_hook.js`）

通过 `bun run --preload` 在 `globalThis.fetch` 上挂载 hook，在每次 `/v1/messages` 请求发出前，对 JSON payload 做规范化处理。

#### 触发条件

仅当检测到 `--resume` 模式时生效（即 `messages[1]` 缺少 hooks/skills blocks，而 `messages[最后一条 user]` 包含这些 blocks）。

#### 具体操作

**操作 1：移动 system-reminder blocks**

```
修复前（resume）:
  messages[1]  = [claudeMd(810), user_text(16)]        ← 缺失 hooks/skills
  messages[N]  = [hooks(8400), memory(900), skills(12390), user_text(18)]

修复后（resume）:
  messages[1]  = [hooks(7922), skills(12390), claudeMd(810), user_text(16)]  ← 与 fresh 一致
  messages[N]  = [memory(900), user_text(18)]           ← hooks/skills 已移走
```

将 HOOKS block（SessionStart hook 上下文）和 SKILLS block（技能列表）从最后一条用户消息移动到 `messages[1]` 的前部。移动后 `messages[1]` 的 token 前缀与 fresh session 完全对齐，从而命中前缀缓存。

**信息损失**：无。blocks 只是在消息间移动位置。模型仍然能看到完全相同的 hooks、skills、memory 和用户文本内容。唯一变化是这些 `<system-reminder>` 元数据 blocks 出现在对话中的位置——从最后一条消息移到了第一条用户消息。由于 `<system-reminder>` 本身就是给模型的元上下文标签，位置变化对模型行为影响可忽略。

**操作 2：Skills 列表排序**

```
修复前: - dispatching-parallel-agents: ...
        - brainstorming: ...
        - finishing-a-development-branch: ...

修复后: - brainstorming: ...
        - dispatching-parallel-agents: ...
        - finishing-a-development-branch: ...
```

将 skills listing block 内的条目按字母排序。Claude Code 每次生成 skills 列表时条目顺序不确定，排序后保证每次请求内容相同，避免因顺序不同导致 token 不对齐。

**信息损失**：无。所有 skill 条目完整保留，仅改变排列顺序。

**操作 3：转移 `<session_knowledge>`**

```
修复前（HOOKS block 内）:
  ...<context_window_protection>...</context_window_protection>
  <session_knowledge source="continue">
    <session_guide>## Last Request ...</session_guide>
    <session_search>...</session_search>
  </session_knowledge>
  </system-reminder>

修复后（HOOKS block 内 — 与 fresh 对齐）:
  ...<context_window_protection>...</context_window_protection>
  </system-reminder>

修复后（messages[N] 最后一条用户消息尾部）:
  world
  <session_knowledge source="continue">...</session_knowledge>
```

从 HOOKS block 中提取 `<session_knowledge>` 标签，追加到最后一条用户消息的文本末尾。这样 HOOKS block 的大小与 fresh 一致（7922 字符），保证前缀对齐；同时 `<session_knowledge>` 的内容在请求中完整保留，模型在生成回复前仍能读到。

**信息损失**：无。`<session_knowledge>` 仅变更位置（从 `messages[1]` 的 HOOKS block 内部 → `messages[N]` 的用户文本末尾），内容完整保留。

**操作 4：cache_control 断点调整**

将 `cache_control: {type: "ephemeral"}` 标记从 `messages[N]`（最后一条用户消息的最后一个 block）移动到 `messages[1]`（第一条用户消息的最后一个 block）。

**信息损失**：无。`cache_control` 是给 API 的缓存提示，不是模型看到的内容。

---

## 文件清单

| 文件 | 用途 |
|------|------|
| `extract_claude.py` | 提取脚本：从 binary 提取 JS（零修改）、生成 wrapper |
| `cache_fix_hook.js` | 运行时 hook：规范化 API 请求 payload（Bug 2 修复核心） |
| `claude_patched.js` | 提取后的 JS 源码（自动生成，与 binary 内嵌 JS 完全相同） |
| `claude-run` | Wrapper 脚本（自动生成），替代 `claude` 命令使用 |

---

## 使用方法

### 前置条件

- 已安装 Claude Code standalone binary（`claude` 命令可用）
- 系统已安装 `bun`（Claude Code 安装时自带，路径通常在 `~/.bun/bin/bun`）
- 已安装 `readelf`（Linux 通常自带）
- Python 3.6+

### Step 1：提取并打 patch

```bash
python3 extract_claude.py
```

输出：
- `claude_patched.js` — 提取后的 JS（与 binary 内嵌完全相同）
- `claude-run` — 可直接使用的 wrapper 脚本

### Step 2：使用

用 `./claude-run` 替代 `claude` 命令，参数完全兼容：

```bash
# 普通使用
./claude-run

# 非交互式
./claude-run -p "hello world"

# Resume 会话（Bug 2 修复在此场景生效）
./claude-run --resume <session-id>

# 所有 claude 原生参数均支持
./claude-run --model opus -p "explain this code"
```

可选：创建符号链接加入 PATH：

```bash
ln -sf ~/cc-cache-fail-analyze/claude-run ~/.local/bin/claude-patched
```

### Step 3：调试/验证

如需查看 hook 对请求 payload 的修改，设置环境变量：

```bash
CLAUDE_CACHE_FIX_CAPTURE=1 ./claude-run -p "test"
```

修改前后的完整 payload 会保存到 `captures/` 目录下的 JSON 文件。

### Claude Code 更新后

Claude Code 自动更新会覆盖 standalone binary。更新后需重新提取：

```bash
python3 extract_claude.py
```

---

## 修复效果量化

以实际测试数据为例（`--resume` 场景）：

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| `messages[1]` token 对齐率 | 0%（完全不同） | 98%（仅 claudeMd 中 memory 条目差异） |
| resume 首次请求 cache_read | ~15,000 tokens（仅 system prompt） | 预期覆盖 system + messages[0] + messages[1] 前缀 |
| 每次 resume 额外成本（500k ctx） | ~$0.15 | 大幅降低 |

### Bug 1（sentinel 替换）

通过脱离 standalone binary 运行，native scanner 完全不再生效。测试验证：发送含 `cch=00000` 的消息，模型原样返回 `cch=00000`（standalone 下会被替换为 `cch=bc298` 等）。

---

## 信息损失总结

| 操作 | 是否有损失 | 说明 |
|------|-----------|------|
| JS 提取脱离 standalone | 无 | 同一份 JS 代码零修改，换了运行时 |
| 移动 hooks/skills blocks | 无 | 内容完整保留，仅变更位置 |
| Skills 列表排序 | 无 | 条目完整，仅改变顺序 |
| 转移 `<session_knowledge>` | 无 | 从 HOOKS block 移至最后一条用户消息末尾，内容完整保留 |
| cache_control 断点移动 | 无 | API 级别缓存提示，不影响模型内容 |
