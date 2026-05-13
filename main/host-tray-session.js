import fs from "fs";
import {
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  app,
  BrowserWindow,
  Notification,
} from "electron";

function trayLocationHint() {
  if (process.platform === "darwin") return "แถบเมนูด้านบน (menu bar)";
  if (process.platform === "win32") return "ทาสก์บาร์ มุมขวาล่าง (system tray)";
  return "ถาดระบบ (system tray)";
}

/** แจ้งครั้งเดียวตอนพับหน้าต่างไป tray — กัน user นึกว่าแอปหาย */
function notifyHostWindowFoldedToTray() {
  if (!Notification.isSupported()) return;
  try {
    const where = trayLocationHint();
    const body = `แอป Remotix ยังทำงานอยู่ — หน้าต่างถูกพับไปที่ไอคอนริมจอ (${where}) แล้ว คลิกไอคอนเพื่อเปิดเมนู หรือดับเบิลคลิกเพื่อเปิดหน้าต่าง / The app is still running; click the Remotix tray icon to open the menu or double-click to show the window.`;
    const n = new Notification({
      title: "Remotix — โหมดโฮสต์",
      body,
    });
    n.show();
  } catch (_e) {
    // ignore (e.g. notifications disabled in system settings)
  }
}

/** 1×1 PNG fallback when no app icon file is found (scaled by the OS for tray). */
const FALLBACK_TRAY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function trayImageFromPath(getIconPath) {
  const p = typeof getIconPath === "function" ? getIconPath() : "";
  if (p && fs.existsSync(p)) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        const edge = process.platform === "darwin" ? 22 : 16;
        if (typeof img.resize === "function") {
          return img.resize({ width: edge, height: edge });
        }
        return img;
      }
    } catch (_e) {
      // fall through
    }
  }
  return nativeImage.createFromBuffer(FALLBACK_TRAY_PNG);
}

/**
 * Host-only: hide the main window to the system tray while screen sharing is active,
 * so remote control is unobstructed. IPC from renderer: `host-session:tray-mode`.
 *
 * @param {import('electron').BrowserWindow} mainWindow
 * @param {() => string | undefined} getIconPath same resolver as window icon
 */
export function registerHostTraySession(mainWindow, getIconPath) {
  /** @type {Tray | null} */
  let tray = null;
  const state = { traySession: false, exiting: false };

  const destroyTray = () => {
    if (tray) {
      try {
        tray.destroy();
      } catch (_e) {
        // ignore
      }
      tray = null;
    }
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.show();
      } catch (_e) {
        // ignore
      }
    }
  };

  const rebuildMenu = () => {
    if (!tray) return;
    const template = [
      {
        label: "● Remotix — โฮสต์ (หน้าต่างอยู่ใน tray)",
        enabled: false,
      },
      {
        label: "หาไอคอนริมจอด้านบน/ขวาล่าง",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "เปิดหน้าต่าง / Show window",
        click: () => {
          if (mainWindow.isDestroyed()) return;
          mainWindow.show();
          mainWindow.focus();
          if (process.platform === "darwin" && app.dock) {
            try {
              app.dock.show();
            } catch (_e) {
              // ignore
            }
          }
        },
      },
      { type: "separator" },
      {
        label: "ออกจากโปรแกรม / Quit",
        click: () => {
          state.exiting = true;
          state.traySession = false;
          destroyTray();
          app.quit();
        },
      },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  const ensureTray = () => {
    if (tray) {
      rebuildMenu();
      return;
    }
    const image = trayImageFromPath(getIconPath);
    tray = new Tray(image);
    tray.setToolTip(
      `Remotix — โฮสต์ทำงานอยู่ (หน้าต่างพับใน tray แล้ว) · ${trayLocationHint()} · คลิก = เมนู · ดับเบิลคลิก = เปิดหน้าต่าง`,
    );
    rebuildMenu();
    tray.on("double-click", () => {
      if (mainWindow.isDestroyed()) return;
      mainWindow.show();
      mainWindow.focus();
    });
  };

  const enterTrayMode = () => {
    if (mainWindow.isDestroyed()) return;
    const alreadyInTraySession = state.traySession;
    state.traySession = true;
    ensureTray();
    if (!alreadyInTraySession) {
      notifyHostWindowFoldedToTray();
    }
    mainWindow.hide();
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.hide();
      } catch (_e) {
        // ignore
      }
    }
  };

  const leaveTrayMode = () => {
    state.traySession = false;
    destroyTray();
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  };

  ipcMain.handle("host-session:tray-mode", (event, payload = {}) => {
    if (state.exiting) return { ok: false, reason: "exiting" };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, reason: "no-window" };
    let senderWin = null;
    try {
      senderWin = BrowserWindow.fromWebContents(event.sender);
    } catch (_e) {
      return { ok: false, reason: "sender" };
    }
    if (senderWin !== mainWindow) return { ok: false, reason: "sender" };

    const enabled = Boolean(payload?.enabled);
    if (enabled) enterTrayMode();
    else leaveTrayMode();
    return { ok: true, enabled };
  });

  mainWindow.on("close", (e) => {
    if (state.exiting) return;
    if (!state.traySession) return;
    e.preventDefault();
    if (!mainWindow.isDestroyed()) mainWindow.hide();
  });

  app.on("before-quit", () => {
    state.exiting = true;
    destroyTray();
  });
}
