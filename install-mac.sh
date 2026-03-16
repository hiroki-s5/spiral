#!/bin/bash
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
  osascript -e "display alert \"Spiral 2.app が見つかりません\" message \"Downloads・Desktop・Applications フォルダに置いてから再実行してください。\" as critical"
  exit 1
fi

xattr -cr "$APP_PATH"
open "$APP_PATH"
