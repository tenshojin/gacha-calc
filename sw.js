/*
 * 离线缓存（只在线上网页版生效；本地开发和安卓 App 里不注册）。
 * - 首页：先联网取最新，断网才用缓存（以前先用缓存，网站更新后第一次打开会拿到旧首页、旧脚本已删 → 白屏）。
 * - 打包的脚本 / 样式（static/，文件名带指纹）：任何一版缓存里有就用，没有再下载；上一版的页面缓存保留一版。
 * - 资料（data/）等其他文件：先用缓存马上显示，同时后台取新版本（下次打开生效）。
 * - 图片（assets/）：有缓存就直接用，没有再下载并存起来。
 * - 抽卡开场动画（clips/*.mp4）：地址带内容指纹（?h=…），下载过一次就一直用缓存，
 *   不再每次打开都重下；视频播放器的分段请求（Range）从缓存里切给它。
 * - 动画清单（clips/manifest.json）：每次先联网取最新，断网才用缓存。
 * - 线上卡池镜像（live/）：不经过这里，页面自己缓存。
 */
// 网页和资料（data/）改了就把 PAGE_VERSION 加一；图片（同名文件重做过）改了才加 IMG_VERSION，免得大家重新下载所有图片
const PAGE_VERSION = 'v10';
const IMG_VERSION = 'v2';
const PAGE_CACHE = `pages-${PAGE_VERSION}`;
const IMG_CACHE = `images-${IMG_VERSION}`;
const CLIP_CACHE = 'clips-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGE_CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 上一版的页面缓存先留着：更新那一刻已经打开的旧页面，它要的旧脚本还能从这里拿到（服务器上已经删了）
  const prevPages = `pages-v${Number(PAGE_VERSION.slice(1)) - 1}`;
  const keep = [PAGE_CACHE, prevPages, IMG_CACHE, CLIP_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 线上卡池镜像（live/）：直接走网络，页面自己存了上一份（断网时用）；这里不缓存，免得拿到旧名单
  if (url.pathname.includes('/live/')) return;

  if (url.pathname.includes('/clips/')) {
    if (!url.pathname.endsWith('.mp4')) {
      event.respondWith(networkFirst(req));
      return;
    }
    const result = clip(req, url);
    event.respondWith(result.then(({ response }) => response));
    event.waitUntil(result.then(({ stored }) => stored).catch(() => undefined));
    return;
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // 打开页面（首页）：先联网拿最新的，断网才用缓存 —— 首页和它要的脚本永远是同一版（更新后不会白屏）
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return (await caches.match(req, { ignoreSearch: true })) ?? (await caches.match('./')) ?? Promise.reject(err);
        }
      })(),
    );
    return;
  }

  // 打包好的脚本 / 样式（文件名带内容指纹，内容不会变）：任何一版的缓存里有就用，没有再下载
  if (url.pathname.includes('/static/')) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) (await caches.open(PAGE_CACHE)).put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  event.respondWith(
    caches.open(PAGE_CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function clip(req, url) {
  const cache = await caches.open(CLIP_CACHE);
  const key = url.href;
  const hit = await cache.match(key);
  const range = req.headers.get('range');

  if (hit) return { response: range ? await sliceRange(hit, range) : hit };
  // 视频播放器边放边下（分段请求）：直接走网络，不存半截文件
  if (range) return { response: await fetch(req) };

  const response = await fetch(req);
  if (!response.ok || response.status !== 200) return { response };
  // 先把响应交给播放器或预取，缓存写完后再清理同一路径的旧指纹。
  const stored = cache.put(key, response.clone()).then(async () => {
    const old = await cache.keys();
    await Promise.all(old.filter((r) => new URL(r.url).pathname === url.pathname && r.url !== key).map((r) => cache.delete(r)));
  });
  return { response, stored };
}

async function sliceRange(res, range) {
  const blob = await res.blob();
  const { size } = blob;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(range);
  const suffix = m?.[1] === '';
  const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m?.[1]);
  const end = !suffix && m?.[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (!m || (!m[1] && !m[2]) || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
