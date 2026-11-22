/*
 * 离线缓存（只在线上网页版生效；本地开发和安卓 App 里不注册）。
 * - 网页本身（html / js / css）：先用缓存马上显示，同时后台取新版本（下次打开生效）。
 * - 图片（assets/）：有缓存就直接用，没有再下载并存起来。
 * - 抽卡开场动画（clips/*.mp4）：地址带内容指纹（?h=…），下载过一次就一直用缓存，
 *   不再每次打开都重下；视频播放器的分段请求（Range）从缓存里切给它。
 * - 动画清单（clips/manifest.json）：每次先联网取最新，断网才用缓存。
 */
const VERSION = 'v1';
const PAGE_CACHE = `pages-${VERSION}`;
const IMG_CACHE = `images-${VERSION}`;
const CLIP_CACHE = 'clips-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGE_CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keep = [PAGE_CACHE, IMG_CACHE, CLIP_CACHE];
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

  if (url.pathname.includes('/clips/')) {
    event.respondWith(url.pathname.endsWith('.mp4') ? clip(req, url) : networkFirst(req));
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

  if (hit) return range ? sliceRange(hit, range) : hit;
  // 视频播放器边放边下（分段请求）：直接走网络，不存半截文件
  if (range) return fetch(req);

  const res = await fetch(key);
  if (res.ok && res.status === 200) {
    // 同一个文件的旧版本（指纹不同）删掉，缓存不会越积越多
    const old = await cache.keys();
    await Promise.all(old.filter((r) => new URL(r.url).pathname === url.pathname && r.url !== key).map((r) => cache.delete(r)));
    await cache.put(key, res.clone());
  }
  return res;
}

async function sliceRange(res, range) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) {
    start = size - Number(m[2]);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
