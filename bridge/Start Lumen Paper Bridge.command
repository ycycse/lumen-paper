#!/bin/zsh -l
set -u

SCRIPT_DIR="$(cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
"$SCRIPT_DIR/lumen-paper-bridge" start
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  printf '\nBridge 没有启动。请检查上方提示；按回车关闭窗口。\n'
  read -r _
else
  printf '\nBridge 已在后台运行，可以关闭这个窗口。\n'
fi

exit "$STATUS"
