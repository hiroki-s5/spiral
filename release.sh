#!/bin/bash
set -e

VERSION=$1
if [ -z "$VERSION" ]; then
  echo "使い方: ./release.sh 9.0.3"
  exit 1
fi

echo ">>> バージョン $VERSION のリリースを開始..."

cat > .gitignore << 'EOF'
node_modules/
dist/
*.zip
.DS_Store
.env
.env.local
ai-key.json
EOF

npm version $VERSION --no-git-tag-version || true
rm -rf dist/
chmod 644 assets/icon.icns
npm install
npm run build

echo ">>> GitHubにプッシュ..."

rm -rf .git
git init
git add .
git commit -m "v$VERSION"
git remote add origin https://github.com/Arceus-S5/spiral.git
git push origin main --force

# タグが既存の場合は削除してから作成
git push origin :refs/tags/v$VERSION 2>/dev/null || true
git tag v$VERSION
git push origin v$VERSION

echo ">>> GitHub Releasesにアップロード..."

# リリースが既存の場合は削除してから作成
gh release delete v$VERSION --yes 2>/dev/null || true

# アップロードするファイルを収集
UPLOAD_FILES=()

# macOS
[ -f "dist/Spiral-${VERSION}-arm64.dmg" ]         && UPLOAD_FILES+=("dist/Spiral-${VERSION}-arm64.dmg")
[ -f "dist/Spiral-${VERSION}.dmg" ]                && UPLOAD_FILES+=("dist/Spiral-${VERSION}.dmg")
[ -f "dist/Spiral-${VERSION}-arm64-mac.zip" ]      && UPLOAD_FILES+=("dist/Spiral-${VERSION}-arm64-mac.zip")
[ -f "dist/Spiral-${VERSION}-mac.zip" ]            && UPLOAD_FILES+=("dist/Spiral-${VERSION}-mac.zip")
[ -f "dist/latest-mac.yml" ]                       && UPLOAD_FILES+=("dist/latest-mac.yml")
[ -f "install-mac.sh" ]                              && UPLOAD_FILES+=("install-mac.sh")

# Windows
[ -f "dist/Spiral-Setup-${VERSION}.exe" ]          && UPLOAD_FILES+=("dist/Spiral-Setup-${VERSION}.exe")
[ -f "dist/latest.yml" ]                           && UPLOAD_FILES+=("dist/latest.yml")

# Linux
[ -f "dist/Spiral-${VERSION}.AppImage" ]           && UPLOAD_FILES+=("dist/Spiral-${VERSION}.AppImage")
[ -f "dist/latest-linux.yml" ]                     && UPLOAD_FILES+=("dist/latest-linux.yml")

gh release create v$VERSION \
  --title "Spiral v${VERSION}" \
  --notes "## Spiral v${VERSION}

### インストール方法（Mac）
DMGをダウンロードして開き、Spiral.app を Applications フォルダにドラッグしてください。

**「開けません」「-47」エラーが出た場合：**
ターミナルで以下を実行してください：
\`\`\`
xattr -cr /Applications/Spiral.app
\`\`\`
その後、Spiral.app をダブルクリックで起動できます。" \
  "${UPLOAD_FILES[@]}"

echo ">>> 完了! v$VERSION をリリースしました"
echo ">>> アップロードしたファイル: ${UPLOAD_FILES[@]}"
