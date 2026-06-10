import React, { useState, useEffect } from "react";
import {
  Phone,
  CheckCircle,
  AlertCircle,
  Bell,
  MapPin,
  Clock,
  Sparkles,
  Smile,
  RotateCcw,
  ShieldAlert,
  Car
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Fallback user mobile phone number (configured on server or below)
// We will load this dynamically via API during startup. Below is the default placeholder.
const DEFAULT_OWNER_PHONE = "xxxxxxxx"; // ⚠️ 车主的联系电话，若未在服务端配置环境变量，可在此处直接填入真实的号码

export default function App() {
  const [deviceId, setDeviceId] = useState<string>("");
  const [page, setPage] = useState<"loading" | "form" | "waiting" | "owner" | "archived" | "error">("loading");
  
  // Application Data States
  const [activeOrder, setActiveOrder] = useState<any>(null);
  const [ownerOrder, setOwnerOrder] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [ownerPhone, setOwnerPhone] = useState<string>(DEFAULT_OWNER_PHONE);

  // Applicant Input States
  const [messageText, setMessageText] = useState<string>("");
  const [updateMessageText, setUpdateMessageText] = useState<string>("");
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locStatus, setLocStatus] = useState<"idle" | "getting" | "success" | "fallback" | "denied" | "error">("idle");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Cooldown / Timers
  const [notifyCooldownSec, setNotifyCooldownSec] = useState<number>(0);
  const [showDirectCall, setShowDirectCall] = useState<boolean>(false);
  const [minutesToCallDisplay, setMinutesToCallDisplay] = useState<string>("");

  // Sync update message text when active order loads or modifies
  useEffect(() => {
    if (activeOrder && activeOrder.message) {
      setUpdateMessageText(activeOrder.message);
    }
  }, [activeOrder]);

  // Owner confirmation actions
  const [isOwnerSubmitting, setIsOwnerSubmitting] = useState<boolean>(false);
  const [ownerConfirmedMessage, setOwnerConfirmedMessage] = useState<boolean>(false);

  // Quick preset tags matching Natural Tones styling presets
  const tagsPreset = [
    { text: "您的车挡住我了", icon: "🚧" },
    { text: "临时停靠一下", icon: "⏱️" },
    { text: "无法出车急需出行", icon: "📞" },
    { text: "麻烦您尽快挪一下", icon: "🙏" }
  ];

  // 1. Initialize Device ID, Config & Determine Route Page
  useEffect(() => {
    let dId = localStorage.getItem("mover_device_id");
    if (!dId) {
      dId = "device_" + Math.random().toString(36).substring(2, 11) + "_" + Date.now();
      localStorage.setItem("mover_device_id", dId);
    }
    setDeviceId(dId);

    // Fetch owner phone configuration from the server
    fetch("/api/get-phone")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.phone && data.phone !== "xxxxxxxx") {
          setOwnerPhone(data.phone);
        }
      })
      .catch((err) => {
        console.log("Failed to load server config dynamically. Using fallback default.");
      });

    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get("id") || params.get("deviceId");
    const isOwnerRoute = window.location.pathname.startsWith("/owner-confirm") || params.has("id");

    if (isOwnerRoute && idFromUrl) {
      setPage("owner");
      fetchOwnerOrder(idFromUrl);
    } else {
      checkExistingOrderOnLoad(dId);
    }
  }, []);

  // 2. Load active order from server (retains screen across reloads)
  const checkExistingOrderOnLoad = async (dId: string) => {
    try {
      const response = await fetch(`/api/get-active-order?deviceId=${dId}`);
      const data = await response.json();
      if (data.success && data.order) {
        setActiveOrder(data.order);
        setPage("waiting");
      } else {
        setPage("form");
        requestApplicantLocation();
      }
    } catch (err) {
      console.error("Failed to recover previous session details from server", err);
      setPage("form");
    }
  };

  // 3. Fetch specific order for owner confirmation
  const fetchOwnerOrder = async (id: string) => {
    try {
      const res = await fetch(`/api/get-owner-order?id=${id}`);
      const data = await res.json();
      if (data.success && data.order) {
        setOwnerOrder(data.order);
        if (data.order.status === "confirmed") {
          setOwnerConfirmedMessage(true);
        }
      } else {
        setErrorMessage("找不到当前所引用的车位/挪车申请详情，或已过期。");
        setPage("error");
      }
    } catch (err) {
      setErrorMessage("网络连接超时，获取挪车订单失败。");
      setPage("error");
    }
  };

  // 4. Request location coordinates from caller (applicant)
  const requestApplicantLocation = () => {
    if (!navigator.geolocation) {
      setLocStatus("error");
      return;
    }
    
    setLocStatus("getting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude
        });
        setLocStatus("success");
      },
      (err) => {
        console.warn("Location permission denied or timed out:", err.message);
        // Explicitly check for permission refusal (code 1 is PERMISSION_DENIED)
        if (err.code === 1 || err.code === err.PERMISSION_DENIED) {
          setLocStatus("denied");
          setUserLocation(null);
        } else {
          setLocStatus("fallback");
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  };

  // 5. Submit applicant request
  const submitMoveCarRequest = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          message: messageText || "车旁有人等待，麻烦移车",
          location: locStatus === "denied" ? null : userLocation,
          locationStatus: locStatus === "denied" ? "denied" : (userLocation ? "success" : "none")
        })
      });

      const data = await response.json();
      if (response.status === 429) {
        setErrorMessage(data.message || "由于安全限制，该设备每小时只能开一个申请单。");
        setPage("error");
      } else if (data.success && data.order) {
        setActiveOrder(data.order);
        setPage("waiting");
      } else {
        alert(data.message || "发送失败，请稍后重试");
      }
    } catch (err) {
      alert("网络错误，发送挪车请求失败，请检查网络设置。");
    } finally {
      setIsSubmitting(false);
    }
  };

  // 6. Polling effect on Applicant waiting screen to check owner status
  useEffect(() => {
    if (page !== "waiting" || !activeOrder) return;

    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/check-status?deviceId=${activeOrder.deviceId}`);
        const data = await res.json();
        if (data.status === "confirmed") {
          setActiveOrder((prev: any) => ({
            ...prev,
            status: "confirmed",
            confirmedAt: data.confirmedAt
          }));
        } else if (data.notifyCount !== undefined && data.notifyCount > activeOrder.notifyCount) {
          setActiveOrder((prev: any) => ({
            ...prev,
            notifyCount: data.notifyCount,
            lastNotifiedAt: data.lastNotifiedAt
          }));
        }
      } catch (err) {
        // Ignore polling errors quietly
      }
    }, 3000);

    return () => clearInterval(timer);
  }, [page, activeOrder]);

  // 7. Track limits and cooldown timers for "Notify Again" and "Direct Call"
  useEffect(() => {
    if (page !== "waiting" || !activeOrder) return;

    const computeTimeouts = () => {
      const now = Date.now();
      
      const elapsedSincePrevious = now - activeOrder.lastNotifiedAt;
      const cooldownRequirement = activeOrder.notifyCount === 1 ? 5 * 60 * 1000 : 10 * 60 * 1000;
      
      const secondsLeft = Math.ceil((cooldownRequirement - elapsedSincePrevious) / 1000);
      setNotifyCooldownSec(secondsLeft > 0 ? secondsLeft : 0);

      const elapsedSinceCreation = now - activeOrder.createdAt;
      const phoneCallRequired = 10 * 60 * 1000;
      const diffPhoneMs = phoneCallRequired - elapsedSinceCreation;

      if (diffPhoneMs <= 0) {
        setShowDirectCall(true);
      } else {
        setShowDirectCall(false);
        const minLeft = Math.floor(diffPhoneMs / 1000 / 60);
        const secLeft = Math.floor((diffPhoneMs / 1000) % 60);
        setMinutesToCallDisplay(`${minLeft}分${secLeft.toString().padStart(2, "0")}秒`);
      }
    };

    computeTimeouts();
    const interval = setInterval(computeTimeouts, 1000);
    return () => clearInterval(interval);
  }, [page, activeOrder]);

  // 8. Handle Applicant Triggering subsequent Notifications (再次通知)
  const triggerPushNotificationAgain = async () => {
    if (notifyCooldownSec > 0 || !activeOrder) return;

    try {
      const res = await fetch("/api/notify-again", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          deviceId: activeOrder.deviceId,
          message: updateMessageText || activeOrder.message
        })
      });
      const data = await res.json();
      if (data.success && data.order) {
        setActiveOrder(data.order);
        alert(`🚨 加急通知发送成功！这是您的第 ${data.order.notifyCount} 次求助。`);
      } else {
        alert(data.message || "发送失败，请稍后刷新重试");
      }
    } catch (err) {
      alert("网络问题，加急通知发送失败。");
    }
  };

  // 9. Handle Owner Confirmation
  const confirmMovingAction = async () => {
    if (isOwnerSubmitting || !ownerOrder) return;
    setIsOwnerSubmitting(true);

    try {
      const response = await fetch("/api/owner-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: ownerOrder.deviceId })
      });

      const data = await response.json();
      if (data.success) {
        setOwnerConfirmedMessage(true);
      } else {
        alert("确认失败，请检查连接状态！");
      }
    } catch (err) {
      alert("确认提交异常，网络不可达。");
    } finally {
      setIsOwnerSubmitting(false);
    }
  };

  const formatSecondsToMinutes = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}分${secs.toString().padStart(2, "0")}秒`;
  };

  return (
    <div id="self_service_mover_hub" className="min-h-screen bg-[#F7F5F0] text-[#4A453E] flex flex-col justify-between font-sans antialiased selection:bg-[#8C7851]/10">
      
      {/* Brand Header */}
      <header className="p-6 border-b border-[#EBE7DE] bg-white flex items-center justify-between sticky top-0 z-40 max-w-xl mx-auto w-full shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-[#8C7851]/10 text-[#8C7851] p-2.5 rounded-2xl border border-[#8C7851]/20">
            <Car className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-md font-bold tracking-tight text-[#2D2A26] font-serif">智能自助挪车</h1>
            <p className="text-[10px] text-[#968F85] font-mono tracking-wider uppercase">Tencent Serverless &bull; Redis 6.2</p>
          </div>
        </div>

        {page === "form" && (
          <span className="text-[11px] bg-[#F1EDE4] text-[#8C7851] px-2.5 py-1 rounded-full font-semibold border border-[#EBE7DE] flex items-center gap-1.5 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            就绪
          </span>
        )}

        {page === "waiting" && (
          <span className="text-[11px] bg-[#8C7851]/10 text-[#8C7851] px-3 py-1 rounded-full font-bold border border-[#8C7851]/20 flex items-center gap-1.5 animate-pulse">
            <span className="w-2 h-2 rounded-full bg-[#8C7851]"></span>
            调度中
          </span>
        )}
      </header>

      {/* Main Body Scaffolding (Natural Tone Canvas Cards) */}
      <main className="flex-grow max-w-xl mx-auto w-full p-4 flex flex-col justify-start">
        <div className="w-full bg-white rounded-[32px] shadow-2xl shadow-[#E3DED0]/50 border border-[#EBE7DE] overflow-hidden p-6 md:p-8 space-y-6">
          <AnimatePresence mode="wait">
            
            {/* A. Loading State */}
            {page === "loading" && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-12 text-center flex flex-col items-center justify-center space-y-4"
              >
                <div className="w-14 h-14 border-4 border-[#F1EDE4] border-t-[#8C7851] rounded-full animate-spin"></div>
                <div>
                  <h2 className="text-lg font-serif font-bold text-[#2D2A26]">正在检索挪车会话...</h2>
                  <p className="text-xs text-[#968F85] mt-1.5 max-w-xs mx-auto">
                    系统正安全校验 Redis 安全锁以恢复历史盘面，请稍等
                  </p>
                </div>
              </motion.div>
            )}

            {/* B. Form submission page */}
            {page === "form" && (
              <motion.div
                key="form"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                {/* Header Tag */}
                <div className="text-center pt-2 pb-1">
                  <div className="inline-flex mb-3 px-4 py-1.5 bg-[#F1EDE4] rounded-full text-[#8C7851] text-xs font-bold uppercase tracking-widest border border-[#EBE7DE]/80">
                    一键闪传 &bull; 无重定向
                  </div>
                  <h2 className="text-2xl font-serif text-[#2D2A26] font-normal leading-snug">请留下留言呼叫车主</h2>
                  <p className="text-xs text-[#968F85] mt-2 max-w-sm mx-auto leading-relaxed">
                    无需当面争执，通过后台机器人秒级拨打群机通知，安全便捷解决车辆占用。
                  </p>
                </div>

                {/* Textarea Input area styled with warm inputs */}
                <div className="space-y-3.5">
                  <div className="flex justify-between items-center px-1">
                    <label htmlFor="userMessageArea" className="text-xs font-bold text-[#4A453E] tracking-wider">您的留言内容：</label>
                    <span className="text-[11px] text-[#968F85]">支持快捷短语输入</span>
                  </div>
                  <textarea
                    id="userMessageArea"
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    placeholder="请输入移车要求（选填：如车子挡在商铺门口、临时停靠急需外出等）"
                    className="w-full h-28 bg-[#FAF9F6] border border-[#EBE7DE] rounded-2xl p-4 text-sm text-[#2D2A26] placeholder-[#C5BEB5] focus:outline-none focus:border-[#8C7851] focus:ring-1 focus:ring-[#8C7851]/10 transition duration-150 resize-none font-sans"
                  />

                  {/* Preset Quick phrases tags */}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {tagsPreset.map((tag, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setMessageText(tag.text)}
                        className="bg-[#FAF9F6] hover:bg-[#F1EDE4]/80 text-[#8C7851] text-xs px-3 py-2 rounded-xl border border-[#EBE7DE] transition duration-150 flex items-center gap-1.5"
                      >
                        <span>{tag.icon}</span>
                        <span className="font-medium">{tag.text}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Location card */}
                <div className="bg-[#FAF9F6] rounded-2xl p-4 border border-[#EBE7DE] flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-xl border ${
                      locStatus === "success" 
                        ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/20" 
                        : locStatus === "denied"
                        ? "bg-rose-500/10 text-rose-600 border-rose-500/20"
                        : locStatus === "error" || locStatus === "fallback"
                        ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                        : "bg-white text-[#968F85] border-[#EBE7DE]"
                    }`}>
                      <MapPin className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-[#2D2A26]">当前求助定位</h4>
                      <p className="text-[11px] text-[#968F85] mt-1 leading-tight">
                        {locStatus === "getting" && "精细定位信息获取中..."}
                        {locStatus === "success" && "位置坐标已采集成功✓"}
                        {locStatus === "fallback" && "未共享位置 (信息依然可推送)"}
                        {locStatus === "denied" && "未授权获取位置 (车主将收到未授权提示)"}
                        {locStatus === "error" && "定位服务不可运行"}
                        {locStatus === "idle" && "等待加载坐标信息"}
                      </p>
                    </div>
                  </div>

                  {(locStatus === "error" || locStatus === "fallback" || locStatus === "denied") && (
                    <button
                      onClick={requestApplicantLocation}
                      className="text-xs text-[#8C7851] font-bold border border-[#8C7851]/20 px-2.5 py-1.5 rounded-lg bg-white hover:bg-[#FAF9F6] transition active:scale-95"
                    >
                      重新获取
                    </button>
                  )}
                </div>

                {/* Prompt Info */}
                <div className="bg-[#FAF9F6] p-4 rounded-2xl border border-[#EBE7DE] flex gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[#F1EDE4] flex items-center justify-center text-[#8C7851] shrink-0 font-bold text-xs">!</div>
                  <div className="space-y-0.5">
                    <div className="text-xs font-bold text-[#4A453E]">限制发起频次</div>
                    <div className="text-[10px] text-[#968F85] leading-normal">根据系统防扰标准，单台物理设备在一个小时里仅能开一个申请单。</div>
                  </div>
                </div>

                {/* Form submit dispatch button */}
                <button
                  id="userSubmitBtn"
                  onClick={submitMoveCarRequest}
                  disabled={isSubmitting}
                  className="w-full bg-[#8C7851] hover:bg-[#736341] disabled:bg-[#E8E4DE] text-white disabled:text-[#B8B2A9] font-bold py-4 rounded-2xl shadow-xl shadow-[#8C7851]/10 transition duration-150 flex items-center justify-center gap-2 text-md"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                      <span>正在急传车主网络...</span>
                    </>
                  ) : (
                    <>
                      <Bell className="w-4 h-4 text-[#FAF9F6]" />
                      <span>呼叫车主</span>
                    </>
                  )}
                </button>
              </motion.div>
            )}

            {/* C. Waiting Screen Theme Implementation */}
            {page === "waiting" && activeOrder && (
              <motion.div
                key="waiting"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                {activeOrder.status === "confirmed" ? (
                  /* Owner Confirmed Status Display */
                  <div className="text-center py-6 space-y-4">
                    <div className="w-16 h-16 bg-green-500/10 text-green-700 border border-green-500/20 rounded-full flex items-center justify-center mx-auto">
                      <CheckCircle className="w-10 h-10" />
                    </div>
                    <div>
                      <div className="inline-flex mb-3 px-3 py-1 bg-green-500/10 rounded-full text-green-700 text-xs font-bold tracking-widest border border-green-500/20">
                        车主反馈确认
                      </div>
                      <h2 className="text-2xl font-serif text-[#2D2A26] font-normal leading-snug">车主已知晓，正在前往</h2>
                      <p className="text-xs text-[#968F85] mt-2 max-w-sm mx-auto leading-relaxed">
                        车主刚才已在调度终端确认，正在向您所在的停靠方向进发。请妥善在车辆附近耐心等候。
                      </p>
                    </div>

                    <div className="bg-[#FAF9F6] max-w-xs mx-auto p-3.5 rounded-xl border border-[#EBE7DE] text-[11px] text-[#968F85] font-mono">
                      确认时间: {new Date(activeOrder.confirmedAt || Date.now()).toLocaleTimeString()}
                    </div>
                  </div>
                ) : (
                  /* Waiting Dynamic Timeline Circle Display */
                  <div className="space-y-6">
                    
                    {/* Header Details */}
                    <div className="text-center">
                      <div className="inline-flex mb-2 px-3  py-1 bg-[#F1EDE4] rounded-full text-[#8C7851] text-[10px] font-bold tracking-widest uppercase border border-[#EBE7DE]">
                        当前状态：等待车主确认
                      </div>
                      <h2 className="text-3xl font-serif font-light text-[#2D2A26]">请耐心等待车主确认</h2>
                      <p className="text-[#968F85] text-xs mt-2 max-w-sm mx-auto leading-relaxed">
                        您的挪车申请已安全锁定至云端。为了保障车主，系统对二次催促设置了防护要求。
                      </p>
                    </div>

                    {/* Progress Circle Visual Timer (Mock countdown logic matching style instructions) */}
                    <div className="flex flex-col items-center justify-center my-6">
                      <div className="relative w-52 h-52 flex items-center justify-center bg-[#FAF9F6] rounded-full border border-[#EBE7DE] shadow-inner">
                        <svg className="absolute inset-0 w-full h-full -rotate-90 p-1">
                          <circle cx="104" cy="104" r="94" stroke="#F1EDE4" strokeWidth="6" fill="none" />
                          <circle 
                            cx="104" 
                            cy="104" 
                            r="94" 
                            stroke="#8C7851" 
                            strokeWidth="6" 
                            fill="none" 
                            strokeDasharray="590.6" 
                            strokeDashoffset={notifyCooldownSec > 0 ? (590.6 - (590.6 * (notifyCooldownSec / (activeOrder.notifyCount === 1 ? 300 : 600)))) : 0} 
                            className="transition-all duration-1000 ease-linear"
                          />
                        </svg>
                        <div className="flex flex-col items-center text-center">
                          {notifyCooldownSec > 0 ? (
                            <span className="text-4xl font-serif font-light text-[#2D2A26] tracking-tighter">
                              {formatSecondsToMinutes(notifyCooldownSec)}
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-emerald-600 tracking-widest flex items-center gap-1 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                              ● 冷却就绪
                            </span>
                          )}
                          <span className="text-[9px] text-[#968F85] mt-1.5 uppercase tracking-[0.2em]">可发起再次通知</span>
                        </div>
                      </div>
                    </div>

                    {/* Sequential Alert notifications stages matching Design HTML */}
                    <div className="grid grid-cols-3 gap-3 w-full">
                      <div className="p-3 rounded-2xl bg-[#FAF9F6] border border-[#EBE7DE] text-left">
                        <div className="text-[9px] text-[#968F85] uppercase mb-1 font-semibold">第一次通知</div>
                        <div className="text-xs font-bold text-emerald-700 flex items-center gap-1">✓ 已发送</div>
                      </div>
                      <div className={`p-3 rounded-2xl bg-[#FAF9F6] text-left border ${
                        activeOrder.notifyCount >= 2 
                          ? "border-[#EBE7DE]" 
                          : "border-[#8C7851]/30 relative overflow-hidden"
                      }`}>
                        <div className="text-[9px] text-[#968F85] uppercase mb-1 font-semibold">第二次通知</div>
                        <div className="text-xs font-bold text-[#4A453E]">
                          {activeOrder.notifyCount >= 2 ? "✓ 已发送" : "需等待 5 分钟"}
                        </div>
                      </div>
                      <div className={`p-3 rounded-2xl bg-[#FAF9F6] text-left border ${
                        activeOrder.notifyCount >= 3 
                          ? "border-[#EBE7DE]" 
                          : "border-[#EBE7DE] opacity-40"
                      }`}>
                        <div className="text-[9px] text-[#968F85] uppercase mb-1 font-semibold">第三次通知</div>
                        <div className="text-xs font-bold text-[#4A453E]">
                          {activeOrder.notifyCount >= 3 ? "✓ 已发送" : "需等待 10 分钟"}
                        </div>
                      </div>
                    </div>

                    {/* Action Panel: Re-notify and Phone details */}
                    <div className="space-y-3.5 pt-4 border-t border-[#EBE7DE]">
                      
                      {/* 催促补充/修改留言输入区 */}
                      {notifyCooldownSec === 0 && (
                        <div className="space-y-1.5 text-left bg-amber-500/5 border border-amber-500/10 p-3 rounded-2xl mb-2">
                          <label htmlFor="updateMsgText" className="text-[11px] font-bold text-[#4A453E] flex items-center gap-1">
                            💬 补充/修改本次催促留言内容：
                          </label>
                          <textarea
                            id="updateMsgText"
                            value={updateMessageText}
                            onChange={(e) => setUpdateMessageText(e.target.value)}
                            placeholder="可在此写入新的口信提示（如：“雨特别大🙏麻烦辛苦尽快来一下”、“手里拿了重物难移步”等）"
                            className="w-full h-14 bg-white border border-[#EBE7DE] rounded-xl p-2.5 text-[#4A453E] placeholder-[#C5BEB5] focus:outline-none focus:border-[#8C7851] focus:ring-1 focus:ring-[#8C7851]/10 transition duration-150 resize-none text-[11px] leading-relaxed"
                          />
                        </div>
                      )}

                      {/* Notify button based on Cooldown status */}
                      <div>
                        {notifyCooldownSec > 0 ? (
                          <button
                            disabled
                            className="w-full py-4 rounded-2xl bg-[#E8E4DE] text-[#B8B2A9] font-semibold cursor-not-allowed flex items-center justify-center gap-2 border border-[#E2DDD5]"
                          >
                            <Clock className="w-4 h-4 shrink-0" />
                            <span>再次通知 (冷却倒计时: {formatSecondsToMinutes(notifyCooldownSec)})</span>
                          </button>
                        ) : (
                          <button
                            onClick={triggerPushNotificationAgain}
                            className="w-full py-4 rounded-2xl bg-[#8C7851] hover:bg-[#736341] text-white font-bold transition duration-150 flex items-center justify-center gap-2 shadow-lg shadow-[#8C7851]/10"
                          >
                            <Bell className="w-4 h-4" />
                            <span>再次发起催挪通知</span>
                          </button>
                        )}
                      </div>

                      {/* Phone unlock panel (10 minutes call lock implementation) */}
                      <div>
                        {showDirectCall ? (
                          <a
                            href={`tel:${ownerPhone}`}
                            className="w-full py-3.5 rounded-2xl bg-amber-600 hover:bg-amber-700 text-white font-semibold transition flex items-center justify-center gap-2 text-xs border border-amber-500/20 shadow-md"
                          >
                            <Phone className="w-3.5 h-3.5" />
                            <span>电话加急联络车主</span>
                          </a>
                        ) : (
                          <div className="flex items-center justify-center py-3.5 px-4 rounded-2xl border border-dashed border-[#D6CFC4] bg-[#FDFBF7]">
                            <span className="text-[11px] text-[#968F85] text-center">
                              ⚠️ 电话加急功能将在首次发送 10 分钟后解锁（剩余：{minutesToCallDisplay}）
                            </span>
                          </div>
                        )}
                      </div>

                    </div>

                    {/* Static metadata */}
                    <div className="text-[10px] text-[#968F85] space-y-1 bg-[#FAF9F6] p-4 rounded-xl border border-[#EBE7DE]/70 font-mono">
                      <div className="flex justify-between">
                        <span>申请批次 ID:</span>
                        <span className="text-[#4A453E]">{deviceId.substring(0, 16)}...</span>
                      </div>
                      <div className="flex justify-between">
                        <span>累计催化呼叫:</span>
                        <span className="text-[#4A453E]">{activeOrder.notifyCount} 次</span>
                      </div>
                      <div className="flex justify-between">
                        <span>首次发送网络:</span>
                        <span className="text-[#4A453E]">{new Date(activeOrder.createdAt).toLocaleTimeString()}</span>
                      </div>
                    </div>

                  </div>
                )}
              </motion.div>
            )}

            {/* D. Owner Confirmation state ('删除车主定位功能', preserved confirmed state backup) */}
            {page === "owner" && ownerOrder && (
              <motion.div
                key="owner"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                <div className="text-center pt-2">
                  <div className="inline-flex mb-3 px-4 py-1.5 bg-[#F1EDE4] rounded-full text-[#8C7851] text-xs font-bold uppercase tracking-widest border border-[#EBE7DE]/80">
                    车主专线 &bull; 隐私加密
                  </div>
                  <h2 className="text-2xl font-serif text-[#2D2A26] font-normal leading-tight">请您在挪车后确认反馈</h2>
                  <p className="text-xs text-[#968F85] mt-2 max-w-sm mx-auto leading-relaxed">
                    路人正在车旁等候。您可以一键点击确认，系统将立即向路人的等待端大屏同步您的响应数据。
                  </p>
                </div>

                {/* Message display card */}
                <div className="bg-[#FAF9F6] rounded-2xl p-5 border border-[#EBE7DE] space-y-2.5">
                  <span className="text-[10px] text-[#968F85] tracking-widest uppercase block font-semibold">对方留下的挪车要求:</span>
                  <div className="bg-white p-4 rounded-xl border border-[#EBE7DE] text-sm text-[#2D2A26] leading-relaxed italic font-serif">
                    &rdquo;{ownerOrder.message || "车旁有人等待，麻烦您挪个车"}&rdquo;
                  </div>

                  {/* Caller GPS if shared by applicant */}
                  {ownerOrder.location && ownerOrder.location.lat && ownerOrder.location.lng && ownerOrder.locationStatus !== "denied" ? (
                    <div className="pt-3 border-t border-[#EBE7DE]/80">
                      <span className="text-[10px] text-[#968F85] block font-semibold mb-2">路人当前位置导航：</span>
                      <div className="grid grid-cols-2 gap-2">
                        <a
                          href={`https://uri.amap.com/marker?position=${ownerOrder.location.lng},${ownerOrder.location.lat}&name=车旁路人位置`}
                          target="_blank"
                          rel="noreferrer"
                          className="bg-sky-600 hover:bg-[#1890ff] text-white text-xs font-semibold py-2.5 rounded-xl text-center shadow-md transition duration-150"
                        >
                          高德地图
                        </a>
                        <a
                          href={`https://maps.apple.com/?ll=${ownerOrder.location.lat},${ownerOrder.location.lng}&q=车旁路人位置`}
                          target="_blank"
                          rel="noreferrer"
                          className="bg-[#2D2A26] hover:opacity-90 text-white text-xs font-semibold py-2.5 rounded-xl text-center shadow-md transition duration-150"
                        >
                          苹果地图
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-white p-3 rounded-lg text-[11px] text-[#968F85] flex items-center gap-1.5 border border-[#EBE7DE]">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>{ownerOrder.locationStatus === "denied" ? "对方未授权定位" : "该申请人未共享精细定位"}</span>
                    </div>
                  )}
                </div>

                {/* Owner confirmation action */}
                <div className="space-y-4 pt-2">
                  {ownerConfirmedMessage ? (
                    <div className="bg-emerald-500/10 text-emerald-800 p-5 rounded-2xl text-center border border-emerald-500/20 space-y-2">
                      <CheckCircle className="w-8 h-8 text-emerald-600 mx-auto" />
                      <p className="text-sm font-bold">已成功回复等待路人！</p>
                      <p className="text-xs text-[#968F85] leading-relaxed">
                        您的响应状态已被二次写入 Redis 做永久备份，可随时随地通过本链接检索查验。
                      </p>
                    </div>
                  ) : (
                    <button
                      onClick={confirmMovingAction}
                      disabled={isOwnerSubmitting}
                      className="w-full bg-[#8C7851] hover:bg-[#736341] text-white font-bold py-4 rounded-2xl shadow-xl transition duration-150"
                    >
                      {isOwnerSubmitting ? (
                        <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto"></div>
                      ) : (
                        <span>我已知晓，正在前往</span>
                      )}
                    </button>
                  )}
                </div>
              </motion.div>
            )}

            {/* E. Error / Block states page */}
            {page === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-6 text-center space-y-4"
              >
                <div className="w-14 h-14 bg-amber-500/10 text-amber-600 rounded-full flex items-center justify-center mx-auto border border-amber-500/20">
                  <ShieldAlert className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="text-lg font-serif text-[#2D2A26] font-bold">操作受限</h2>
                  <p className="text-xs text-[#968F85] mt-2 max-w-xs mx-auto leading-relaxed">
                    {errorMessage || "数据交互暂时受阻，可能设备超过呼叫限额，请稍后刷新。"}
                  </p>
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => {
                      setPage("loading");
                      const params = new URLSearchParams(window.location.search);
                      const isOwnerRoute = window.location.pathname.startsWith("/owner-confirm") || params.has("id");
                      if (isOwnerRoute) {
                        const idFromUrl = params.get("id") || params.get("deviceId");
                        if (idFromUrl) fetchOwnerOrder(idFromUrl);
                      } else {
                        checkExistingOrderOnLoad(deviceId);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-[#8C7851] font-bold bg-[#FAF9F6] hover:bg-[#F1EDE4] border border-[#EBE7DE] px-4 py-2 rounded-xl transition cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>刷新页面重试</span>
                  </button>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </main>

      {/* Styled Footer Matching Theme */}
      <footer className="p-6 border-t border-[#EBE7DE] text-center bg-white max-w-xl mx-auto w-full">
        <div className="flex flex-col items-center gap-2">
          <p className="text-[11px] text-[#B8B2A9] tracking-widest uppercase font-serif">
            TENCENT CLOUD SERVERLESS &bull; REDIS DB v6.2.21
          </p>
          <p className="text-[10px] text-[#968F85] leading-relaxed">
            连接模式: {page === "owner" ? "车主确认终端" : "呼叫反馈盘面"} &bull; 指令已加密
          </p>
        </div>
      </footer>

    </div>
  );
}
