#!/usr/bin/env bash
# 仅由 Claude 在核实生产状态后执行。
# 输入 /tmp/coteach-dist.tgz；更新前完整备份程序与数据；失败保全新数据再配套回退。
set -euo pipefail
test "$(id -u)" = 0 || { echo '请以 root 运行部署脚本；数据工具会切换到服务账户。' >&2; exit 1; }
unit=coteach.service
root=/opt/coteach
data=/var/lib/coteach
archive=/tmp/coteach-dist.tgz
backup_root=/var/backups/coteach
stage=$(mktemp -d /tmp/coteach-release.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
backup=''
stopped=0
published=0
success=0
service_user=$(systemctl show "$unit" -p User --value)
test "$service_user" = coteach || { echo '服务账户不是 coteach，请先核对部署信息。' >&2; exit 1; }
node_bin=$(systemctl show "$unit" -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
test -x "$node_bin" || { echo '无法确定服务正在使用的 Node，请先核对 ExecStart。' >&2; exit 1; }
ready() {
  local attempt
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet "$unit" &&
      curl --fail --silent --max-time 2 http://127.0.0.1:8473/api/health > "$stage/health.json" &&
      "$node_bin" --input-type=module - "$stage/health.json" <<'JS'
import {readFileSync} from 'node:fs';
if(JSON.parse(readFileSync(process.argv[2],'utf8')).ok!==true)process.exit(1);
JS
    then
      curl --fail --silent --max-time 2 http://127.0.0.1:8473/ > /dev/null && return 0
    fi
    sleep 1
  done
  return 1
}
finish() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if test "$success" = 0 && test "$published" = 1; then
    systemctl stop "$unit"
    # 不丢弃新版启动后可能产生的写入。
    mv -- "$data" "$backup/failed-data"
    mv -- "$root/dist" "$backup/failed-dist"
    cp -a -- "$backup/data" "$data" && cp -a -- "$backup/dist" "$root/dist" && systemctl start "$unit"
    if ready; then echo "更新失败，已恢复配套旧程序和数据；失败现场保留在 $backup" >&2
    else echo "恢复后的服务未通过检查，请立即核对 $backup 和服务日志。" >&2; fi
  elif test "$success" = 0 && test "$stopped" = 1; then
    systemctl start "$unit"
  fi
  rm -rf -- "$stage"
  if test "$success" = 1; then rm -f -- "$archive"; fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
test -f "$archive"
tar -tzf "$archive" > "$stage/files"
awk '/^\// || /(^|\/)\.\.(\/|$)/ || $0 !~ /^dist(\/|$)/ {bad=1} END {exit bad}' "$stage/files"
tar -xzf "$archive" -C "$stage"
test -s "$stage/dist/server.mjs" && test -s "$stage/dist/kb-owner.mjs" && test -s "$stage/dist/web/index.html"
chmod a+rx "$stage"
chmod -R a+rX "$stage/dist"
# 检查只在临时副本打开 SQLite，且仍以服务账户执行。
runuser -u "$service_user" -- env CT_DATA_DIR="$data" "$node_bin" "$stage/dist/kb-owner.mjs" check > "$stage/check.json"
"$node_bin" --input-type=module - "$stage/check.json" <<'JS'
import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(r.schemaVersion<2 || r.schemaVersion>r.requiredVersion || r.courses.some(c=>!c.imported)) {
  console.error('归属迁移尚未完成，或试图降级数据库。请先完成归属迁移再更新。');process.exit(1);
}
// 后续普通升表可在已备份、停服后的新程序启动阶段执行，不要求提前等于新版本。
JS
mkdir -p "$backup_root"
required_kb=$(du -sk "$data" "$root/dist" "$stage/dist" | awk '{n+=$1} END {print n*2+102400}')
while read -r free_kb used; do
  test "${used%%%}" -lt 80 && test "$free_kb" -gt "$required_kb" || { echo '磁盘空间不足，请先按保留策略清理。' >&2; exit 1; }
done < <(df -Pk "$backup_root" "$root" "$data" | awk 'NR>1 {print $4,$5}')
backup=$(mktemp -d "$backup_root/release-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
systemctl stop "$unit"
stopped=1
test "$(systemctl show "$unit" -p MainPID --value)" = 0
cp -a -- "$data" "$backup/data"
cp -a -- "$root/dist" "$backup/dist"
cp -- "$stage/check.json" "$backup/precheck.json"
(cd "$stage/dist" && sha256sum server.mjs kb-owner.mjs web/index.html) > "$backup/release.sha256"
published=1
rm -rf -- "$root/dist"
cp -a -- "$stage/dist" "$root/dist"
chown -R root:root "$root/dist"
chmod -R a+rX "$root/dist"
(cd "$root/dist" && sha256sum -c "$backup/release.sha256")
systemctl start "$unit"
ready || { journalctl -u "$unit" -n 30 --no-pager >&2; exit 1; }
success=1
echo "更新成功。程序与数据的配套回退副本：$backup"
# 不覆盖 dist.prev，不根据 grep 次数猜版本，不触碰其他服务。
# 备份保留与清理由 Claude 按服务器既定策略处理，脚本不删除历史回退副本。
