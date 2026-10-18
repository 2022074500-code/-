"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

import { AccountGate } from "@/components/auth/account-gate";
import { CloudBackupScheduler } from "@/components/cloud-backup-scheduler";
import { RealityBridgeScheduler } from "@/components/reality-bridge-scheduler";
import { MediaMaintenanceScheduler } from "@/components/media-maintenance-scheduler";
import { DesktopShell } from "./desktop-shell";
import { OfflinePushRevampAnnouncement } from "./offline-push-revamp-announcement";
import { SplashAnimation } from "./splash-animation";
import { MusicProvider } from "@/lib/music-context";
import { hydrateKvDb, isKvHydrated } from "@/lib/kv-db";
import { collectFirstPaintThemeAssetIds, getThemeAssetMap, readThemeProfile } from "@/lib/theme-storage";
import type { ThemeProfile } from "@/lib/theme-types";
import { hasPendingMcpOAuthCallback } from "@/lib/tool-executor";
import { shouldRequestPwaFullscreen } from "@/lib/pwa-display-mode";

const TEXT = {
  loading: "\u52A0\u8F7D\u4E2D...",
};

/**
 * 开机首屏必需的本地字体（开机动画 SplashAnimation 画布用到的三档）。
 * 只预热这几条：全量内置字体无差别预热会和桌面首帧抢带宽/解码，反而变成运行中卡顿；
 * 其余字体（访谈/便签墙/游戏大厅等）按 @font-face 的 font-display:swap 用到再加载。
 */
const FIRST_PAINT_FONT_SPECS = [
  '300 1em "Inter"',
  // 桌面默认字体栈 DEFAULT_FONT_FAMILY 里含 "Inter"：没有 PingFang/Noto Sans SC 的设备首屏正文走它的 400 档。
  '400 1em "Inter"',
  'italic 400 1em "Instrument Serif"',
  '300 1em "JetBrains Mono"',
] as const;

/** 字体预热上限：到点放行，不让慢网络/坏字体把开机拖住。 */
const FONT_WARMUP_TIMEOUT_MS = 1500;

/** 必须与 desktop-shell 注入的 @font-face 家族名、style 节点 id 保持一致，否则预热不生效。 */
const THEME_USER_FONT_FAMILY = "AIVirtualPhoneUserFont";
const THEME_FONT_STYLE_ID = "ai-phone-theme-font-face";

function withTimeout(task: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    task.catch(() => undefined).finally(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 预热首屏字体（本地 woff2）：只加载 FIRST_PAINT_FONT_SPECS，整体 1.5 秒封顶到点放行。
 * 与 KV 水合互不依赖，可以并行跑。
 */
function warmFirstPaintFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  const task = Promise.all(
    FIRST_PAINT_FONT_SPECS.map((spec) => document.fonts.load(spec).catch(() => []))
  );
  return withTimeout(task, FONT_WARMUP_TIMEOUT_MS);
}

/**
 * 预热主题自带（用户上传）字体：提前注入与 desktop-shell 完全同名的 @font-face
 * （家族名 AIVirtualPhoneUserFont、同一个 style 节点），并等它解码完成（同样封顶）。
 * desktop-shell 挂载后会写入同样的内容，不会产生第二份字体。
 */
function warmThemeUserFont(fontDataUrl: string | undefined): Promise<void> {
  if (!fontDataUrl || typeof document === "undefined" || !document.fonts) return Promise.resolve();
  let node = document.getElementById(THEME_FONT_STYLE_ID) as HTMLStyleElement | null;
  if (!node) {
    node = document.createElement("style");
    node.id = THEME_FONT_STYLE_ID;
    document.head.append(node);
  }
  node.textContent = `@font-face{font-family:"${THEME_USER_FONT_FAMILY}";src:url("${fontDataUrl}");font-display:swap;}`;
  return withTimeout(document.fonts.load(`400 1em "${THEME_USER_FONT_FAMILY}"`), FONT_WARMUP_TIMEOUT_MS);
}

function SplashScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
  return (
    <main className="app-root splash-root">
      <section
        className="phone-shell-wrap splash-shell-wrap"
        aria-label={TEXT.loading}
      >
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen">
              <SplashAnimation />
              <button
                type="button"
                className={ready ? "splash-enter-button splash-enter-button-show" : "splash-enter-button"}
                onClick={onEnter}
                disabled={!ready}
                aria-label="Enter"
              >
                <ArrowRight size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

type PreparedDesktopTheme = {
  profile: ThemeProfile;
  assets: Record<string, string>;
};

function preloadImageDataUrl(url: string): Promise<void> {
  if (typeof window === "undefined" || !url.startsWith("data:image/")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (typeof image.decode === "function") {
        void image.decode().catch(() => undefined).finally(resolve);
        return;
      }
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) {
      finish();
    }
  });
}

