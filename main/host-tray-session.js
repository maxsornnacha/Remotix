import fs from "fs";
import { Tray, Menu, nativeImage, ipcMain, app, BrowserWindow } from "electron";

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
        label: "Show Remotix",
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
        label: "Quit Remotix",
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
    tray.setToolTip("Remotix — host session (menu: Show / Quit)");
    rebuildMenu();
    tray.on("double-click", () => {
      if (mainWindow.isDestroyed()) return;
      mainWindow.show();
      mainWindow.focus();
    });
  };

  const enterTrayMode = () => {
    if (mainWindow.isDestroyed()) return;
    state.traySession = true;
    ensureTray();
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
