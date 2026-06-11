import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { cacheService } from "./server/redis";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Helper function to send DingTalk messages
async function sendDingTalkMessage(order: any, protocol: string, host: string) {
  const defaultWebhook = "xxxxxxxx"; // ⚠️ 钉钉机器人 Webhook 地址。若无法配置系统环境变量，请清除此处的 xxxxxxxx 并填入真实 Webhook URL。
  const webhook = process.env.DINGTALK_WEBHOOK || defaultWebhook;

  let confirmUrl = "";
  if (host && !host.includes("127.0.0.1") && !host.includes("localhost")) {
    confirmUrl = `${protocol}://${host}/owner-confirm?id=${order.deviceId}`;
  } else {
    const fallbackBaseUrl = process.env.APP_URL || "xxxxxxx"; // ⚠️ 部署后对外访问的网络绝对路径（如：https://xxx.xxx.com），若环境无法配置，可在这里写。
    const cleanBase = fallbackBaseUrl.replace(/\/$/, "");
    confirmUrl = `${cleanBase}/owner-confirm?id=${order.deviceId}`;
  }

  const callNum = order.notifyCount;
  const countLabel = callNum > 1 ? ` (⚠️ 第 ${callNum} 次加急呼叫)` : " (首次求助呼叫)";
  
  let msgBody = `### 🚗 挪车请求通知${countLabel}\n\n`;
  msgBody += `💬 **留言**: ${order.message || "车旁有人等待，麻烦您挪个车"}\n\n`;
  msgBody += `⏰ **最新呼叫时间**: ${new Date(order.lastNotifiedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n`;
  
  if (order.locationStatus === "denied") {
    msgBody += `⚠️ **定位提示**: 对方未授权定位 (申请人已明确拒绝位置共享，坚决不进行IP强行定位)。\n\n`;
  } else if (order.location && order.location.lat && order.location.lng) {
    const amapUrl = `https://uri.amap.com/marker?position=${order.location.lng},${order.location.lat}&name=车旁路人位置`;
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

// 1. 获取活动申请单 (恢复页面用)
app.get("/api/get-active-order", async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

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
    const order = {
      deviceId,
      message: message || "车旁有人等待，麻烦移车",
      createdAt: now,
      notifyCount: 1,
      lastNotifiedAt: now,
      status: "waiting", // 'waiting' | 'confirmed'
      location: locationStatus === "denied" ? null : (location || null),
      locationStatus: locationStatus || null,
      confirmedAt: null
    };

    // 🕒 【频率限制存储写入时间】：
    // 这里 21600 秒代表 6 小时限制（6 * 3600）。
    // 若想调节该频度限制，请修改此部分的 TTL 值：如 3600 为 1 小时，86400 为 24 小时。
    await cacheService.set(`mover:rate_limit:${deviceId}`, "1", 21600);

    // 🕒 【活动单缓存写入时间】：
    // 这里 7200 秒代表 2 小时活动单缓存期失效（用于客户端轮询和车主网页端访问）。
    // 若您希望只要订单没收到确认就永久/长期支持访问，可提升此时间（如 86400 为 24 小时，604800 为一周）。
    await cacheService.set(`mover:active_order:${deviceId}`, JSON.stringify(order), 7200);

    // 发起钉钉首次群通知
    const protocol = req.headers["x-forwarded-proto"]?.toString() || "https";
    const host = req.headers["x-forwarded-host"]?.toString() || req.headers["host"]?.toString() || "";
    await sendDingTalkMessage(order, protocol, host);

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

    const orderStr = await cacheService.get(`mover:active_order:${deviceId}`);
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
    
    // 如果路人提交了修改或补充后的留言，则动态追加或更新留言信息并同步推送至车主大屏和钉钉
    if (message && message !== order.message) {
      order.message = message;
    }

    // 🕒 【再次通知缓存覆盖更新时间】：
    // 每次催促更新状态依然会重置两小时周期（7200 秒）。可根据实际需求对生命周期时限进行调整
    await cacheService.set(`mover:active_order:${deviceId}`, JSON.stringify(order), 7200);

    const protocol = req.headers["x-forwarded-proto"]?.toString() || "https";
    const host = req.headers["x-forwarded-host"]?.toString() || req.headers["host"]?.toString() || "";
    await sendDingTalkMessage(order, protocol, host);

    return res.json({ success: true, order });
  } catch (err: any) {
    console.error("notify again failure:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 车主确认挪车 (彻底移除了车主定位询问与获取逻辑)
app.post("/api/owner-confirm", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    const orderStr = await cacheService.get(`mover:active_order:${deviceId}`);
    let order: any;

    if (orderStr) {
      order = JSON.parse(orderStr);
      if (order.status !== "confirmed") {
        order.status = "confirmed";
        order.confirmedAt = Date.now();
        
        // 🕒 【车主确认活动单子覆盖刷新时间】：
        // 当收到车主出发回应后，将状态保存 2 小时（7200 秒，可在此个性化调节），方便等待路人可以继续看到响应状态
        await cacheService.set(`mover:active_order:${deviceId}`, JSON.stringify(order), 7200);
        
        // ⚠️ 【按要求注释】：根据您的“车主的回应不需要写入数据库永久保留”最新要求，彻底取消 pushHistory 永久归档动作。
        // if (cacheService.isRedisConnected) { await cacheService.pushHistory(order); }
      }
    } else {
      // 如果活动内存过期了但依然收到了车主确认，做临时内存缓存反馈（不写入持久历史库）
      order = {
        deviceId,
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
      await cacheService.set(`mover:active_order:${deviceId}`, JSON.stringify(order), 3600);
      
      // ⚠️ 【按要求注释】：根据您的“车主的回应不需要写入数据库永久保留”最新要求，彻底取消 pushHistory 永久库归档。
      // if (cacheService.isRedisConnected) { await cacheService.pushHistory(order); }
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

    const orderStr = await cacheService.get(`mover:active_order:${deviceId}`);
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
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    const orderStr = await cacheService.get(`mover:active_order:${id}`);
    if (orderStr) {
      return res.json({ success: true, order: JSON.parse(orderStr) });
    }

    const archivedStr = await cacheService.get(`mover:archived_order:${id}`);
    if (archivedStr) {
      return res.json({ success: true, order: JSON.parse(archivedStr) });
    }

    return res.status(404).json({ success: false, error: "ORDER_NOT_FOUND" });
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
