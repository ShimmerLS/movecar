import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { cacheService } from "./server/redis";
import webpush from "web-push";

dotenv.config();

// Helper to load and retrieve sensitive words dynamically from sensitive-words.txt
function getSensitiveWords(): string[] {
  const filePath = path.join(process.cwd(), "sensitive-words.txt");
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"));
    }
  } catch (err) {
    console.error("Failed to read sensitive words file, using default fallback:", err);
  }
  // Soft fallback if file read fails
  return ["傻逼", "煞笔", "sb", "SB", "他妈", "草泥马", "cnm", "垃圾车主", "死全家", "滚蛋"];
}

// Check if message text triggers any sensitive words
function containsSensitiveWords(text: string): boolean {
  if (!text) return false;
  const words = getSensitiveWords();
  const lowerText = text.toLowerCase();
  for (const word of words) {
    if (lowerText.includes(word.toLowerCase())) {
      return true;
    }
  }
  return false;
}

const app = express();
const PORT = 3000;

app.use(express.json());

// WGS-84 to GCJ-02 (China Mars Coordinate System) projection conversion
function wgs84ToGcj02(lat: number, lng: number) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  if (outOfChina(lat, lng)) {
    return { lat, lng };
  }

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat: number, lng: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

// Helper function to send DingTalk messages
async function sendDingTalkMessage(order: any, protocol: string, host: string) {
  const defaultWebhook = "xxxxxxxx"; // ⚠️ 钉钉机器人 Webhook 地址。若无法配置系统环境变量，请清除此处的 xxxxxxxx 并填入真实 Webhook URL。
  const webhook = process.env.DINGTALK_WEBHOOK || defaultWebhook;

  let confirmUrl = "";
  const orderIdentifier = order.id || order.deviceId;
  if (host && !host.includes("127.0.0.1") && !host.includes("localhost")) {
    confirmUrl = `${protocol}://${host}/owner-confirm?id=${orderIdentifier}`;
  } else {
    const fallbackBaseUrl = process.env.APP_URL || "xxxxxxx"; // ⚠️ 部署后对外访问的网络绝对路径（如：https://xxx.xxx.com），若环境无法配置，可在这里写。
    const cleanBase = fallbackBaseUrl.replace(/\/$/, "");
    confirmUrl = `${cleanBase}/owner-confirm?id=${orderIdentifier}`;
  }

  const callNum = order.notifyCount;
  const countLabel = callNum > 1 ? ` (⚠️ 第 ${callNum} 次加急呼叫)` : " (首次求助呼叫)";
  
  let msgBody = `### 🚗 挪车请求通知${countLabel}\n\n`;
  msgBody += `💬 **留言**: ${order.message || "车旁有人等待，麻烦您挪个车"}\n\n`;
  msgBody += `⏰ **最新呼叫时间**: ${new Date(order.lastNotifiedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n`;
  
  if (order.locationStatus === "denied") {
    msgBody += `⚠️ **定位提示**: 对方未授权定位 (申请人已明确拒绝位置共享，坚决不进行IP强行定位)。\n\n`;
  } else if (order.location && order.location.lat && order.location.lng) {
    const gcjLng = order.location.gcjLng || order.location.lng;
    const gcjLat = order.location.gcjLat || order.location.lat;
    const amapUrl = `https://uri.amap.com/marker?position=${gcjLng},${gcjLat}&name=车旁路人位置`;
    const appleUrl = `https://maps.apple.com/?ll=${order.location.lat},${order.location.lng}&q=车旁路人位置`;
    msgBody += `📍 **路单位置**: [打开高德地图导航](${amapUrl}) | [打开苹果地图导航](${appleUrl})\n\n`;
  } else {
    msgBody += `⚠️ **定位提示**: 申请人未共享本次定位坐标。\n\n`;
  }

  msgBody += `📌 请点击以下链接确认您正在赶去：\n`;
  msgBody += `[🔗 点击此处确认挪车并自动回复对方](${confirmUrl})`;

  const dingData = {
    msgtype: "markdown",
    markdown: {
      title: `🚗 挪车请求通知${callNum > 1 ? ` (第${callNum}次)` : ""}`,
      text: msgBody
    }
  };

  try {
    console.log(`[DingTalk] Triggering push to Webhook. Order: ${order.deviceId}, NotifyCount: ${callNum}`);
    const res = await axios.post(webhook, dingData);
    if (res.data && res.data.errcode !== 0) {
      console.error("[DingTalk] Webhook feedback error:", res.data.errmsg);
    } else {
      console.log(`[DingTalk] Notification pushed successfully.`);
    }
  } catch (err: any) {
    console.error("[DingTalk] Webhook routing failure:", err.message);
  }
}

