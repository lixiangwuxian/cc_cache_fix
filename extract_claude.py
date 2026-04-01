#!/usr/bin/env python3
"""
extract_claude.py — Extract JS source from Claude Code standalone binary,
apply JS-level patches, and create a wrapper script.

This bypasses the native-layer sentinel scanner (Bug 1) by running the
extracted JS through standard Bun instead of the embedded custom fork.

Bug 2 (--resume cache regression) is patched directly in the JS source.

Usage:
  python3 extract_claude.py                     # extract from installed claude
  python3 extract_claude.py /path/to/claude     # extract from specific binary
Output:
  ./claude_patched.js   — extracted + patched JS source
  ./claude-run          — wrapper script (use instead of `claude`)
"""

import hashlib
import os
import re
import subprocess
import sys


def find_binary():
    result = subprocess.run(["which", "claude"], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    return os.path.realpath(result.stdout.strip())


def get_bun_section(binary_path):
    result = subprocess.run(
        ["readelf", "-SW", binary_path], capture_output=True, text=True
    )
    for line in result.stdout.split("\n"):
        if ".bun" in line and "PROGBITS" in line:
            parts = line.split()
            for i, p in enumerate(parts):
                if p == ".bun":
                    return int(parts[i + 3], 16), int(parts[i + 4], 16)
    return None, None


def extract_js(binary_path):
    """Extract JS source from the .bun section of a Bun standalone binary."""
    bun_offset, bun_size = get_bun_section(binary_path)
    if bun_offset is None:
        print("✗ Cannot find .bun section")
        return None

    with open(binary_path, "rb") as f:
        f.seek(bun_offset)
        bun_data = f.read(bun_size)

    cjs_marker = b"(function(exports, require, module, __filename, __dirname) {"
    cjs_start = bun_data.find(cjs_marker)
    if cjs_start == -1:
        print("✗ Cannot find CJS wrapper in .bun section")
        return None

    js_raw = bun_data[cjs_start:]

    # The CJS wrapper ends with "})\n" followed by null bytes (bytecode/metadata).
    # Find this boundary generically — no version-specific anchors needed.
    #
    # Strategy: search for "})\n\x00" which marks the CJS close followed by
    # the start of binary data. We search from a reasonable minimum offset
    # (1MB) to skip any occurrences inside string literals early in the source.
    min_offset = 0x100000  # 1 MB — JS bundle is always larger than this
    cjs_close_pattern = b"})\n\x00"
    close_idx = js_raw.find(cjs_close_pattern, min_offset)

    if close_idx != -1:
        # The "})" is the CJS wrapper close: "}" ends the function body,
        # ")" closes the outer "(". We want just the function body, so
        # exclude both the opening prefix and the closing "})".
        js_end = close_idx
    else:
        # Fallback: scan for transition from printable text to binary data,
        # using a sliding window with fine granularity.
        print("  ⚠ CJS close pattern not found, using heuristic boundary")
        js_end = len(js_raw)
        window = 64
        for i in range(min_offset, len(js_raw) - window, 256):
            chunk = js_raw[i : i + window]
            printable = sum(1 for b in chunk if 32 <= b < 127 or b in (10, 13, 9))
            if printable < window * 0.3:
                # Back-track to find the last "})" before this binary region
                segment = js_raw[max(0, i - 4096) : i]
                last_close = segment.rfind(b"})")
                if last_close != -1:
                    js_end = max(0, i - 4096) + last_close
                else:
                    js_end = i
                break

    js_source = js_raw[:js_end]

    # Strip outer CJS wrapper prefix — we already excluded the closing "})"
    inner = js_source[len(cjs_marker) :]
    inner = inner.rstrip()

    return inner


def apply_js_patches(js_bytes):
    """No static patches needed.

    After extraction, the JS runs via standard Bun — the native sentinel
    scanner (Bug 1) is completely absent, so cch=00000 stays as-is.
    system[0] has cache_control: null and does not participate in prompt
    caching, so neither cch nor cc_version hash affect cache hits.

    Bug 2 is handled entirely by the runtime fetch hook (cache_fix_hook.js).
    """
    return js_bytes, []


def create_wrapper(output_dir, js_filename):
    """Create a shell wrapper script to run the patched JS via bun."""
    wrapper_path = os.path.join(output_dir, "claude-run")

    js_path = os.path.join(output_dir, js_filename)
    abs_js = os.path.abspath(js_path)

    hook_path = os.path.join(output_dir, "cache_fix_hook.js")
    abs_hook = os.path.abspath(hook_path)

    wrapper = f"""#!/usr/bin/env bash
# claude-run — Run patched Claude Code JS via standard Bun runtime.
# Bypasses the standalone binary's native sentinel scanner (Bug 1).
# Fetch hook normalizes messages[] for --resume cache alignment (Bug 2).
#
# Usage: same as `claude`, e.g.:
#   ./claude-run -p "hello"
#   ./claude-run --resume <session-id>
#
# To capture before/after payloads for debugging:
#   CLAUDE_CACHE_FIX_CAPTURE=1 ./claude-run -p "hello"
#
# Generated by extract_claude.py

exec bun run --preload "{abs_hook}" "{abs_js}" "$@"
"""
    with open(wrapper_path, "w") as f:
        f.write(wrapper)
    os.chmod(wrapper_path, 0o755)
    return wrapper_path


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0

    output_dir = os.path.dirname(os.path.abspath(__file__))
    js_output = os.path.join(output_dir, "claude_patched.js")

    binary_path = None
    for arg in sys.argv[1:]:
        if not arg.startswith("-"):
            binary_path = arg
            break

    if not binary_path:
        binary_path = find_binary()

    if not binary_path:
        print("✗ Cannot find claude binary. Provide path as argument.")
        return 1

    if not os.path.isfile(binary_path):
        print(f"✗ File not found: {binary_path}")
        return 1

    print(f"{'═' * 60}")
    print(f"  Claude Code JS Extractor")
    print(f"  Source: {binary_path}")
    print(f"{'═' * 60}")
    print()

    # Step 1: Extract JS
    print("  Step 1: Extracting JS from .bun section...")
    js_bytes = extract_js(binary_path)
    if js_bytes is None:
        return 1
    print(f"  → Extracted {len(js_bytes):,} bytes of JS source")
    print()

    # Step 2: Write output (no static patches needed — see apply_js_patches docstring)
    with open(js_output, "wb") as f:
        f.write(js_bytes)
    print(f"  Step 2: Wrote {js_output}")

    sha = hashlib.sha256(js_bytes).hexdigest()[:16]
    print(f"  SHA-256: {sha}...")
    print()

    # Step 3: Create wrapper
    wrapper_path = create_wrapper(output_dir, "claude_patched.js")
    print(f"  Step 3: Created wrapper {wrapper_path}")

    print()
    print(f"{'═' * 60}")
    print(f"  ✓ Done!")
    print(f"{'═' * 60}")
    print()
    print("  How to use:")
    print(f"    {wrapper_path} -p 'hello world'")
    print(f"    {wrapper_path} --resume <session-id>")
    print()
    print("  Or add to PATH:")
    print(f"    ln -sf {os.path.abspath(wrapper_path)} ~/.local/bin/claude-patched")
    print()
    print("  Bug 1 fix: Running via standard bun (not standalone) → native scanner absent")
    print("  Bug 2 fix: cache_fix_hook.js normalizes messages[] on --resume")
    print()
    print("  ⚠ After Claude Code updates, re-run this script to re-extract.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
