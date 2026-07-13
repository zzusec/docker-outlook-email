#!/usr/bin/env bash
# One-shot install / deploy for cf-outlook-email on Cloudflare Workers.
# Covers the steps people usually mess up:
#   deps → login → D1 create/reuse → write wrangler.toml → secrets → migrate → deploy
#
# Usage:
#   ./install.sh
#   ADMIN_PASSWORD='your-pass' ./install.sh
#   ./install.sh --password 'your-pass'
#   ./install.sh --skip-login --skip-deps   # re-deploy only
#   ./install.sh --no-deploy               # stop after migrate
#
# Env:
#   ADMIN_PASSWORD   login password (prompted if unset)
#   COOKIE_SECRET    cookie HMAC secret (auto-generated if unset)
#   GPTMAIL_API_KEY  optional
#   WORKER_NAME      default: outlook-email
#   D1_NAME          default: outlook-email-db

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WORKER_NAME="${WORKER_NAME:-outlook-email}"
D1_NAME="${D1_NAME:-outlook-email-db}"
EXAMPLE_TOML="wrangler.toml.example"
TOML="wrangler.toml"

SKIP_DEPS=0
SKIP_LOGIN=0
NO_DEPLOY=0
YES=0
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
COOKIE_SECRET="${COOKIE_SECRET:-}"
GPTMAIL_API_KEY="${GPTMAIL_API_KEY:-}"

# ---- colors / log ----------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
else
  C_RESET=; C_BOLD=; C_DIM=; C_GREEN=; C_YELLOW=; C_RED=; C_CYAN=
fi

step()  { printf '\n%s==> %s%s\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
info()  { printf '  %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  -p, --password STR   Admin login password (or set ADMIN_PASSWORD)
  --cookie-secret STR  Cookie HMAC secret (or set COOKIE_SECRET; auto if empty)
  --gptmail-key STR    Optional GPTMail API key
  --worker-name NAME   Worker name (default: outlook-email)
  --d1-name NAME       D1 database name (default: outlook-email-db)
  --skip-deps          Skip pnpm/npm install
  --skip-login         Skip wrangler login check / prompt
  --no-deploy          Stop after migrations (do not deploy)
  -y, --yes            Non-interactive where possible (still needs password unless set)
  -h, --help           Show this help

Examples:
  ./install.sh
  ADMIN_PASSWORD='s3cret' ./install.sh -y
  ./install.sh --password 's3cret' --skip-login
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --cookie-secret) COOKIE_SECRET="${2:-}"; shift 2 ;;
    --gptmail-key) GPTMAIL_API_KEY="${2:-}"; shift 2 ;;
    --worker-name) WORKER_NAME="${2:-}"; shift 2 ;;
    --d1-name) D1_NAME="${2:-}"; shift 2 ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --skip-login) SKIP_LOGIN=1; shift ;;
    --no-deploy) NO_DEPLOY=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (try --help)" ;;
  esac
done

# ---- helpers ---------------------------------------------------------------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1。请先安装后再跑本脚本。"
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

pick_pkg() {
  if command -v pnpm >/dev/null 2>&1; then
    echo pnpm
  elif command -v npm >/dev/null 2>&1; then
    echo npm
  else
    fail "需要 pnpm 或 npm。安装 pnpm: npm install -g pnpm"
  fi
}

# Run wrangler via local node_modules first, fall back to npx.
WRANGLER=()
setup_wrangler() {
  if [[ -x "$ROOT/node_modules/.bin/wrangler" ]]; then
    WRANGLER=("$ROOT/node_modules/.bin/wrangler")
  elif command -v pnpm >/dev/null 2>&1 && [[ -f "$ROOT/package.json" ]]; then
    WRANGLER=(pnpm exec wrangler)
  elif command -v npx >/dev/null 2>&1; then
    WRANGLER=(npx --yes wrangler)
  else
    fail "找不到 wrangler。请先 pnpm install / npm install。"
  fi
}

wr() {
  "${WRANGLER[@]}" "$@"
}

