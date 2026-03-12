#!/bin/bash
set -e

VERSION=$1
if [ -z "$VERSION" ]; then
  echo "使い方: ./release.sh 3.0.4"
  exit 1
fi

echo ">>> バージョン $VERSION のリリースを開始..."

cat > .gitignore << 'EOF'
node_modules/
dist/
*.zip
.DS_Store
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

gh release create v$VERSION \
  --title "v$VERSION" \
  --notes "Spiral v$VERSION" \
  dist/Spiral-${VERSION}-arm64.dmg \
  dist/Spiral-${VERSION}-arm64-mac.zip \
  dist/latest-mac.yml

echo ">>> 完了! v$VERSION をリリースしました"
