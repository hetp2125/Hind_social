import express from "express";
import fs from "fs/promises";
import path from "path";
import { v4 as uuid } from "uuid";

/* ============================
   TYPES
============================ */

interface Comment {
  id: string;
  userId: string;
  content: string;
  createdAt: number;
}

interface Post {
  id: string;
  userId: string;
  content: string;
  media?: string[];
  createdAt: number;

  likes: string[];
  comments: Comment[];
  shareCount: number;
}

/* ============================
   SIMPLE MUTEX (Concurrency Safety)
============================ */

class Mutex {
  private mutex = Promise.resolve();

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const begin = this.mutex;
    let resolveNext: () => void;

    this.mutex = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });

    await begin;
    try {
      return await fn();
    } finally {
      resolveNext!();
    }
  }
}


/* ============================
   CACHE ABSTRACTION
============================ */

interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clearByPrefix(prefix: string): Promise<void>;
}

class InMemoryCache implements Cache {
  private store = new Map<string, any>();

  async get<T>(key: string): Promise<T | null> {
    return this.store.get(key) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clearByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}

/* ============================
   JSON REPOSITORY
============================ */

class JsonPostRepository {
  private filePath = path.join(__dirname, "../data/posts.json");
  private mutex = new Mutex();

  async init() {
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, "[]");
    }
  }

  async getAll(): Promise<Post[]> {
    const raw = await fs.readFile(this.filePath, "utf-8");
    return JSON.parse(raw);
  }

  async saveAll(posts: Post[]): Promise<void> {
    await this.mutex.lock(async () => {
      await fs.writeFile(this.filePath, JSON.stringify(posts, null, 2));
    });
  }
}

/* ============================
   CURSOR UTILS
============================ */

function encodeCursor(payload: any): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeCursor(cursor: string): any {
  return JSON.parse(Buffer.from(cursor, "base64").toString());
}

/* ============================
   SERVICE LAYER
============================ */

class PostService {
  constructor(
    private repo: JsonPostRepository,
    private cache: Cache
  ) {}

  async createPost(userId: string, content: string, media?: string[]) {
    const posts = await this.repo.getAll();

    const newPost: Post = {
      id: uuid(),
      userId,
      content,
      media,
      createdAt: Date.now(),
      likes: [],
      comments: [],
      shareCount: 0,
    };

    posts.push(newPost);
    await this.repo.saveAll(posts);

    await this.cache.clearByPrefix("feed:");

    return newPost;
  }

  async getFeed(limit: number, cursor?: string) {
    const cacheKey = `feed:${limit}:${cursor ?? "start"}`;
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    let posts = await this.repo.getAll();

    posts.sort((a, b) => {
      if (b.createdAt !== a.createdAt)
        return b.createdAt - a.createdAt;
      return b.id.localeCompare(a.id);
    });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      posts = posts.filter(
        (p) =>
          p.createdAt < decoded.createdAt ||
          (p.createdAt === decoded.createdAt &&
            p.id < decoded.id)
      );
    }

    const sliced = posts.slice(0, limit);

    const nextCursor =
      sliced.length === limit
        ? encodeCursor({
            createdAt: sliced[sliced.length - 1].createdAt,
            id: sliced[sliced.length - 1].id,
          })
        : null;

    const response = { data: sliced, nextCursor };

    await this.cache.set(cacheKey, response);

    return response;
  }

  async likePost(postId: string, userId: string) {
    const posts = await this.repo.getAll();
    const post = posts.find((p) => p.id === postId);
    if (!post) throw new Error("Post not found");

    if (!post.likes.includes(userId)) {
      post.likes.push(userId);
    }

    await this.repo.saveAll(posts);
    await this.invalidatePostCache(postId);
  }

  async unlikePost(postId: string, userId: string) {
    const posts = await this.repo.getAll();
    const post = posts.find((p) => p.id === postId);
    if (!post) throw new Error("Post not found");

    post.likes = post.likes.filter((id) => id !== userId);

    await this.repo.saveAll(posts);
    await this.invalidatePostCache(postId);
  }

  async commentPost(postId: string, userId: string, content: string) {
    const posts = await this.repo.getAll();
    const post = posts.find((p) => p.id === postId);
    if (!post) throw new Error("Post not found");

    post.comments.push({
      id: uuid(),
      userId,
      content,
      createdAt: Date.now(),
    });

    await this.repo.saveAll(posts);
    await this.invalidatePostCache(postId);
  }

  async sharePost(postId: string) {
    const posts = await this.repo.getAll();
    const post = posts.find((p) => p.id === postId);
    if (!post) throw new Error("Post not found");

    post.shareCount++;

    await this.repo.saveAll(posts);
    await this.invalidatePostCache(postId);
  }

  private async invalidatePostCache(postId: string) {
    await this.cache.delete(`post:${postId}:engagement`);
    await this.cache.clearByPrefix("feed:");
  }
}

/* ============================
   EXPRESS APP
============================ */

const app = express();
app.use(express.json());

const repo = new JsonPostRepository();
const cache = new InMemoryCache();
const service = new PostService(repo, cache);

repo.init();

/* -------- ROUTES -------- */

app.post("/posts", async (req, res) => {
  const { userId, content, media } = req.body;
  const post = await service.createPost(userId, content, media);
  res.json(post);
});

app.get("/feed", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 10;
  const cursor = req.query.cursor as string | undefined;
  const result = await service.getFeed(limit, cursor);
  res.json(result);
});

app.post("/posts/:id/like", async (req, res) => {
  await service.likePost(req.params.id, req.body.userId);
  res.json({ success: true });
});

app.post("/posts/:id/unlike", async (req, res) => {
  await service.unlikePost(req.params.id, req.body.userId);
  res.json({ success: true });
});

app.post("/posts/:id/comment", async (req, res) => {
  await service.commentPost(
    req.params.id,
    req.body.userId,
    req.body.content
  );
  res.json({ success: true });
});

app.post("/posts/:id/share", async (req, res) => {
  await service.sharePost(req.params.id);
  res.json({ success: true });
});
app.get("/", (req, res) => {
  res.send(`
    <h1>🚀 Social Media Post API</h1>
    <p>Backend is running successfully.</p>
    <ul>
      <li>POST /posts</li>
      <li>GET /feed</li>
      <li>POST /posts/:id/like</li>
      <li>POST /posts/:id/unlike</li>
      <li>POST /posts/:id/comment</li>
      <li>POST /posts/:id/share</li>
    </ul>
  `);
});



/* -------- START -------- */

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
