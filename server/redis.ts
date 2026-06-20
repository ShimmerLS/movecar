import Redis from "ioredis";
import fs from "fs";
import path from "path";

// Support standard serverless environments
const TEMP_FILE_BACKUP = path.join("/tmp", "move_car_redis_fallback.json");

interface CacheState {
  [key: string]: {
    value: string;
    expire: number | null;
  };
}

class CacheService {
  private redis: Redis | null = null;
  private isRedisConnected = false;
  private memoryCache: Map<string, { value: string; expire: number | null }> = new Map();

  public getRedisStatus(): boolean {
    return this.isRedisConnected;
  }

  constructor() {
    this.initRedis();
    this.loadLockStateFromFile();
  }

  private initRedis() {
    const host = process.env.REDIS_HOST;
    const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;
    const password = process.env.REDIS_PASSWORD;
    // 🕒 【配置Redis数据库索引（通常为 0-15）】:
    // 系统会默认连接 0 号数据库。优先读取系统环境变量 REDIS_DB 或者是 REDIS_DATABASE，如果找不到则降级回 0。可在代码写死或在平台环境变量里配置。
    const dbIndex = process.env.REDIS_DB || process.env.REDIS_DATABASE;
    const db = dbIndex ? parseInt(dbIndex) : 0;

    if (host) {
      console.log(`[Database] Attempting to connect to Redis at ${host}:${port} (Database DB index: ${db})...`);
      try {
        this.redis = new Redis({
          host,
          port,
          password: password || undefined,
          db,
          lazyConnect: true,
          connectTimeout: 2000,
          maxRetriesPerRequest: 0,
          enableOfflineQueue: false,
          retryStrategy: (times) => {
            if (times > 1) {
              this.isRedisConnected = false;
              return null; // Stop trying to reconnect
            }
            return 1000;
          }
        });

        this.redis.on("connect", () => {
          this.isRedisConnected = true;
          console.log("[Database] Connected to Redis successfully.");
        });

        this.redis.on("error", (err) => {
          this.isRedisConnected = false;
          // Log briefly, or skip detailed print to suppress noise
          if (process.env.NODE_ENV !== "production") {
            console.debug("[Database] Redis backend offline (using memory/local backup cache):", err.message);
          }
        });

        this.redis.connect().catch((err) => {
          this.isRedisConnected = false;
          console.log("[Database] Redis did not connect on startup. Falling back quietly to memory and file backup engine.");
        });
      } catch (err) {
        this.isRedisConnected = false;
        console.warn("[Database] Redis initialization skipped. Using file backup engine.");
      }
    } else {
      console.log("[Database] REDIS_HOST env variable is not set. Using local file backup engine for state storage.");
    }
  }

  private loadLockStateFromFile() {
    try {
      if (fs.existsSync(TEMP_FILE_BACKUP)) {
        const fileContent = fs.readFileSync(TEMP_FILE_BACKUP, "utf8");
        const cache: CacheState = JSON.parse(fileContent);
        const now = Date.now();
        for (const [key, item] of Object.entries(cache)) {
          if (item.expire === null || item.expire > now) {
            this.memoryCache.set(key, item);
          }
        }
        console.log("[Database] Local state backup loaded. Active keys:", this.memoryCache.size);
      }
    } catch (err) {
      console.warn("[Database] Ignored error reading state from file:", err);
    }
  }

  private persistStateToFile() {
    try {
      const now = Date.now();
      const stateObj: CacheState = {};
      for (const [key, item] of this.memoryCache.entries()) {
        if (item.expire === null || item.expire > now) {
          stateObj[key] = item;
        }
      }
      fs.writeFileSync(TEMP_FILE_BACKUP, JSON.stringify(stateObj, null, 2), "utf8");
    } catch (err) {
      console.warn("[Database] Ignored error persisting state to file:", err);
    }
  }

  public async get(key: string): Promise<string | null> {
    if (this.isRedisConnected && this.redis) {
      try {
        return await this.redis.get(key);
      } catch (err) {
        this.isRedisConnected = false;
        console.log("[Database] Redis GET request failed. Dynamically switched to memory backup layer.");
      }
    }

    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (item.expire !== null && item.expire < Date.now()) {
      this.memoryCache.delete(key);
      this.persistStateToFile();
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.isRedisConnected && this.redis) {
      try {
        if (ttlSeconds) {
          await this.redis.set(key, value, "EX", ttlSeconds);
        } else {
          await this.redis.set(key, value);
        }
        return;
      } catch (err) {
        this.isRedisConnected = false;
        console.log("[Database] Redis SET request failed. Switched to memory and file backup store.");
      }
    }

    const expire = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.memoryCache.set(key, { value, expire });
    this.persistStateToFile();
  }

  public async ttl(key: string): Promise<number> {
    if (this.isRedisConnected && this.redis) {
      try {
        const remaining = await this.redis.ttl(key);
        return remaining; // ioredis returns -2 if not exist, -1 if no expire
      } catch (err) {
        this.isRedisConnected = false;
        console.log("[Database] Redis TTL query failed. Using memory approximation.");
      }
    }

    const item = this.memoryCache.get(key);
    if (!item) return -2;
    if (item.expire === null) return -1;
    const remainingMs = item.expire - Date.now();
    if (remainingMs <= 0) {
      this.memoryCache.delete(key);
      this.persistStateToFile();
      return -2;
    }
    return Math.floor(remainingMs / 1000);
  }

  public async pushHistory(orderData: any): Promise<void> {
    const historicalDoc = {
      ...orderData,
      archivedAt: Date.now(),
    };
    const logString = JSON.stringify(historicalDoc);

    // Save as secondary active backup with no expiry
    if (this.isRedisConnected && this.redis) {
      try {
        // Push to permanent Redis list for secondary backup
        await this.redis.lpush("mover:history_archives", logString);
        // Also keep a reference hash or string key for quick individual lookup
        await this.redis.set(`mover:archived_order:${orderData.deviceId}`, logString);
        console.log(`[Database] Archived order ${orderData.deviceId} permanently to Redis list 'mover:history_archives'.`);
        return;
      } catch (err) {
        this.isRedisConnected = false;
        console.warn("[Database] Redis archival list push failed, falling back to local file backup logs.");
      }
    }

    // In memory permanent store
    const historyKey = "mover:history_archives";
    const existing = this.memoryCache.get(historyKey);
    let logList: string[] = [];
    if (existing) {
      try {
        logList = JSON.parse(existing.value);
      } catch (_) {}
    }
    logList.unshift(logString);
    this.memoryCache.set(historyKey, { value: JSON.stringify(logList), expire: null });
    // Keep individual reference key permanently
    this.memoryCache.set(`mover:archived_order:${orderData.deviceId}`, { value: logString, expire: null });
    this.persistStateToFile();
  }
}

export const cacheService = new CacheService();
