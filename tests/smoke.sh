#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
package="$repo/luci-app-gzhu-eportal"

shell_files=(
	"$package/root/etc/init.d/gzhu-eportal"
	"$package/root/etc/uci-defaults/90-gzhu-eportal"
	"$package/root/usr/bin/eportal-login"
	"$package/root/usr/bin/eportal-status"
	"$package/root/usr/bin/eportal-watchdog"
)

for file in "${shell_files[@]}"; do
	bash -n "$file"
done

node --check "$package/htdocs/luci-static/resources/view/gzhu-eportal/settings.js"
node -e 'const fs=require("fs"); process.argv.slice(1).forEach(p=>JSON.parse(fs.readFileSync(p,"utf8")))' \
	"$package/root/usr/share/luci/menu.d/luci-app-gzhu-eportal.json" \
	"$package/root/usr/share/rpcd/acl.d/luci-app-gzhu-eportal.json"

grep -q "LUCI_PKGARCH:=all" "$package/Makefile"
grep -q "/etc/config/eportal" "$package/Makefile"
grep -q "option check_url" "$package/root/etc/config/eportal"
grep -q "widgets.DeviceSelect" "$package/htdocs/luci-static/resources/view/gzhu-eportal/settings.js"
test -f "$repo/dist/luci-app-gzhu-eportal_0.1.0_all.ipk"

if command -v lua >/dev/null 2>&1; then
	"$package/root/usr/bin/eportal-login" --self-test
fi

echo 'smoke-test: ok'
