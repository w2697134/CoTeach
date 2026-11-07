#!/usr/bin/env bash
# 仅用本地桩测试部署脚本的文件与失败分支，不连接服务器、不调用真实 systemd。
set -euo pipefail
workspace=$(pwd -P)
test -f "$workspace/tools/prod-update.sh"
mkdir -p "$workspace/output/kb-review"
fixture=$(mktemp -d "$workspace/output/kb-review/deploy-test.XXXXXXXX")
case "$fixture" in "$workspace/output/kb-review/"*) ;; *) exit 1;; esac
export TEST_DEPLOY_ROOT="$fixture"
mkdir -p "$fixture/bin" "$fixture/app/dist/web" "$fixture/data" "$fixture/tmp" "$fixture/backups"
printf 'v0\n' > "$fixture/app/dist/server.mjs"
printf 'old-index\n' > "$fixture/app/dist/web/index.html"
printf 'before\n' > "$fixture/data/coteach.db"
printf 'active\n' > "$fixture/status"
export REAL_TEST_NODE
REAL_TEST_NODE=$(command -v node)
cat > "$fixture/bin/id" <<'SH'
#!/usr/bin/env bash
echo 0
SH
cat > "$fixture/bin/ct-node" <<'SH'
#!/usr/bin/env bash
if test "${*: -1}" = check; then
  if test "${TEST_SCHEMA_OLD:-0}" = 1; then echo '{"schemaVersion":1,"requiredVersion":3,"courses":[{"imported":false}]}'
  else echo '{"schemaVersion":2,"requiredVersion":3,"courses":[{"imported":true}]}'; fi
else exec "$REAL_TEST_NODE" "$@"; fi
SH
cat > "$fixture/bin/runuser" <<'SH'
#!/usr/bin/env bash
test "$1" = -u && test "$2" = coteach && test "$3" = -- || exit 92
printf 'coteach\n' >> "$TEST_DEPLOY_ROOT/account.log"
shift 3
exec "$@"
SH
cat > "$fixture/bin/systemctl" <<'SH'
#!/usr/bin/env bash
case "$1" in
 show)
 case "$*" in
  *User*) echo coteach;;
  *ExecStart*) echo "{ path=$TEST_DEPLOY_ROOT/bin/ct-node ; argv[]=node ; }";;
  *MainPID*) if test "$(cat "$TEST_DEPLOY_ROOT/status")" = active; then echo 123; else echo 0; fi;;
 esac;;
 stop) echo inactive > "$TEST_DEPLOY_ROOT/status";;
 start)
 if test "${TEST_FAIL_RELEASE:-0}" = 1 && grep -q v3 "$TEST_DEPLOY_ROOT/app/dist/server.mjs"; then
  echo changed-by-new > "$TEST_DEPLOY_ROOT/data/coteach.db"
  echo failed > "$TEST_DEPLOY_ROOT/status"
 else echo active > "$TEST_DEPLOY_ROOT/status"; fi;;
 is-active) test "$(cat "$TEST_DEPLOY_ROOT/status")" = active;;
 *) exit 93;;
esac
SH
cat > "$fixture/bin/curl" <<'SH'
#!/usr/bin/env bash
test "$(cat "$TEST_DEPLOY_ROOT/status")" = active || exit 22
echo '{"ok":true}'
SH
cat > "$fixture/bin/df" <<'SH'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 999999999 1000 999998999 1%% /\n'
SH
for command in sleep chown journalctl; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/bin/$command"
done
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
sed -e "s|root=/opt/coteach|root=$fixture/app|" -e "s|data=/var/lib/coteach|data=$fixture/data|" \
  -e "s|archive=/tmp/coteach-dist.tgz|archive=$fixture/tmp/coteach-dist.tgz|" \
  -e "s|backup_root=/var/backups/coteach|backup_root=$fixture/backups|" \
  -e "s|/tmp/coteach-release\.|$fixture/tmp/coteach-release.|" \
  "$workspace/tools/prod-update.sh" > "$fixture/update.sh"
package() {
  mkdir -p "$fixture/package/dist/web"
  printf '%s\n' "$1" > "$fixture/package/dist/server.mjs"
  printf 'tool\n' > "$fixture/package/dist/kb-owner.mjs"
  printf 'index\n' > "$fixture/package/dist/web/index.html"
  tar -czf "$fixture/tmp/coteach-dist.tgz" -C "$fixture/package" dist
}
package v1
bash "$fixture/update.sh" > "$fixture/success-1.log" 2>&1
test "$(cat "$fixture/app/dist/server.mjs")" = v1
package v2
bash "$fixture/update.sh" > "$fixture/success-2.log" 2>&1
test "$(find "$fixture/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 2
test "$(cat "$fixture/app/dist/server.mjs")" = v2
test "$(grep -rl '^v0$' "$fixture/backups" | wc -l)" = 1
package v3
if TEST_FAIL_RELEASE=1 bash "$fixture/update.sh" > "$fixture/failed-release.log" 2>&1; then echo '错误：失败发布被当成成功'; exit 1; fi
test "$(cat "$fixture/app/dist/server.mjs")" = v2
test "$(cat "$fixture/data/coteach.db")" = before
test "$(grep -rl '^changed-by-new$' "$fixture/backups" | wc -l)" = 1
test "$(find "$fixture/tmp" -maxdepth 1 -type d -name 'coteach-release.*' | wc -l)" = 0
package v4
if TEST_SCHEMA_OLD=1 bash "$fixture/update.sh" > "$fixture/unmigrated.log" 2>&1; then exit 1; fi
test "$(cat "$fixture/status")" = active
test "$(cat "$fixture/app/dist/server.mjs")" = v2
test "$(find "$fixture/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 3
test "$(wc -l < "$fixture/account.log")" = 4
printf '通过：未来升表、服务账户、连续备份、失败保全与配套回退、旧库门禁、临时文件清理。\n证据：%s\n' "$fixture"