# wrangler d1 migrations apply may prompt "continue?" — answer yes automatically.
wr_yes() {
  # Prefer non-interactive flags when available; also pipe yes as fallback.
  if command -v yes >/dev/null 2>&1; then
    yes | wr "$@" 2>&1 || wr "$@"
  else
    wr "$@"
  fi
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    # Portable fallback
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  fi
}

# Extract a UUID database_id from free-form wrangler output.
extract_db_id() {
  # Prefer the toml assignment form, then bare UUID.
  local text="$1"
  local id
  id="$(printf '%s\n' "$text" | sed -n 's/.*database_id[[:space:]]*=[[:space:]]*"\([0-9a-fA-F-]\{36\}\)".*/\1/p' | head -n1)"
  if [[ -z "$id" ]]; then
    id="$(printf '%s\n' "$text" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n1 || true)"
  fi
  printf '%s' "$id"
}

read_toml_db_id() {
  if [[ ! -f "$TOML" ]]; then
    echo ""
    return
  fi
  sed -n 's/^[[:space:]]*database_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TOML" | head -n1
}

write_wrangler_toml() {
  local db_id="$1"
  if [[ ! -f "$EXAMPLE_TOML" ]]; then
    fail "缺少 $EXAMPLE_TOML，无法生成 $TOML"
  fi
  # Keep example as source of truth; only swap name + database_id.
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2002
  cat "$EXAMPLE_TOML" \
    | sed "s/^name = \".*\"/name = \"${WORKER_NAME}\"/" \
    | sed "s/^database_name = \".*\"/database_name = \"${D1_NAME}\"/" \
    | sed "s/REPLACE_WITH_YOUR_DATABASE_ID/${db_id}/" \
    > "$tmp"

  if ! grep -q "$db_id" "$tmp"; then
    rm -f "$tmp"
    fail "写入 $TOML 失败：database_id 未替换成功"
  fi
  if grep -q 'REPLACE_WITH_YOUR_DATABASE_ID' "$tmp"; then
    rm -f "$tmp"
    fail "写入 $TOML 失败：仍是占位符"
  fi
  mv "$tmp" "$TOML"
  ok "已写入 $TOML (database_id=${db_id})"
}

put_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    warn "跳过 secret $name（值为空）"
    return
  fi
  # Non-interactive: pipe value to wrangler secret put
  printf '%s' "$value" | wr secret put "$name" --name "$WORKER_NAME" >/dev/null
  ok "已设置 secret: $name"
}

# ---- banner ----------------------------------------------------------------
printf '%s\n' "${C_BOLD}cf-outlook-email 一键安装 / 部署${C_RESET}"
printf '%s\n' "${C_DIM}项目目录: $ROOT${C_RESET}"

# ---- 1. prerequisites ------------------------------------------------------
step "检查运行环境"
need_cmd node
need_cmd git
NODE_MAJOR="$(node_major)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "需要 Node.js 18+，当前: $(node --version 2>/dev/null || echo unknown)"
fi
ok "Node.js $(node --version)"

PKG="$(pick_pkg)"
ok "包管理器: $PKG"

# ---- 2. install deps -------------------------------------------------------
if [[ "$SKIP_DEPS" -eq 0 ]]; then
  step "安装依赖 ($PKG install)"
  if [[ "$PKG" == "pnpm" ]]; then
    pnpm install
  else
    npm install
  fi
  ok "依赖安装完成"
else
  warn "已跳过依赖安装 (--skip-deps)"
fi

setup_wrangler
ok "wrangler: ${WRANGLER[*]}"
WR_VER="$(wr --version 2>/dev/null | head -n1 || true)"
[[ -n "$WR_VER" ]] && info "$WR_VER"

# ---- 3. cloudflare login ---------------------------------------------------
if [[ "$SKIP_LOGIN" -eq 0 ]]; then
  step "检查 Cloudflare 登录状态"
  if wr whoami >/dev/null 2>&1; then
    ok "已登录 Cloudflare"
    wr whoami 2>/dev/null | sed 's/^/  /' || true
  else
    warn "未登录，即将打开浏览器授权 (wrangler login)"
    wr login
    wr whoami >/dev/null 2>&1 || fail "登录失败：wrangler whoami 仍不可用"
    ok "登录成功"
  fi
