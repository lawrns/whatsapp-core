#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# scripts/secret-scan.sh — the single entry point for local secret scanning.
#
# Called by the pre-commit hook with no arguments (scans staged content), or
# run by hand with `--tree` to scan the whole working tree the way CI does.
#
# Design notes, which are the whole point of this file:
#
#   * It does NOT silently skip when gitleaks is missing. The doctormx hook did
#     that, which made the gate a no-op on every machine that hadn't run
#     `brew install gitleaks`. Instead this script downloads a pinned gitleaks
#     into .git/ on first use, and hard-fails with instructions if it can't.
#   * It has no `|| true`. A non-zero gitleaks exit blocks the commit.
#   * The escape hatch is explicit and loud: SKIP_SECRET_SCAN=1 git commit ...
# ---------------------------------------------------------------------------
set -eu

GITLEAKS_VERSION="8.28.0"

if [ "${SKIP_SECRET_SCAN:-}" = "1" ]; then
  printf '\033[33m! secret scan skipped via SKIP_SECRET_SCAN=1 — CI will still block.\033[0m\n' >&2
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --git-common-dir)
case "$git_dir" in /*) : ;; *) git_dir="$repo_root/$git_dir" ;; esac
cache_dir="$git_dir/secret-scan"
bin="$cache_dir/gitleaks-$GITLEAKS_VERSION"

resolve_gitleaks() {
  if [ -x "$bin" ]; then echo "$bin"; return 0; fi
  if command -v gitleaks >/dev/null 2>&1; then echo "gitleaks"; return 0; fi

  # Fetch a pinned build into .git/ (never committed, never on PATH).
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) return 1 ;;
  esac
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.tar.gz"

  mkdir -p "$cache_dir"
  printf 'secret-scan: fetching gitleaks %s ...\n' "$GITLEAKS_VERSION" >&2
  if curl -sSfL "$url" | tar -xz -C "$cache_dir" gitleaks 2>/dev/null; then
    mv "$cache_dir/gitleaks" "$bin"
    chmod +x "$bin"
    echo "$bin"
    return 0
  fi
  return 1
}

if ! GL=$(resolve_gitleaks); then
  cat >&2 <<EOF

  ✗ secret scan could not run: gitleaks is not installed and could not be downloaded.

    This hook does NOT skip on a missing scanner — that is how credentials got
    committed in the first place. Install it and retry:

        brew install gitleaks            # macOS
        # or grab a binary from https://github.com/gitleaks/gitleaks/releases

    If you are certain this commit is clean and you need to move now:

        SKIP_SECRET_SCAN=1 git commit ...

    CI will still block the pull request.

EOF
  exit 1
fi

if [ "${1:-}" = "--tree" ]; then
  exec "$GL" dir "$repo_root" \
    --config "$repo_root/.gitleaks.toml" --redact --no-banner --exit-code 1 --verbose
fi

# Hard-block adding or modifying any .env file. Deletions are fine.
# (Carried over from doctormx's hook, which had this right.)
staged_env=$(git -C "$repo_root" diff --cached --name-only --diff-filter=ACMR \
             | grep -E '(^|/)\.env($|\.)' | grep -vE '\.(example|template|sample)$' || true)
if [ -n "$staged_env" ]; then
  printf '\n  ✗ Refusing to commit env file(s):\n' >&2
  printf '      %s\n' $staged_env >&2
  printf '    Secrets belong in the platform secret store, not in git.\n\n' >&2
  exit 1
fi

if "$GL" protect --staged \
     --source "$repo_root" \
     --config "$repo_root/.gitleaks.toml" \
     --redact --no-banner --exit-code 1 --verbose; then
  exit 0
fi

cat >&2 <<EOF

  ✗ A secret was found in the staged changes (values redacted above).

    Remove it from the diff and use an environment variable or the platform's
    secret store instead. Do NOT add a path or a file extension to
    .gitleaks.toml to make this go away — that is exactly the hole that let the
    2026-07-26 leaks through.

    If this is genuinely a false positive, allowlist the specific value in
    .gitleaks.toml, or pin the reported Fingerprint in .gitleaksignore with a
    one-line comment saying why.

EOF
exit 1
