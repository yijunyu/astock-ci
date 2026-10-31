/**
 * GitHub Actions 用：重建基本面（市值 / 营收增速 / 净利增速 / 总股本）并写入 Cloudflare KV
 *
 * 为什么放在 GitHub Actions：
 *   东方财富接口在中国大陆和 Cloudflare 边缘都会返回 502，
 *   但 GitHub 的 runner 在 Azure 网络里，通常可以直连。
 *
 * 环境变量（由 workflow 从 Secrets 注入）：
 *   CF_API_TOKEN      具备 Workers KV Storage: Edit 的 Token
 *   CF_ACCOUNT_ID     账户 ID
 *   CF_KV_NAMESPACE   KV 命名空间 ID
 *
 * 输出：KV key `fund:v1`，格式
 *   { updated: 'YYYY-MM-DD', rows: [[code, name, mcap亿, rev%, prof%, shares亿股], ...] }
 */

const EM =
  'https://push2.eastmoney.com/api/qt/clist/get' +
  '?po=1&np=1&fltt=2&invt=2&fid=f20' +
  '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048' +
  '&fields=f12,f14,f20,f41,f46,f84';

const PAGE_SIZE = 100;
const MAX_PAGES = 80;

const CF_API = 'https://api.cloudflare.com/client/v4';

function num(v) {
  if (v === '-' || v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchPage(pn) {
  const url = `${EM}&pn=${pn}&pz=${PAGE_SIZE}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      Referer: 'https://quote.eastmoney.com/',
    },
  });
  if (!r.ok) throw new Error(`EM HTTP ${r.status}`);
  const j = await r.json();
  return j?.data ?? null;
}

async function collect() {
  const rows = [];
  let total = null;
  for (let pn = 1; pn <= MAX_PAGES; pn++) {
    const d = await fetchPage(pn);
    if (!d || !Array.isArray(d.diff) || d.diff.length === 0) break;
    if (total === null) total = d.total;
    for (const x of d.diff) {
      const code = String(x.f12 || '');
      const name = String(x.f14 || '');
      const mcap = num(x.f20);          // 总市值（元）
      const rev = num(x.f41);           // 营收同比 %
      const prof = num(x.f46);          // 净利同比 %
      const sharesRaw = num(x.f84);     // 总股本（股）
      if (code.length !== 6) continue;
      rows.push([
        code,
        name,
        mcap === null ? null : Math.round(mcap / 1e8),
        rev === null ? null : Math.round(rev * 10) / 10,
        prof === null ? null : Math.round(prof * 10) / 10,
        sharesRaw === null ? null : Math.round((sharesRaw / 1e8) * 100) / 100,
      ]);
    }
    if (total !== null && pn * PAGE_SIZE >= total) break;
    await new Promise(r => setTimeout(r, 150)); // 轻微限速，避免被封
  }
  return rows;
}

async function putKV(value) {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE } = process.env;
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_KV_NAMESPACE) {
    throw new Error('缺少 CF_API_TOKEN / CF_ACCOUNT_ID / CF_KV_NAMESPACE');
  }
  const url = `${CF_API}/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/fund:v1`;
  const body = JSON.stringify(value);
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/octet-stream',
    },
    body,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, bytes: body.length, resp: j };
}

async function main() {
  console.log('拉取东方财富基本面 …');
  const rows = await collect();
  const valid = rows.filter(r => r[5] !== null && r[5] > 0);
  console.log(`共 ${rows.length} 只，含总股本 ${valid.length} 只`);

  if (rows.length < 3000) {
    throw new Error(`只拿到 ${rows.length} 只，疑似接口异常，放弃写入`);
  }

  const payload = {
    updated: new Date().toISOString().slice(0, 10),
    count: rows.length,
    rows,
  };
  const res = await putKV(payload);
  console.log(`写入 KV fund:v1 → ${res.ok ? '成功' : '失败'} · ${(res.bytes / 1024).toFixed(0)} KB`);
  if (!res.ok) {
    console.error(JSON.stringify(res.resp).slice(0, 400));
    process.exit(1);
  }

  // 输出摘要，便于在 Actions 页面直接看到
  const sample = rows.filter(r => r[2] >= 300).slice(0, 5);
  console.log('市值≥300亿 样例：');
  for (const s of sample) console.log(`  ${s[0]} ${s[1]} 市值${s[2]}亿 营收${s[3]}% 净利${s[4]}% 股本${s[5]}亿`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
