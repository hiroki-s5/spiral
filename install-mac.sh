#!/bin/bash
# Spiralのインストール補助スクリプト（Sonoma対応）
APP="/Applications/Spiral.app"
if [ ! -d "$APP" ]; then
  echo "Spiral.app が /Applications に見つかりません。"
  echo "先にDMGを開いてSpiralをApplicationsフォルダにドラッグしてください。"
  exit 1
fi
echo "Gatekeeperのブロックを解除しています..."
xattr -cr "$APP"
echo "完了！Spiralを起動します。"
open "$APP"
