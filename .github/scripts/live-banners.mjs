// 卡池镜像（GitHub Actions 里跑，Node 22，不装任何依赖）。
// 从米哈游官方卡池公示拉「正在开放 + 已公布未开始」的卡池，只留网页解析要用的字段，写进 live/{game}.json。
// 名单没变就不改文件（不产生提交）。有本地资料里没有的 5★ / 4★ 名字时开 issue 提醒（已有同样内容的就不重复开）。
// 这个文件由源码仓库的 site/ 目录同步过来，不要直接在这里改；卡池类型要和 src/data/officialBanner.ts 的 BANNER_POOLS 一致（有测试检查）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const GAMES = {
  genshin: { biz: 'hk4e', region: 'cn_gf01', types: [301, 400, 302, 500, 200] },
  hsr: { biz: 'hkrpg', region: 'prod_gf_cn', types: [11, 12, 21, 22, 1] },
  zzz: { biz: 'nap', region: 'prod_gf_cn', types: [2001, 2002, 3001, 3002, 5001, 1001] },
};
const BASE = 'https://operation-webstatic.mihoyo.com/gacha_info';
const UA = 'gacha-calc-live-banners (GitHub Actions; non-commercial fan tool)';

async function getJson(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${last}`);
}

/** 官方时间（UTC+8）→ 毫秒；结束时间那一分钟内仍算开放（和网页的 bannerTime.ts 一致） */
const serverTime = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s ?? '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0) - 8, +(m[5] ?? 0), +(m[6] ?? 0)) : NaN;
};
const ended = (b, now) => {
  const end = serverTime(b.end_time);
  return !Number.isNaN(end) && now >= end + 60000;
};

const clean = (t) => String(t ?? '').replace(/<[^>]+>/g, '').trim();

const LIST_KEY = /^(r[345]_prob_list|r[45]_up_items|items_(avatar|light_cone|pet)_star_[345]|items_up_star_[45]|items_replace_avatar_star_5)$/;
const ITEM_KEYS = ['item_name', 'item_type', 'is_up', 'origin_item_id'];
/** 只留网页解析要用的字段（官方详情里有很长的规则原文，不要） */
export function trimDetail(raw) {
  const d = raw?.data ?? raw ?? {};
  const out = { title: d.title ?? '' };
  for (const [k, v] of Object.entries(d)) {
    if (!LIST_KEY.test(k) || !Array.isArray(v)) continue;
    out[k] = v.map((x) => Object.fromEntries(ITEM_KEYS.filter((key) => x && key in x).map((key) => [key, x[key]])));
  }
  return out;
}

/** 卡池里的 5★ / 4★ 名字（判断「本地资料有没有」用；邦布不算） */
export function namesOf(detail) {
  const names = [];
  for (const [k, v] of Object.entries(detail)) {
    if (/^r[45]_prob_list$/.test(k) || /^items_(avatar|light_cone)_star_[45]$/.test(k)) for (const x of v) names.push(String(x.item_name ?? '').replace(/<[^>]+>/g, '').trim());
  }
  return names.filter(Boolean);
}

async function mirror(game, cfg, now) {
  const list = (await getJson(`${BASE}/${cfg.biz}/${cfg.region}/gacha/list.json`)).data.list;
  const banners = [];
  for (const b of list) {
    if (!cfg.types.includes(b.gacha_type) || ended(b, now)) continue;
    const raw = await getJson(`${BASE}/${cfg.biz}/${cfg.region}/${b.gacha_id}/zh-cn.json`);
    banners.push({ gacha_id: b.gacha_id, gacha_type: b.gacha_type, begin_time: b.begin_time, end_time: b.end_time, detail: trimDetail(raw) });
  }
  return banners;
}

function ghClose(title) {
  try {
    const open = JSON.parse(execFileSync('gh', ['issue', 'list', '--state', 'open', '--search', `in:title ${title}`, '--json', 'number,title'], { encoding: 'utf8' }));
    for (const i of open.filter((x) => x.title === title)) {
      execFileSync('gh', ['issue', 'close', String(i.number), '--comment', '资料里已经有这些名字了（资料更新已发布），自动关闭。']);
      console.log(`已关闭 issue #${i.number}`);
    }
  } catch (err) {
    console.log('查 issue 失败（不影响镜像）：' + err);
  }
}

function ghIssue(title, body) {
  try {
    const open = JSON.parse(execFileSync('gh', ['issue', 'list', '--state', 'open', '--search', `in:title ${title}`, '--json', 'number,title,body'], { encoding: 'utf8' }));
    const same = open.find((i) => i.title === title);
    if (same && same.body.trim() === body.trim()) return console.log(`issue #${same.number} 已经在提醒了`);
    if (same) execFileSync('gh', ['issue', 'edit', String(same.number), '--body', body]);
    else execFileSync('gh', ['issue', 'create', '--title', title, '--body', body]);
    console.log('已开 / 更新提醒 issue');
  } catch (err) {
    console.log('开 issue 失败（不影响镜像）：' + err);
  }
}

async function main() {
  const now = Date.now();
  const known = existsSync('data/known-names.json') ? JSON.parse(readFileSync('data/known-names.json', 'utf8')) : null;
  mkdirSync('live', { recursive: true });
  const unknown = [];
  for (const [game, cfg] of Object.entries(GAMES)) {
    let banners;
    try {
      banners = await mirror(game, cfg, now);
    } catch (err) {
      console.log(`[${game}] 官方接口读不到，这次跳过：${err}`);
      continue;
    }
    if (!banners.length) {
      console.log(`[${game}] 官方列表是空的，这次跳过`);
      continue;
    }
    const file = `live/${game}.json`;
    const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (old && JSON.stringify(old.banners) === JSON.stringify(banners)) {
      console.log(`[${game}] 没有变化（${banners.length} 期）`);
    } else {
      writeFileSync(file, JSON.stringify({ v: 1, game, fetchedAt: new Date(now).toISOString(), banners }) + '\n');
      console.log(`[${game}] 已更新：${banners.map((b) => `${clean(b.detail.title)}（${b.begin_time} → ${b.end_time}）`).join('；')}`);
    }
    if (known?.[game]) {
      const set = new Set(known[game]);
      for (const b of banners) {
        const miss = [...new Set(namesOf(b.detail).filter((n) => !set.has(n)))];
        if (miss.length) unknown.push(`- ${game}「${clean(b.detail.title)}」（${b.begin_time} 起）：${miss.join('、')}`);
      }
    }
  }
  const TITLE = '[资料更新] 新卡池里有本地资料没有的角色 / 武器';
  if (known && !unknown.length) ghClose(TITLE);
  if (unknown.length) {
    ghIssue(
      TITLE,
      `官方卡池名单里出现了集米桶资料里还没有的名字（多半是新角色 / 新武器）。卡池会按时自动切换，但这些名字在页面上只能显示文字、不能选作计算目标，要跑一次完整的资料更新（源码仓库 docs/发布流程.md 第 0 步）。\n\n${unknown.join('\n')}\n\n（由定时任务 live-banners 自动生成；资料更新发布后会自动关闭。）`,
    );
  }
}

if (process.argv[1]?.endsWith('live-banners.mjs')) await main();
