# 在服务器上运行：只换 /opt/coteach/dist，旧版留在 /opt/coteach/dist.prev 以便回退；数据目录 /var/lib/coteach 不动。
# 本机（Git Bash）先打包上传：
#   pnpm build && tar -czf /tmp/coteach-dist.tgz -C server dist
#   scp /tmp/coteach-dist.tgz tmd:/tmp/coteach-dist.tgz && ssh tmd bash -s < tools/prod-update.sh
# 回退：rm -rf /opt/coteach/dist && mv /opt/coteach/dist.prev /opt/coteach/dist && systemctl restart coteach
set -e
REL=/tmp/coteach-up
rm -rf $REL && mkdir -p $REL && tar -xzf /tmp/coteach-dist.tgz -C $REL
test -f $REL/dist/server.mjs && test -f $REL/dist/web/index.html
rm -rf /opt/coteach/dist.prev && cp -a /opt/coteach/dist /opt/coteach/dist.prev
rm -rf /opt/coteach/dist && cp -r $REL/dist /opt/coteach/dist && chown -R root:root /opt/coteach/dist && chmod -R a+rX /opt/coteach/dist
systemctl restart coteach
sleep 4
echo "== 服务"; systemctl show coteach -p ActiveState -p SubState -p NRestarts --value | tr '\n' ' '; echo
echo "== 本机访问"; curl -s http://127.0.0.1:8473/api/health; echo; curl -s -o /dev/null -w 'index %{http_code}\n' http://127.0.0.1:8473/
echo "== 新代码"; grep -c "diff-tree" /opt/coteach/dist/server.mjs; ls /opt/coteach/dist/web/assets | grep -c KnowledgeBase
echo "== 日志"; journalctl -u coteach -n 6 --no-pager | tail -6
echo "== 其他服务照旧"; systemctl is-active teach-v2; ss -ltn | grep -c ':18642 '
rm -rf $REL /tmp/coteach-dist.tgz