async function prepareDesktopThemeForFirstPaint(): Promise<PreparedDesktopTheme> {
  const profile = readThemeProfile();
  const assetIds = collectFirstPaintThemeAssetIds(profile);
  const assets = assetIds.length ? await getThemeAssetMap(assetIds) : {};
  const fontDataUrl = profile.fontAssetId ? assets[profile.fontAssetId] : undefined;
  await Promise.all([
    ...Object.values(assets).map(preloadImageDataUrl),
    warmThemeUserFont(fontDataUrl),
  ]);
  return { profile, assets };
}

export function MainApp() {
  const [preparedDesktopTheme, setPreparedDesktopTheme] = useState<PreparedDesktopTheme | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [kvHydrateFailed, setKvHydrateFailed] = useState(false);
  const [initAttempt, setInitAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // 申请持久化存储：批准后 iOS/安卓不会再因存储压力擅自回收 IndexedDB
    // （摊主钥匙、聊天记录等都存在里面）。静默尽力而为，被拒也无碍。
    void navigator.storage?.persist?.().catch(() => {});

    // 首屏字体预热与 KV 水合互不依赖，并行起跑（自带 1.5s 上限）。
    const fontWarmupTask = warmFirstPaintFonts();

    void (async () => {
      // 主题准备读的是 KV 内存缓存，必须等水合完成后再做，不能与水合并行。
      await hydrateKvDb();
      if (cancelled) return;
      // 水合失败绝不放行：此时所有 KV 数据（设置/绑定/线下记录等）在内存里都是
      // 空的，进入后任何一次保存都会拿空数据整包覆盖 IndexedDB 里的真实历史。
      if (!isKvHydrated()) {
        setKvHydrateFailed(true);
        return;
      }
      setKvHydrateFailed(false);

      let nextPreparedTheme: PreparedDesktopTheme | null = null;
      try {
        nextPreparedTheme = await prepareDesktopThemeForFirstPaint();
      } catch (error) {
        console.warn("[MainApp] desktop theme preload failed:", error);
      }

      // 放行前等首屏字体就位（或到 1.5s 上限），避免进桌面后字体到位引起整页重排。
      await fontWarmupTask;

      if (cancelled) return;
      setPreparedDesktopTheme(nextPreparedTheme);
      setHydrated(true);
      if (hasPendingMcpOAuthCallback()) {
        setSplashDismissed(true);
      }
    })();

    // 安卓全屏兜底。是否请求全屏在每次点击时读取，设置切换后无需重载。
    const isMobile = window.matchMedia("(max-width: 500px) and (hover: none) and (pointer: coarse)").matches;
    if (!isMobile) return () => {
      cancelled = true;
    };

    function tryFullscreen() {
      if (!shouldRequestPwaFullscreen()) return;
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      doc.requestFullscreen?.().catch(() => { });
    }
    document.addEventListener("click", tryFullscreen);
    return () => {
      cancelled = true;
      document.removeEventListener("click", tryFullscreen);
    };
  }, [initAttempt]);

  if (kvHydrateFailed) {
    return (
      <main className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", padding: "0 28px", background: "#0c0c12", color: "#e8e8ef" }}>
        <div style={{ maxWidth: 340, textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>本机数据暂时读取失败</div>
          <div style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.75, marginBottom: 20 }}>
            浏览器的本地数据库（IndexedDB）没能打开。数据本身还在，为了避免在读不到数据的状态下继续使用把历史记录覆盖掉，应用先暂停进入。
            <br />可以先重试；仍然不行的话，试试关掉本站的其他标签页、重启浏览器，或确认没有开无痕/隐私模式。
          </div>
          <button
            type="button"
            onClick={() => { setKvHydrateFailed(false); setInitAttempt((n) => n + 1); }}
            style={{ padding: "10px 32px", borderRadius: 20, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </main>
    );
  }

  return (
    <AccountGate>
      {!splashDismissed ? (
        <SplashScreen ready={hydrated} onEnter={() => setSplashDismissed(true)} />
      ) : (
        <main className="app-root">
          <MusicProvider>
            <DesktopShell
              initialThemeProfile={preparedDesktopTheme?.profile}
              initialThemeAssets={preparedDesktopTheme?.assets}
            />
            <OfflinePushRevampAnnouncement />
            <CloudBackupScheduler />
            <RealityBridgeScheduler />
            <MediaMaintenanceScheduler />
          </MusicProvider>
        </main>
      )}
    </AccountGate>
  );
}
