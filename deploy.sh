#!/usr/bin/env bash
# Push src/ to Apps Script and update the live /exec deployment in one go.
# Requires: .clasp.json present locally (gitignored, per-user).

set -euo pipefail

# 你自己的 Web app 部署 ID（從 Apps Script 編輯器「部署 ▸ 管理部署作業」複製，結尾那串）。
# 放進專案根目錄的 .deployment-id 檔（已 gitignore），或設環境變數 DEPLOYMENT_ID。詳見 docs/SETUP.md。
DEPLOYMENT_ID="${DEPLOYMENT_ID:-$(cat .deployment-id 2>/dev/null || true)}"

if [ ! -f .clasp.json ]; then
  echo "❌ .clasp.json not found in $(pwd)" >&2
  echo "   依 .clasp.json.example 建立、填入你的 scriptId 後再執行。" >&2
  exit 1
fi

if [ -z "${DEPLOYMENT_ID}" ]; then
  echo "❌ 未設定 DEPLOYMENT_ID（固定 /exec 部署需要它）。" >&2
  echo "   到 Apps Script 編輯器「部署 ▸ 管理部署作業」複製你的 Web app 部署 ID，" >&2
  echo "   寫進專案根目錄的 .deployment-id 檔（或 export DEPLOYMENT_ID=...）。見 docs/SETUP.md。" >&2
  exit 1
fi

# ── 自動對齊到「Claude 這次 session 的分支」────────────────────────────────────
# 為什麼要這段：Claude Code on the web 每個 session 會開一條新的 claude/* 分支，
# 而 `git pull` 只更新「你當前所在分支」。以前每換一個新對話視窗，工作樹常停在舊
# 分支 → clasp 一路推舊碼、deploy 還 ✅，結果 LINE 行為完全沒變（縮圖、新指令都沒上）。
# 這裡改成：每次 deploy 先 fetch，預設把工作樹對齊到 origin 上「最近更新的 claude/* 分支」，
# 再部署——你只要無腦跑 ./deploy.sh，永遠部到 Claude 最新的碼，不必記分支名。
#   覆蓋用法：./deploy.sh <分支名>   指定部署某分支
#             ./deploy.sh .          跳過自動切換、就部署目前工作樹
TARGET="${1:-}"
if [ "${TARGET}" = "." ]; then
  echo "▶ skip auto-sync（部署目前工作樹）"
else
  echo "▶ git fetch origin"
  git fetch --prune origin >/dev/null 2>&1 || echo "  ⚠️ fetch 失敗（離線？）—改用本機現有狀態繼續" >&2
  if [ -z "${TARGET}" ]; then
    # 沒指定 → 取 origin 上最近 commit 的 claude/* 分支
    TARGET=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' \
      'refs/remotes/origin/claude/*' 2>/dev/null | head -1 | sed 's#^origin/##')
  fi
  if [ -n "${TARGET}" ] && git rev-parse --verify "origin/${TARGET}" >/dev/null 2>&1; then
    echo "▶ 對齊工作樹 → origin/${TARGET}"
    if ! git checkout -B "${TARGET}" "origin/${TARGET}"; then
      echo "❌ 切換到 ${TARGET} 失敗——多半是本機有未提交的改動擋住。" >&2
      echo "   先跑  git stash  （.clasp.json 是 gitignore，不會被動到），再重跑 ./deploy.sh。" >&2
      exit 1
    fi
  else
    echo "  ⚠️ 找不到 origin/claude/* 分支，沿用目前分支 $(git branch --show-current 2>/dev/null)" >&2
  fi
fi
# ──────────────────────────────────────────────────────────────────────────────

DESC=$(git log -1 --pretty=%s 2>/dev/null || echo "manual deploy")
echo "▶ 即將部署 commit：$(git log -1 --pretty='%h %s' 2>/dev/null || echo '?')"

echo "▶ clasp push"
clasp push -f

echo "▶ clasp deploy  (id=${DEPLOYMENT_ID})"
# clasp push 已更新 editor 內的碼，但 LINE 的 /exec 只服務「最後一次 deploy 成功」的版本。
# 若 deploy 失敗（最常見：Apps Script 版本數到上限 ~200），/exec 仍跑舊碼——LINE 上看到的
# 行為不會變，而且不會有任何提示。故這裡攔下失敗、給出確切修法，避免「以為部署了其實沒」。
if ! clasp deploy --deploymentId "${DEPLOYMENT_ID}" --description "${DESC}"; then
  echo "" >&2
  echo "❌ clasp deploy 失敗：editor 內已是最新碼（push 成功），但 /exec 仍服務舊版本。" >&2
  echo "   最可能原因 = Apps Script 版本數已達上限（約 200）。" >&2
  echo "   一次性修法（屬部署維護，不是 editor 測試）：" >&2
  echo "     1) 開 https://script.google.com → 本專案" >&2
  echo "     2) 右上「部署 ▸ 管理部署作業」，刪掉一批用不到的舊部署/版本" >&2
  echo "     3) 回終端機再跑一次 ./deploy.sh，看到下面的 ✅ 才算真的上線" >&2
  exit 1
fi

echo "✅ Done. LINE /exec URL now serves the latest code（git: $(git rev-parse --short HEAD 2>/dev/null || echo '?')）."