else
  warn "已跳过登录检查 (--skip-login)"
  wr whoami >/dev/null 2>&1 || fail "当前未登录 Cloudflare，且指定了 --skip-login"
fi

# ---- 4. D1 database --------------------------------------------------------
step "准备 D1 数据库 ($D1_NAME)"
DB_ID=""
EXISTING_TOML_ID="$(read_toml_db_id)"
if [[ -n "$EXISTING_TOML_ID" && "$EXISTING_TOML_ID" != "REPLACE_WITH_YOUR_DATABASE_ID" ]]; then
  DB_ID="$EXISTING_TOML_ID"
  ok "复用 $TOML 中的 database_id=$DB_ID"
else
  # Try list existing DBs first (idempotent re-run)
  LIST_OUT="$(wr d1 list 2>/dev/null || true)"
  if printf '%s' "$LIST_OUT" | grep -q "$D1_NAME"; then
    # wrangler d1 list table/json varies by version — grab UUID on the same line as name when possible
    DB_ID="$(printf '%s\n' "$LIST_OUT" | grep -F "$D1_NAME" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n1 || true)"
    if [[ -n "$DB_ID" ]]; then
      ok "发现已有远程库 $D1_NAME (id=$DB_ID)，直接复用"
    fi
  fi

  if [[ -z "$DB_ID" ]]; then
    info "创建 D1：$D1_NAME"
    CREATE_OUT="$(wr d1 create "$D1_NAME" 2>&1)" || {
      # Already exists → parse from error / re-list
      if printf '%s' "$CREATE_OUT" | grep -qiE 'already exists|A database with that name already exists'; then
        warn "库名已存在，尝试从列表解析 id"
        LIST_OUT="$(wr d1 list 2>&1 || true)"
        DB_ID="$(printf '%s\n' "$LIST_OUT" | grep -F "$D1_NAME" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n1 || true)"
      else
        printf '%s\n' "$CREATE_OUT" >&2
        fail "创建 D1 失败"
      fi
    }
    if [[ -z "$DB_ID" ]]; then
      DB_ID="$(extract_db_id "$CREATE_OUT")"
    fi
  fi

  [[ -n "$DB_ID" ]] || fail "无法得到 database_id。请手动: wrangler d1 create $D1_NAME"
  write_wrangler_toml "$DB_ID"
fi

# Ensure wrangler.toml exists and is not a placeholder even if we reused id.
if [[ ! -f "$TOML" ]] || grep -q 'REPLACE_WITH_YOUR_DATABASE_ID' "$TOML" 2>/dev/null; then
  [[ -n "$DB_ID" ]] || DB_ID="$(read_toml_db_id)"
  [[ -n "$DB_ID" && "$DB_ID" != "REPLACE_WITH_YOUR_DATABASE_ID" ]] || fail "database_id 无效"
  write_wrangler_toml "$DB_ID"
fi

# Sync worker/db names if user overrode defaults and toml already existed.
if [[ -f "$TOML" ]]; then
  # Only rewrite when names differ from desired.
  CUR_NAME="$(sed -n 's/^name = "\(.*\)"/\1/p' "$TOML" | head -n1)"
  CUR_DB="$(sed -n 's/^database_name = "\(.*\)"/\1/p' "$TOML" | head -n1)"
  CUR_ID="$(read_toml_db_id)"
  if [[ "$CUR_NAME" != "$WORKER_NAME" || "$CUR_DB" != "$D1_NAME" ]]; then
    write_wrangler_toml "$CUR_ID"
  fi
fi

