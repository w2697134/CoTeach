export {};
/**
 * ct：整理助手（Claude Code）干活时敲的命令。原样转给服务器（带这一轮的口令），服务器回什么就打印什么。
 * 只在整理助手干活时有用：口令只在那一轮里有效。
 */
const url = process.env.CT_AGENT_URL;
const token = process.env.CT_AGENT_TOKEN;
if (!url || !token) {
  process.stderr.write('ct 只能在整理助手干活时用\n');
  process.exit(2);
}
try {
  const res = await fetch(url + '/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify({ args: process.argv.slice(2) }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const j = (await res.json().catch(() => null)) as { ok?: boolean; text?: string } | null;
  const text = j?.text || `服务器没有回应（${res.status}）`;
  (j?.ok ? process.stdout : process.stderr).write(text + '\n');
  process.exit(j?.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`连不上服务器：${(err as Error).message}\n`);
  process.exit(1);
}
