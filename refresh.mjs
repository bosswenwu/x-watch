import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const DAYS = 7;
const FETCH_DAYS = 14;
const GAP_MS = 400;
const CONCURRENCY = 2;

const lanes = [
  {
    id: "ai",
    title: "AI 高质量",
    line: "研究者、工程师和实验室账号。按粉丝量归一后的互动来排，大号灌水不会自动压过写清楚的帖。",
    accounts: [
      ["karpathy", "研究者，写模型与工程"],
      ["sama", "OpenAI"],
      ["ylecun", "研究者，常公开反驳"],
      ["demishassabis", "DeepMind"],
      ["simonw", "工具、数据和模型评测"],
      ["swyx", "AI 工程评论"],
      ["emollick", "把模型用进工作和教学"],
      ["OpenAI", "产品发布"],
      ["AnthropicAI", "产品发布"],
      ["GoogleDeepMind", "研究发布"],
    ],
  },
  {
    id: "politics",
    title: "世界政治",
    line: "通讯社和地缘评论。热度用近窗转发和回复近似，不是 X 官方热搜。",
    accounts: [
      ["Reuters", "通讯社"],
      ["AP", "通讯社"],
      ["BBCWorld", "国际新闻"],
      ["AJEnglish", "国际新闻"],
      ["FT", "金融与地缘"],
      ["TheEconomist", "周刊判断"],
      ["ianbremmer", "地缘简报"],
      ["KyivIndependent", "乌克兰"],
    ],
  },
  {
    id: "fun",
    title: "好玩",
    line: "科学、冷知识、讽刺和轻松账号。同样只留近窗里真正有人转的帖。",
    accounts: [
      ["NASA", "航天"],
      ["NatGeo", "自然"],
      ["Rainmaker1973", "冷知识影像"],
      ["NASAHubble", "天文"],
      ["TheOnion", "讽刺"],
      ["dog_rates", "狗"],
      ["Wikipedia", "条目"],
      ["ESA", "欧洲航天"],
    ],
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            body,
            retryAfter: Number(res.headers["retry-after"] || 0),
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(50000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function cleanText(raw) {
  const seen = new Set();
  return (raw || "")
    .replace(/https?:\/\/\S+/g, (url) => {
      if (seen.has(url)) return "";
      seen.add(url);
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function engagement(post) {
  return post.fav + post.rt * 4 + post.reply * 2 + post.quote * 3;
}

function toPost(item, why) {
  if (!item || item.reposted_by || item.replying_to) return null;
  const handle = item.author?.screen_name;
  const text = cleanText(item.text);
  if (!handle || !item.id || text.length < 8) return null;
  if (/^RT @/i.test(text) || text.startsWith("@")) return null;
  const createdMs = item.created_timestamp
    ? item.created_timestamp * 1000
    : Date.parse(item.created_at);
  if (!Number.isFinite(createdMs)) return null;
  return {
    id: String(item.id),
    text,
    created: new Date(createdMs).toISOString(),
    fav: item.likes || 0,
    rt: item.reposts || 0,
    reply: item.replies || 0,
    quote: item.quotes || 0,
    followers: item.author.followers || 0,
    name: item.author.name || handle,
    handle,
    why,
    avatar: item.author.avatar_url || "",
    photo: item.card?.image?.url || "",
    link: item.url || `https://x.com/${handle}/status/${item.id}`,
  };
}

async function fetchAccount(handle, why, since) {
  const url =
    `https://x.pcstyle.dev/${encodeURIComponent(handle)}/posts` +
    `?since=${since}&max_posts=8&format=json&with_reposts=0&with_replies=0`;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await get(url);
      if (res.status === 429) {
        const wait = Math.max(5, res.retryAfter || 60);
        if (attempt === 1) throw new Error("HTTP 429");
        process.stdout.write(`rate limit, wait ${wait}s\n`);
        await sleep(wait * 1000 + 1500);
        continue;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.body);
      const posts = [];
      const seen = new Set();
      for (const item of data.posts || []) {
        const post = toPost(item, why);
        if (!post || seen.has(post.id)) continue;
        seen.add(post.id);
        posts.push(post);
      }
      return posts;
    } catch (err) {
      lastErr = err;
      if (!String(err.message).includes("429")) await sleep(1500);
    }
  }
  throw lastErr;
}

function pick(posts, from, to) {
  return posts
    .filter((post) => {
      const t = Date.parse(post.created);
      return t >= from && t <= to;
    })
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

const file = path.join(root, "data.js");

function loadPrevious() {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^window\.XWATCH\s*=\s*/, "").replace(/;\s*$/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const now = Date.now();
const since = new Date(now - FETCH_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const recentCut = now - DAYS * 24 * 60 * 60 * 1000;
const olderCut = now - FETCH_DAYS * 24 * 60 * 60 * 1000;
const errors = [];
const previous = loadPrevious();
const prevByHandle = new Map();
const covered = new Set(previous?.covered || []);
if (previous && now - Date.parse(previous.fetchedAt) < 18 * 60 * 60 * 1000) {
  for (const lane of previous.lanes || []) {
    for (const post of [...(lane.posts || []), ...(lane.older || [])]) {
      const list = prevByHandle.get(post.handle) || [];
      list.push(post);
      prevByHandle.set(post.handle, list);
      covered.add(post.handle);
    }
  }
}

function writeBoard(fetched) {
  const board = {
    fetchedAt: new Date().toISOString(),
    source: "x.pcstyle.dev public posts",
    covered: [...covered],
    lanes: lanes.map((lane) => {
      const all = fetched.filter((item) => item.lane === lane.id).flatMap((item) => item.posts);
      const recent = pick(all, recentCut, now);
      const capped = [];
      const perHandle = new Map();
      for (const post of recent) {
        const n = perHandle.get(post.handle) || 0;
        if (n >= 8) continue;
        perHandle.set(post.handle, n + 1);
        capped.push(post);
      }
      return {
        id: lane.id,
        title: lane.title,
        line: lane.line,
        watched: lane.accounts.map(([handle, why]) => ({ handle, why })),
        posts: capped,
        older: pick(all, olderCut, recentCut)
          .sort((a, b) => engagement(b) - engagement(a))
          .slice(0, 6),
      };
    }),
    errors,
  };
  fs.writeFileSync(file, `window.XWATCH = ${JSON.stringify(board, null, 2)};\n`, "utf8");
  return board;
}

const jobs = lanes.flatMap((lane) =>
  lane.accounts.map(([handle, why]) => ({ lane: lane.id, handle, why }))
);
const fetched = [];
for (const job of jobs) {
  if (covered.has(job.handle)) {
    process.stdout.write(`keep ${job.lane} @${job.handle}\n`);
    fetched.push({ ...job, posts: prevByHandle.get(job.handle) || [] });
    continue;
  }
  try {
    const posts = await fetchAccount(job.handle, job.why, since);
    process.stdout.write(`ok ${job.lane} @${job.handle} ${posts.length}\n`);
    covered.add(job.handle);
    fetched.push({ ...job, posts });
  } catch (err) {
    process.stdout.write(`fail ${job.lane} @${job.handle} ${err.message}\n`);
    errors.push({ lane: job.lane, handle: job.handle, error: err.message });
    fetched.push({ ...job, posts: prevByHandle.get(job.handle) || [] });
  }
  writeBoard(fetched);
  await sleep(GAP_MS);
}

const board = writeBoard(fetched);
const summary = board.lanes.map((lane) => `${lane.title} ${lane.posts.length}`).join(" | ");
process.stdout.write(`\n${summary}\nerrors ${errors.length}\nwrote ${file}\n`);
if (board.lanes.every((lane) => lane.posts.length === 0)) process.exitCode = 1;
