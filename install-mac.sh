#!/bin/bash
# ダブルクリックで Terminal が開いて自動実行される
if [ "$(ps -o comm= $PPID 2>/dev/null)" != "bash" ] && [ "$(ps -o comm= $PPID 2>/dev/null)" != "zsh" ]; then
  osascript -e 'tell application "Terminal"
    activate
    do script "bash '"'"'"$0"'"'"'"
  end tell'
  exit
fi

APP_NAME="Spiral 2.app"
SEARCH_DIRS=("$HOME/Downloads" "$HOME/Desktop" "/Applications")

APP_PATH=""
for DIR in "${SEARCH_DIRS[@]}"; do
  if [ -d "$DIR/$APP_NAME" ]; then
    APP_PATH="$DIR/$APP_NAME"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  osascript -e 'display alert "Spiral 2.app が見つかりません" message "Downloads・Desktop・Applications フォルダに置いてから再実行してください。" as critical'
  exit 1
fi

echo "Gatekeeper のブロックを解除中: $APP_PATH"
xattr -cr "$APP_PATH"
echo "完了！Spiral を起動します..."
open "$APP_PATH"
sleep 2
