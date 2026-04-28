import "../style/global.css";
import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertContext } from "../libs/alerts";
import { api } from "../libs/http";

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "", stack: "" };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || "Unknown render error",
    };
  }

  componentDidCatch(error, info) {
    const stack = info?.componentStack || "";
    this.setState({ stack });
    // Keep details in devtools for pinpointing the offending component tree.
    console.error("Render error captured by AppErrorBoundary:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            background: "#0f172a",
            color: "#e2e8f0",
            padding: 24,
            fontFamily: "Inter, sans-serif",
          }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
            Remotix render error
          </h1>
          <p style={{ marginBottom: 12 }}>{this.state.message}</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              lineHeight: 1.4,
              background: "#020617",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: 12,
            }}>
            {this.state.stack || "No component stack available."}
          </pre>
          <p style={{ marginTop: 12, fontSize: 12, opacity: 0.8 }}>
            Hard refresh after copying this stack.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}

function ServiceUnavailablePage({ title, message, onRetry, isChecking }) {
  return (
    <div className="min-h-screen bg-[#0b1020] text-slate-100">
      <div className="h-11 border-b border-slate-700/80 bg-[#0f172a] px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="ml-2 text-lg font-medium tracking-wide text-slate-300">
            Remotix Desktop
          </h2>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded border border-red-400/40 bg-red-500/10 text-red-200">
          SERVICE BLOCKED
        </span>
      </div>

      <div className="grid grid-rows-[auto_1fr] min-h-[calc(100vh-44px)]">
        <section className="p-6 md:p-8">
          <p className="text-xs uppercase tracking-widest text-slate-400">
            Remotix Service Guard
          </p>
          <h1 className="mt-2 text-2xl md:text-3xl font-bold text-red-300">
            {title}
          </h1>
          <p className="mt-3 text-sm md:text-base text-slate-300 max-w-2xl">
            {message}
          </p>

          <div className="mt-7 rounded-xl border border-slate-700 bg-[#0b1324] p-4">
            <p className="text-xs text-slate-400 mb-3">Recovery Actions</p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onRetry}
                disabled={isChecking}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed">
                {isChecking ? "Checking..." : "Retry Connection"}
              </button>
              <span className="text-xs text-slate-400">
                Check server and database connection, then retry.
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ServiceGuard({ children }) {
  const [isChecking, setIsChecking] = useState(true);
  const [hasCheckedOnce, setHasCheckedOnce] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [reason, setReason] = useState({
    title: "Service unavailable",
    message: "Unable to verify service status.",
  });

  const checkServiceHealth = useCallback(async ({ foreground = false } = {}) => {
    if (typeof window === "undefined") return;
    if (foreground || !hasCheckedOnce) {
      setIsChecking(true);
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4500);

    try {
      const { data: payload } = await api.get("/status", { signal: controller.signal });

      if (payload?.dbConnected === false) {
        setIsUnavailable(true);
        setReason({
          title: "Cannot connect to database",
          message:
            "MongoDB is unavailable. Remote features are temporarily locked.",
        });
        return;
      }

      setIsUnavailable(false);
      setReason({
        title: "Service unavailable",
        message: "Unable to verify service status.",
      });
    } catch (error) {
      setIsUnavailable(true);
      const isTimeout = error?.name === "AbortError" || error?.code === "ERR_CANCELED";
      const statusCode = error?.response?.status;
      const serverMessage = error?.response?.data?.message;
      setReason({
        title: "Cannot connect to server",
        message: isTimeout
          ? "Server health check timed out. Please verify backend service and network."
          : serverMessage || (statusCode ? `Status API returned HTTP ${statusCode}.` : "Server is unreachable. Please start API server and try again."),
      });
    } finally {
      window.clearTimeout(timeout);
      setIsChecking(false);
      setHasCheckedOnce(true);
    }
  }, [hasCheckedOnce]);

  useEffect(() => {
    checkServiceHealth({ foreground: true });
  }, [checkServiceHealth]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const id = window.setInterval(() => {
      checkServiceHealth();
    }, 7000);
    return () => window.clearInterval(id);
  }, [checkServiceHealth]);

  const content = useMemo(() => {
    if (!hasCheckedOnce && isChecking && !isUnavailable) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">
          <p className="text-sm">Checking service status...</p>
        </div>
      );
    }
    if (isUnavailable) {
      return (
        <ServiceUnavailablePage
          title={reason.title}
          message={reason.message}
          isChecking={isChecking}
          onRetry={() => checkServiceHealth({ foreground: true })}
        />
      );
    }
    return children;
  }, [
    children,
    checkServiceHealth,
    hasCheckedOnce,
    isChecking,
    isUnavailable,
    reason.message,
    reason.title,
  ]);

  return content;
}

function AlertViewport({ alerts, onClose }) {
  const toneClasses = {
    error:
      "border-red-300/80 bg-red-50/90 text-red-900 shadow-red-500/10",
    success:
      "border-emerald-300/80 bg-emerald-50/90 text-emerald-900 shadow-emerald-500/10",
    info:
      "border-slate-300/80 bg-slate-50/90 text-slate-900 shadow-slate-500/10",
  };

  const iconByType = {
    error: "!",
    success: "✓",
    info: "i",
  };

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] flex w-[520px] max-w-[calc(100vw-2rem)] flex-col gap-2 pointer-events-none">
      {alerts.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto rounded-xl border backdrop-blur-sm shadow-xl px-4 py-3 animate-[toastIn_280ms_cubic-bezier(0.2,0.8,0.2,1)] ${
            toneClasses[item.type] || toneClasses.info
          }`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <span
                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                  item.type === "error"
                    ? "bg-red-100 text-red-700"
                    : item.type === "success"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-200 text-slate-700"
                }`}>
                {iconByType[item.type] || iconByType.info}
              </span>
              <p className="text-sm leading-snug font-medium">{item.message}</p>
            </div>
            <button
              type="button"
              onClick={() => onClose(item.id)}
              aria-label="Dismiss alert"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-black/10 text-xs hover:bg-black/5 transition-colors">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ToastAnimationStyle() {
  return (
    <style jsx global>{`
      @keyframes toastIn {
        0% {
          opacity: 0;
          transform: translateY(-14px) scale(0.98);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    `}</style>
  );
}

export default function MyApp({ Component, pageProps }) {
  const [alerts, setAlerts] = useState([]);

  const removeAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushAlert = useCallback((message, options = {}) => {
    const safeMessage =
      typeof message === "string" && message.trim()
        ? message.trim()
        : "Notification";
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const type = options.type || "info";
    setAlerts((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.message === safeMessage && Date.now() - last.createdAt < 1200) {
        return prev;
      }
      return [...prev, { id, message: safeMessage, type, createdAt: Date.now() }].slice(-4);
    });
    const timeoutMs = options.timeoutMs ?? 3800;
    window.setTimeout(() => removeAlert(id), timeoutMs);
  }, [removeAlert]);

  return (
    <AppErrorBoundary>
      <AlertContext.Provider value={{ pushAlert }}>
        <ServiceGuard>
          <Component {...pageProps} />
          <AlertViewport alerts={alerts} onClose={removeAlert} />
          <ToastAnimationStyle />
        </ServiceGuard>
      </AlertContext.Provider>
    </AppErrorBoundary>
  );
}