# ---- 5. secrets ------------------------------------------------------------
step "配置 Secrets"
if [[ -z "$ADMIN_PASSWORD" ]]; then
  if [[ "$YES" -eq 1 ]]; then
    fail "非交互模式 (-y) 必须提供密码：ADMIN_PASSWORD=... 或 --password"
  fi
  if [[ -t 0 ]]; then
    printf '  请输入后台登录密码 (ADMIN_PASSWORD，输入不回显): '
    stty -echo
    IFS= read -r ADMIN_PASSWORD
    stty echo
    printf '\n'
  else
    fail "未设置 ADMIN_PASSWORD，且当前不是交互终端"
  fi
fi
[[ -n "$ADMIN_PASSWORD" ]] || fail "ADMIN_PASSWORD 不能为空"
if [[ "${#ADMIN_PASSWORD}" -lt 4 ]]; then
  fail "ADMIN_PASSWORD 至少 4 位"
fi

if [[ -z "$COOKIE_SECRET" ]]; then
  COOKIE_SECRET="$(gen_secret)"
  ok "已自动生成 COOKIE_SECRET"
else
  ok "使用提供的 COOKIE_SECRET"
fi

put_secret ADMIN_PASSWORD "$ADMIN_PASSWORD"
put_secret COOKIE_SECRET "$COOKIE_SECRET"
if [[ -n "$GPTMAIL_API_KEY" ]]; then
  put_secret GPTMAIL_API_KEY "$GPTMAIL_API_KEY"
fi

# ---- 6. migrations ---------------------------------------------------------
step "应用 D1 迁移 (remote)"
# Some wrangler versions prompt; feed yes. Also accept "already applied".
set +e
MIG_OUT="$(wr d1 migrations apply "$D1_NAME" --remote --yes 2>&1)"
MIG_CODE=$?
if [[ $MIG_CODE -ne 0 ]]; then
  # Older wrangler may not support --yes
  MIG_OUT="$(printf 'y\n' | wr d1 migrations apply "$D1_NAME" --remote 2>&1)"
  MIG_CODE=$?
fi
set -e
printf '%s\n' "$MIG_OUT" | sed 's/^/  /'
if [[ $MIG_CODE -ne 0 ]]; then
  # Treat "no migrations" / already applied as success-ish
  if printf '%s' "$MIG_OUT" | grep -qiE 'No migrations|already|nothing to apply|successfully'; then
    ok "迁移无需变更或已应用"
  else
    fail "迁移失败。可手动: ${WRANGLER[*]} d1 migrations apply $D1_NAME --remote"
  fi
else
  ok "迁移完成"
fi

# ---- 7. deploy -------------------------------------------------------------
if [[ "$NO_DEPLOY" -eq 1 ]]; then
  warn "已跳过部署 (--no-deploy)"
  info "稍后执行: ${WRANGLER[*]} deploy"
  exit 0
fi

step "部署 Worker"
DEPLOY_OUT="$(wr deploy 2>&1)" || {
  printf '%s\n' "$DEPLOY_OUT" >&2
  fail "部署失败"
}
printf '%s\n' "$DEPLOY_OUT" | sed 's/^/  /'

URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -Eo 'https://[a-zA-Z0-9._/-]+\.workers\.dev' | head -n1 || true)"
if [[ -z "$URL" ]]; then
  URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -Eo 'https://[a-zA-Z0-9._/-]+' | head -n1 || true)"
fi

step "完成"
ok "部署成功"
if [[ -n "$URL" ]]; then
  info "访问地址: ${C_BOLD}${URL}${C_RESET}"
else
  info "请在上方 deploy 输出中查看 workers.dev URL"
fi
info "登录密码: 你刚才设置的 ADMIN_PASSWORD"
info ""
info "常用后续命令:"
info "  ${WRANGLER[*]} deploy                              # 再次部署"
info "  ${WRANGLER[*]} d1 migrations apply $D1_NAME --remote"
info "  ${WRANGLER[*]} secret put ADMIN_PASSWORD            # 改登录密码"
info "  ${WRANGLER[*]} tail                                 # 看线上日志"
info ""
info "说明: wrangler.toml 含 database_id，已在 .gitignore 中，请勿提交到公开仓库。"
