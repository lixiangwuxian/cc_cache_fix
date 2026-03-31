# Claude Code Prompt Cache Fix

[中文](/PATCH说明.md)

## Background

The Claude Code standalone binary (228MB ELF) has two independent prompt cache bugs that cause cache misses, inflating costs by 10-20x. See [this](https://www.reddit.com/r/ClaudeAI/comments/1s7mkn3/psa_claude_code_has_two_cache_bugs_that_can/) for the full analysis.

This patch fixes both by **extracting the JS bundle → running it via standard Bun → normalizing API requests at runtime**.

---

## What the Patch Does

### Layer 1: JS Extraction (`extract_claude.py`)

Extracts the JS source (~12MB) from the `.bun` ELF section of the standalone binary, then runs it via a standard Bun runtime instead of Anthropic's custom Bun fork.

**This alone fully fixes Bug 1.** The native sentinel scanner is Zig code baked into the custom Bun fork. When running extracted JS through standard Bun, the scanner simply doesn't exist. The JS source is unmodified — `cch=00000` remains as-is in the `system[0]` billing header, but `system[0]` has `cache_control: null` (not a cache breakpoint), so its content has zero impact on prompt cache hits. The `cc_version` hash (`[4,7,20]`) likewise only writes to `system[0]`.

**Information loss**: None. The extracted JS is byte-for-byte identical to what's embedded in the binary.

### Layer 2: Runtime Fetch Hook (`cache_fix_hook.js`)

Hooks `globalThis.fetch` via `bun run --preload` to normalize the JSON payload before every `/v1/messages` API request.

#### When It Activates

Only on `--resume` sessions — specifically when `messages[1]` lacks hooks/skills blocks but `messages[last_user]` contains them.

#### Operations

**Operation 1: Relocate system-reminder blocks**

```
Before (resume):
  messages[1]  = [claudeMd(810), user_text(16)]        ← missing hooks/skills
  messages[N]  = [hooks(8400), memory(900), skills(12390), user_text(18)]

After (resume):
  messages[1]  = [hooks(7922), skills(12390), claudeMd(810), user_text(16)]  ← matches fresh
  messages[N]  = [memory(900), user_text(18)]           ← hooks/skills moved out
```

Moves HOOKS (SessionStart hook context) and SKILLS (skill listings) blocks from the last user message to the front of `messages[1]`. This aligns the token prefix of `messages[1]` with a fresh session, enabling cache hits.

**Information loss**: None. Blocks are relocated, not removed. The model sees identical hooks, skills, memory, and user text — only the position of `<system-reminder>` metadata blocks changes.

**Operation 2: Sort skills listing**

```
Before: - dispatching-parallel-agents: ...
        - brainstorming: ...
        - finishing-a-development-branch: ...

After:  - brainstorming: ...
        - dispatching-parallel-agents: ...
        - finishing-a-development-branch: ...
```

Sorts skill entries alphabetically. Claude Code generates skill listings in non-deterministic order; sorting ensures identical content across requests to avoid token misalignment.

**Information loss**: None. All skill entries preserved, only ordering changes.

**Operation 3: Relocate `<session_knowledge>`**

```
Before (inside HOOKS block):
  ...<context_window_protection>...</context_window_protection>
  <session_knowledge source="continue">
    <session_guide>## Last Request ...</session_guide>
    <session_search>...</session_search>
  </session_knowledge>
  </system-reminder>

After (HOOKS block — aligned with fresh):
  ...<context_window_protection>...</context_window_protection>
  </system-reminder>

After (appended to messages[N], the last user message):
  world
  <session_knowledge source="continue">...</session_knowledge>
```

Extracts the `<session_knowledge>` tag from the HOOKS block and appends it to the text of the last user message. This keeps the HOOKS block size consistent with fresh sessions (7922 chars) for prefix alignment, while fully preserving the session knowledge content for the model to read before generating a response.

**Information loss**: None. `<session_knowledge>` is relocated (from inside the HOOKS block in `messages[1]` → end of user text in `messages[N]`), content fully preserved.

**Operation 4: Adjust `cache_control` breakpoints**

Moves `cache_control: {type: "ephemeral"}` from `messages[N]` (last block of last user message) to `messages[1]` (last block of first user message), matching fresh session structure.

**Information loss**: None. `cache_control` is an API-level caching hint, not model-visible content.

---

## Files

| File | Purpose |
|------|---------|
| `extract_claude.py` | Extraction script: extracts JS from binary (unmodified), generates wrapper |
| `cache_fix_hook.js` | Runtime hook: normalizes API request payloads (core Bug 2 fix) |
| `claude_patched.js` | Extracted JS source (auto-generated, identical to binary-embedded JS) |
| `claude-run` | Wrapper script (auto-generated), drop-in replacement for `claude` |

---

## Usage

### Prerequisites

- Claude Code standalone binary installed (`claude` command available)
- `bun` installed (Claude Code installation typically includes it at `~/.bun/bin/bun`)
- `readelf` (standard on Linux)
- Python 3.6+

### Step 1: Extract

```bash
python3 extract_claude.py
```

Outputs:
- `claude_patched.js` — extracted JS (identical to binary-embedded)
- `claude-run` — ready-to-use wrapper script

### Step 2: Use

Replace `claude` with `./claude-run`. All arguments are fully compatible:

```bash
# Normal usage
./claude-run

# Non-interactive
./claude-run -p "hello world"

# Resume session (Bug 2 fix applies here)
./claude-run --resume <session-id>

# All native claude arguments supported
./claude-run --model opus -p "explain this code"
```

Optionally symlink into PATH:

```bash
ln -sf $(pwd)/claude-run ~/.local/bin/claude-patched
```

### Step 3: Debug / Verify

To inspect the hook's payload transformations:

```bash
CLAUDE_CACHE_FIX_CAPTURE=1 ./claude-run -p "test"
```

Before/after payloads are saved as JSON files in the `captures/` directory.

### After Claude Code Updates

Claude Code auto-updates overwrite the standalone binary. Re-run extraction after each update:

```bash
python3 extract_claude.py
```

---

## Measured Impact

Test data from a `--resume` scenario:

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| `messages[1]` token alignment | 0% (completely different) | 98% (only CLAUDE.md memory entries differ) |
| Resume first-request cache_read | ~15,000 tokens (system prompt only) | Expected to cover system + messages[0] + messages[1] prefix |
| Per-resume extra cost (500k ctx) | ~$0.15 | Significantly reduced |

### Bug 1 (sentinel replacement)

Running outside the standalone binary means the native scanner is completely absent. Verified: sending a message containing `cch=00000` returns it unchanged (standalone binary replaces it with `cch=bc298` etc.).

---

## Information Loss Summary

| Operation | Loss | Notes |
|-----------|------|-------|
| JS extraction from standalone | None | Identical JS, different runtime |
| Relocate hooks/skills blocks | None | Content fully preserved, only position changes |
| Sort skills listing | None | All entries preserved, only ordering changes |
| Relocate `<session_knowledge>` | None | Moved from HOOKS block to last user message, content fully preserved |
| Move `cache_control` breakpoint | None | API-level caching hint, not model-visible content |

---

## Version Compatibility

The hook uses content-based pattern detection, not version-specific offsets:
- Identifies blocks by `<system-reminder>` tag content
- Detects resume pattern dynamically from message structure
- If Anthropic fixes these bugs, the hook becomes a harmless no-op