// Helper function to send Bark iOS native push notifications (Option 1)
async function sendBarkNotification(order: any, protocol: string, host: string) {
  const keysStr = process.env.BARK_KEYS || process.env.BARK_KEY;
  if (!keysStr) {
    console.log("[Bark] No BARK_KEYS/BARK_KEY configured, skipping Bark native push.");
    return;
  }

  const serverUrl = (process.env.BARK_SERVER || "https://api.day.app").replace(/\/$/, "");
  const keys = keysStr.split(",").map(k => k.trim()).filter(Boolean);

  let confirmUrl = "";
  const orderIdentifier = order.id || order.deviceId;
  if (host && !host.includes("127.0.0.1") && !host.includes("localhost")) {
    confirmUrl = `${protocol}://${host}/owner-confirm?id=${orderIdentifier}`;
  } else {
    const fallbackBaseUrl = process.env.APP_URL || "";
    if (fallbackBaseUrl) {
      const cleanBase = fallbackBaseUrl.replace(/\/$/, "");
      confirmUrl = `${cleanBase}/owner-confirm?id=${orderIdentifier}`;
    }
  }

  const callNum = order.notifyCount;
  const title = `🚗 挪车请求通知${callNum > 1 ? ` (第 ${callNum} 次加急)` : " (首次求助)"}`;
  let body = `💌 留言: ${order.message || "车旁有人等待，麻烦您挪个车"}\n⏰ 时间: ${new Date(order.lastNotifiedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
  
  if (order.location && order.location.lat && order.location.lng) {
    body += `\n📍 对方已同步共享位置（并在通知中支持苹果和高德导航）`;
  } else {
    body += `\n📍 点击查看详情并可一键确认出发`;
  }

  for (const key of keys) {
    try {
      console.log(`[Bark] Sending push to key prefix: ${key.substring(0, 5)}...`);
      const payload: any = {
        device_key: key,
        title,
        body,
        group: "car_mover",
        category: "car_mover",
        icon: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=128&auto=format&fit=crop", // Clean car icon
        sound: "alarm.caf", // Loud buzzer/alarm sound
        isArchive: 1
      };

      if (confirmUrl) {
        payload.url = confirmUrl;
      }

      await axios.post(`${serverUrl}/push`, payload, { timeout: 4000 });
      console.log(`[Bark] Push notification sent successfully to key ending with ${key.slice(-4)}`);
    } catch (err: any) {
      console.error(`[Bark] Push failure for key ${key.substring(0, 5)}...:`, err.message);
    }
  }
}

// === Web Push API Setup & Helpers ===
let hasVapidInitialized = false;

async function ensureVapidConfig() {
  if (hasVapidInitialized) return;

  let vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
  let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
  const contactEmail = process.env.VAPID_EMAIL || "mailto:admin@example.com";

  if (!vapidPublicKey || !vapidPrivateKey) {
    try {
      const cached = await cacheService.get("mover:vapid_keys");
      if (cached) {
        const parsed = JSON.parse(cached);
        vapidPublicKey = parsed.publicKey;
        vapidPrivateKey = parsed.privateKey;
      } else {
        const generated = webpush.generateVAPIDKeys();
        vapidPublicKey = generated.publicKey;
        vapidPrivateKey = generated.privateKey;
        await cacheService.set(
          "mover:vapid_keys",
          JSON.stringify({ publicKey: vapidPublicKey, privateKey: vapidPrivateKey }),
          315360000 // 10 years / Persistent
        );
        console.log("[WebPush] Generated new persistent VAPID Key pair.");
      }
    } catch (e: any) {
      console.error("[WebPush] Failed to load/generate VAPID Keys:", e.message);
    }
  }

  if (vapidPublicKey && vapidPrivateKey) {
    webpush.setVapidDetails(
      contactEmail,
      vapidPublicKey,
      vapidPrivateKey
    );
    console.log("[WebPush] Configured VAPID details with public key starting with:", vapidPublicKey.substring(0, 10));
    hasVapidInitialized = true;
  }
}

// Dynamic broadcast Web Push native notifications to all subscribed devices in Redis
async function sendWebPushNotifications(order: any, protocol: string, host: string) {
  try {
    await ensureVapidConfig();
    const raw = await cacheService.get("mover:push_subscriptions");
    if (!raw) {
      console.log("[WebPush] No active H5 browser push subscriptions in database.");
      return;
    }

    const subscriptions = JSON.parse(raw);
    if (subscriptions.length === 0) {
      console.log("[WebPush] No push subscriptions found.");
      return;
    }

    let confirmUrl = "";
    const orderIdentifier = order.id || order.deviceId;
    if (host && !host.includes("127.0.0.1") && !host.includes("localhost")) {
      confirmUrl = `${protocol}://${host}/owner-confirm?id=${orderIdentifier}`;
    } else {
      const fallbackBaseUrl = process.env.APP_URL || "";
      if (fallbackBaseUrl) {
        const cleanBase = fallbackBaseUrl.replace(/\/$/, "");
        confirmUrl = `${cleanBase}/owner-confirm?id=${orderIdentifier}`;
      }
    }

    const callNum = order.notifyCount;
    const title = `🚗 挪车请求通知${callNum > 1 ? ` (第 ${callNum} 次加急)` : " (首次求助)"}`;
    let body = `💌 留言: ${order.message || "车旁有人等待，麻烦您挪个车"}\n⏰ 时间: ${new Date(order.lastNotifiedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
    
    if (order.location && order.location.lat && order.location.lng) {
      body += `\n📍 对方已同步共享位置（单击通知在新页面开启导航）`;
    } else {
      body += `\n📍 对方未共享位置，单击通知查看详情且一键确认出发`;
    }

    const payload = JSON.stringify({
      title,
      body,
      url: confirmUrl || "/",
      icon: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=128&auto=format&fit=crop",
      badge: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=128&auto=format&fit=crop"
    });

    const failedSubscriptions: string[] = [];
    console.log(`[WebPush] Broadcasting to ${subscriptions.length} registered H5 device subscriptions in Redis...`);
    
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err: any) {
        // Cleanup expired or dead tokens from Redis on any notification delivery 404/410 errors
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`[WebPush] Pruning expired or dead browser subscription endpoint: ${sub.endpoint}`);
          failedSubscriptions.push(sub.endpoint);
        } else {
          console.warn("[WebPush] Individual notification delivery failure:", err.message);
        }
      }
    }

    if (failedSubscriptions.length > 0) {
      const remainingSub = subscriptions.filter((s: any) => !failedSubscriptions.includes(s.endpoint));
      await cacheService.set("mover:push_subscriptions", JSON.stringify(remainingSub));
      console.log(`[WebPush] Done pruning. Remaining active H5 subscriber count: ${remainingSub.length}`);
    } else {
      console.log("[WebPush] Push broadcast completed successfully across all registered devices.");
    }
  } catch (err: any) {
    console.error("[WebPush] Broadcast processing failure:", err.message);
  }
}

// Serve Web App Manifest for iOS/iPadOS/Android PWA Installation
app.get("/car-icon.jpg", (req, res) => {
  res.sendFile(path.join(process.cwd(), "src/assets/images/car_app_icon_1781308843885.jpg"));
});

app.get("/manifest.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json({
    name: "通知车主挪车",
    short_name: "自助挪车",
    description: "自助挪车系统，支持多端防刷、浏览器原生强提醒振铃推送。",
    start_url: "/?owner=true",
    display: "standalone",
    background_color: "#FAF9F6",
    theme_color: "#8C7851",
    icons: [
      {
        src: "/car-icon.jpg",
        sizes: "512x512",
        type: "image/jpeg"
      }
    ]
  });
});

// Serve Service Worker JavaScript directly with correct Content-Type to browser
app.get("/service-worker.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.send(`
    self.addEventListener('push', function(event) {
      let data = { title: '🚗 挪车请求通知', body: '车身旁有人等待，麻烦您挪个车' };
      try {
        if (event.data) {
          data = event.data.json();
        }
      } catch (e) {
        if (event.data) {
          data.body = event.data.text();
        }
      }

      const options = {
        body: data.body,
        icon: data.icon || "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=128&auto=format&fit=crop",
        badge: data.badge || "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=128&auto=format&fit=crop",
        tag: data.tag || 'car-move-notification',
        data: {
          url: data.url || '/'
        }
      };

      event.waitUntil(
        self.registration.showNotification(data.title, options)
      );
    });

    self.addEventListener('notificationclick', function(event) {
      event.notification.close();
      let urlToOpen = '/';
      if (event.notification.data && event.notification.data.url) {
        urlToOpen = event.notification.data.url;
      }
      event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
          for (var i = 0; i < windowClients.length; i++) {
            var client = windowClients[i];
            if (client.url === urlToOpen && 'focus' in client) {
              return client.focus();
            }
          }
          if (clients.openWindow) {
            return clients.openWindow(urlToOpen);
          }
        })
      );
    });
  `);
});

// Endpoint: Fetch active VAPID Public Key for client subscription registration
app.get("/api/vapid-public-key", async (req, res) => {
  try {
    await ensureVapidConfig();
    const cached = await cacheService.get("mover:vapid_keys");
    let publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey && cached) {
      publicKey = JSON.parse(cached).publicKey;
    }
    return res.json({ publicKey: publicKey || "" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Endpoint: Register or Update PushSubscription to Redis/Local Cache Set
app.post("/api/save-subscription", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, error: "INVALID_SUBSCRIPTION" });
    }

    const raw = await cacheService.get("mover:push_subscriptions");
    const subscriptions = raw ? JSON.parse(raw) : [];

    // Unique endpoints deduplication
    const filtered = subscriptions.filter((s: any) => s.endpoint !== subscription.endpoint);
    filtered.push(subscription);

    await cacheService.set("mover:push_subscriptions", JSON.stringify(filtered));
    console.log(`[WebPush] Subscription saved. Total active synchronized devices in Redis: ${filtered.length}`);
    return res.json({ success: true, count: filtered.length });
  } catch (err: any) {
    console.error("[WebPush] Subscription save transaction failure:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Remove specific PushSubscription from Redis/Local Cache Set (e.g. on client toggle off)
app.post("/api/remove-subscription", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, error: "INVALID_SUBSCRIPTION" });
    }

    const raw = await cacheService.get("mover:push_subscriptions");
    if (raw) {
      const subscriptions = JSON.parse(raw);
      const filtered = subscriptions.filter((s: any) => s.endpoint !== subscription.endpoint);
      await cacheService.set("mover:push_subscriptions", JSON.stringify(filtered));
      console.log(`[WebPush] Subscription manually removed. Remaining: ${filtered.length}`);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 1. 获取活动申请单 (恢复页面用)
app.get("/api/get-active-order", async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    // 优先从 mapping 中查找活跃订单 ID
    const orderId = await cacheService.get(`mover:active_order_id_map:${deviceId}`);
    if (orderId) {
      const orderStr = await cacheService.get(`mover:active_order:${orderId}`);
      if (orderStr) {
        const order = JSON.parse(orderStr);
        return res.json({ success: true, order });
      }
    }

    // 备用兼容本地旧版（直接用 deviceId 为主键的数据）
    const orderStr = await cacheService.get(`mover:active_order:${deviceId}`);
    if (orderStr) {
      const order = JSON.parse(orderStr);
      return res.json({ success: true, order });
    }

    // Check permanent archived orders in case it is already archived
    const archivedStr = await cacheService.get(`mover:archived_order:${deviceId}`);
    if (archivedStr) {
      const order = JSON.parse(archivedStr);
      return res.json({ success: true, order });
    }

    return res.json({ success: false, reason: "NO_ACTIVE_ORDER" });
  } catch (err: any) {
    console.error("error fetching active order:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 获取车主电话号码配置 (一键加急呼叫)
app.get("/api/get-phone", (req, res) => {
  const defaultPhone = "xxxxxxxx"; // ⚠️ 车主的联系电话。若无法配置系统环境变量，请清除此处的 xxxxxxxx 并填入真实手机号码供路人一键呼叫。
  const phone = process.env.PHONE_NUMBER || defaultPhone;
  return res.json({ phone });
});

// 3. 创建申请单
app.post("/api/create-order", async (req, res) => {
  try {
    const { deviceId, message, location, locationStatus } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS", message: "缺少设备唯一标识" });
    }

    // 检测敏感词
    if (message && containsSensitiveWords(message)) {
      return res.status(400).json({
        success: false,
        error: "SENSITIVE_WORDS_DETECTED",
        message: "系统检测到您的留言中包含不文明或敏感词汇，请修改后表达文明用词哦！"
      });
    }

    // 检查并落实 6 小时设备限额防刷限制
    // 🕒 【写进数据库/Redis的时间代码】：
    // 这里的 `mover:rate_limit` 键控制新挪车请求频次限制。
    // 当前配置为 6 小时（21600 秒）。若需要改回 1 小时可设为 3600，10分钟设为 600
    const hasRateLimit = await cacheService.get(`mover:rate_limit:${deviceId}`);
    if (hasRateLimit) {
      const remainingTtl = await cacheService.ttl(`mover:rate_limit:${deviceId}`);
      const hoursPart = Math.floor(remainingTtl / 3600);
      const minutesPart = Math.ceil((remainingTtl % 3600) / 60);
      const timeText = hoursPart > 0 ? `${hoursPart} 小时 ${minutesPart} 分钟` : `${minutesPart} 分钟`;
      return res.status(429).json({
        success: false,
        error: "RATE_LIMIT_ACTIVE",
        message: `安全防护：为了防止骚扰同一设备 6 小时内仅能发起一次全新挪车请求。请在 ${timeText} 后再试。如果是当前正在等待的订单，您依然可以正常再次通知车主或拨打电话。`
      });
    }

    // 创建新订单信息
    const now = Date.now();
    const orderId = "ord_" + Math.random().toString(36).substring(2, 11) + "_" + now;

    // Process location coordinates (convert WGS-84 from client browser to GCJ-02 for high-precision Chinese maps routing)
    let processedLocation = null;
    if (locationStatus !== "denied" && location && typeof location.lat === "number" && typeof location.lng === "number") {
      const gcj = wgs84ToGcj02(location.lat, location.lng);
      processedLocation = {
        lat: location.lat,
        lng: location.lng,
        gcjLat: gcj.lat,
        gcjLng: gcj.lng
      };
    }

    const order = {
      id: orderId, // 赋予唯一的 uuid
      deviceId,
      message: message || "车旁有人等待，麻烦移车",
      createdAt: now,
      notifyCount: 1,
      lastNotifiedAt: now,
      status: "waiting", // 'waiting' | 'confirmed'
      location: processedLocation,
      locationStatus: locationStatus || null,
      confirmedAt: null
    };

    // 🕒 【频率限制存储写入时间】：
    // 这里 21600 秒代表 6 小时限制（6 * 3600）。
    // 若想调节该频度限制，请修改此部分的 TTL 值：如 3600 为 1 小时，86400 为 24 小时。
    await cacheService.set(`mover:rate_limit:${deviceId}`, "1", 21600);

    // 🕒 【活动单缓存写入时间】：
    // 将 uuid 作为主键存入，并记录映射
    await cacheService.set(`mover:active_order:${orderId}`, JSON.stringify(order), 7200);
    await cacheService.set(`mover:active_order_id_map:${deviceId}`, orderId, 7200);

    // 发起钉钉首次群通知与苹果原生 Bark 消息推送及 H5 Web Push 原生浏览器群发
    const protocol = req.headers["x-forwarded-proto"]?.toString() || "https";
    const host = req.headers["x-forwarded-host"]?.toString() || req.headers["host"]?.toString() || "";
    await sendDingTalkMessage(order, protocol, host);
    await sendBarkNotification(order, protocol, host);
    await sendWebPushNotifications(order, protocol, host);

    return res.json({ success: true, order });
  } catch (err: any) {
    console.error("create order failure:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 再次发送通知 (加急) 或更新/增加留言
app.post("/api/notify-again", async (req, res) => {
  try {
    const { deviceId, message } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    // 检测敏感词
    if (message && containsSensitiveWords(message)) {
      return res.status(400).json({
        success: false,
        error: "SENSITIVE_WORDS_DETECTED",
        message: "系统检测到您的加急修改留言中包含不文明或敏感词汇，请修改后表达文明用词哦！"
      });
    }

    let lookupKey = `mover:active_order:${deviceId}`;
    const mappedOrderId = await cacheService.get(`mover:active_order_id_map:${deviceId}`);
    if (mappedOrderId) {
      const exists = await cacheService.get(`mover:active_order:${mappedOrderId}`);
      if (exists) {
        lookupKey = `mover:active_order:${mappedOrderId}`;
      }
    }

    const orderStr = await cacheService.get(lookupKey);
    if (!orderStr) {
      return res.status(404).json({ success: false, error: "ORDER_NOT_FOUND", message: "未找到当前可用的申请单" });
    }

    const order = JSON.parse(orderStr);
    if (order.status === "confirmed") {
      return res.status(400).json({ success: false, error: "ALREADY_CONFIRMED", message: "车主已被确认前往中，无需再次通知" });
    }

    const elapsed = Date.now() - order.lastNotifiedAt;
    let requiredCooldown = 5 * 60 * 1000; // 默认第二次呼叫：等 5 分钟
    if (order.notifyCount >= 2) {
      requiredCooldown = 10 * 60 * 1000; // 第三次及以上呼叫：等 10 分钟
    }

    if (elapsed < requiredCooldown) {
      const remainingMs = requiredCooldown - elapsed;
      return res.status(429).json({
        success: false,
        error: "COOLDOWN_ACTIVE",
        remainingMs,
        message: `请稍作等待，还需要 ${Math.ceil(remainingMs / 1000)} 秒后才能发起下一次通知`
      });
    }

    // 满足冷却条件：更新状态并重新推送通知
    order.notifyCount += 1;
    order.lastNotifiedAt = Date.now();
    
    // 如果路人提交了修改或补充后的留言，则动态追加或更新留言信息并同步推送至车主大屏 and 钉钉
    if (message && message !== order.message) {
      order.message = message;
    }

    // 🕒 【再次通知缓存覆盖更新时间】：
    // 每次催促更新状态依然会重置两小时周期（7200 秒）。可根据实际需求对生命周期时限进行调整
    await cacheService.set(lookupKey, JSON.stringify(order), 7200);
    if (order.id) {
      await cacheService.set(`mover:active_order_id_map:${deviceId}`, order.id, 7200);
    }

    const protocol = req.headers["x-forwarded-proto"]?.toString() || "https";
    const host = req.headers["x-forwarded-host"]?.toString() || req.headers["host"]?.toString() || "";
    await sendDingTalkMessage(order, protocol, host);
    await sendBarkNotification(order, protocol, host);
    await sendWebPushNotifications(order, protocol, host);

    return res.json({ success: true, order });
  } catch (err: any) {
    console.error("notify again failure:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 车主确认挪车 (彻底移除了车主定位询问与获取逻辑)
app.post("/api/owner-confirm", async (req, res) => {
  try {
    const { deviceId, orderId } = req.body;
    if (!deviceId && !orderId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    let lookupKey = "";
    if (orderId) {
      lookupKey = `mover:active_order:${orderId}`;
    } else {
      const mappedOrderId = await cacheService.get(`mover:active_order_id_map:${deviceId}`);
      if (mappedOrderId) {
        lookupKey = `mover:active_order:${mappedOrderId}`;
      } else {
        lookupKey = `mover:active_order:${deviceId}`;
      }
    }

    const orderStr = await cacheService.get(lookupKey);
    let order: any;

    if (orderStr) {
      order = JSON.parse(orderStr);
      if (order.status !== "confirmed") {
        order.status = "confirmed";
        order.confirmedAt = Date.now();
        
        // 🕒 【车主确认活动单子覆盖刷新时间】：
        // 当收到车主出发回应后，将状态保存 2 小时（7200 秒，可在此个性化调节），方便等待路人可以继续看到响应状态
        await cacheService.set(lookupKey, JSON.stringify(order), 7200);
        
        if (order.id && order.deviceId) {
          await cacheService.set(`mover:active_order_id_map:${order.deviceId}`, order.id, 7200);
        }
      }
    } else {
      // 如果活动内存过期了但依然收到了车主确认，做临时内存缓存反馈（不写入持久历史库）
      const finalDeviceId = deviceId || (orderId ? "unknown_device" : "legacy_device");
      order = {
        id: orderId || null,
        deviceId: finalDeviceId,
        message: "车主补签确认（无活动主单）",
        createdAt: Date.now() - 30 * 60 * 1000,
        notifyCount: 1,
        lastNotifiedAt: Date.now() - 30 * 60 * 1000,
        status: "confirmed",
        location: null,
        confirmedAt: Date.now()
      };
      
      // 🕒 【补签确认覆盖刷新时间】：
      // 这里的 3600 秒代表 1 小时。可在此安全个性化定制。
      const finalKey = orderId ? `mover:active_order:${orderId}` : `mover:active_order:${finalDeviceId}`;
      await cacheService.set(finalKey, JSON.stringify(order), 3600);
      if (orderId && finalDeviceId !== "unknown_device") {
        await cacheService.set(`mover:active_order_id_map:${finalDeviceId}`, orderId, 3600);
      }
    }

    return res.json({ success: true, order });
  } catch (err: any) {
    console.error("owner confirm failure:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 轮询车主确认状态
app.get("/api/check-status", async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    // 优先通过映射查找活跃单独订单
    const orderId = await cacheService.get(`mover:active_order_id_map:${deviceId}`);
    let orderStr: string | null = null;
    if (orderId) {
      orderStr = await cacheService.get(`mover:active_order:${orderId}`);
    }
    
    // 兼容退化到传统主键
    if (!orderStr) {
      orderStr = await cacheService.get(`mover:active_order:${deviceId}`);
    }

    if (orderStr) {
      const order = JSON.parse(orderStr);
      return res.json({
        status: order.status,
        notifyCount: order.notifyCount,
        createdAt: order.createdAt,
        lastNotifiedAt: order.lastNotifiedAt,
        confirmedAt: order.confirmedAt
      });
    }

    // 检查是否已被归档备份
    const archivedStr = await cacheService.get(`mover:archived_order:${deviceId}`);
    if (archivedStr) {
      const order = JSON.parse(archivedStr);
      return res.json({
        status: order.status,
        notifyCount: order.notifyCount,
        createdAt: order.createdAt,
        lastNotifiedAt: order.lastNotifiedAt,
        confirmedAt: order.confirmedAt
      });
    }

    return res.json({ status: "idle" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 6. 获取车主确认页对应的呼叫单信息 (提供展示)
app.get("/api/get-owner-order", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS", message: "缺少必要的订单 id 参数" });
    }

    const orderStr = await cacheService.get(`mover:active_order:${id}`);
    if (orderStr) {
      return res.json({ success: true, order: JSON.parse(orderStr) });
    }

    const archivedStr = await cacheService.get(`mover:archived_order:${id}`);
    if (archivedStr) {
      return res.json({ success: true, order: JSON.parse(archivedStr) });
    }

    const isConnected = cacheService.getRedisStatus();
    return res.status(404).json({ 
      success: false, 
      error: "ORDER_NOT_FOUND",
      message: `找不到对应的挪车单（可能因过期或服务重启而失效）。\n核心诊断提示：当前服务器多容器共享存储 (Redis) 状态: ${isConnected ? "● 已连接 (Online)" : "○ 未连接/本地内存降级 (Local Fallback)"}。\n提示：若您使用多台服务器/谷歌 Cloud Run 容器集群，必须配置 REDIS_HOST 环境变量连接共享 Redis，否则多设备点击很容易分配到没有该订单状态的空节点。`
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Full-Stack: mount Vite middleware or serve static assets
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Self-service Car Mover running at http://localhost:${PORT}`);
  });
}

startServer();
