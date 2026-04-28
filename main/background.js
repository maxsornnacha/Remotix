import path from "path";
import fs from "fs";
const { mouse, keyboard, Button, Key } = require("@nut-tree-fork/nut-js");
import {
  app,
  ipcMain,
  session,
  desktopCapturer,
  systemPreferences,
  shell,
  screen,
} from "electron";
import serve from "electron-serve";
import { createWindow } from "./helpers";

const isProd = process.env.NODE_ENV === "production";
let preferredScreenSourceId = "";

if (process.platform === "darwin") {
  // Workaround for known macOS window capture black-frame regressions.
  app.commandLine.appendSwitch("disable-features", "WindowCaptureMacV2");
}

const resolveAppIconPath = () => {
  const macCandidates = [
    path.join(__dirname, "..", "resources", "icon.png"),
    path.join(__dirname, "..", "renderer", "public", "images", "logo.png"),
    path.join(__dirname, "..", "resources", "icon.icns"),
  ];
  const defaultCandidates = [
    path.join(__dirname, "..", "resources", "icon.png"),
    path.join(__dirname, "..", "resources", "icon.ico"),
    path.join(__dirname, "..", "resources", "icon.icns"),
    path.join(__dirname, "..", "renderer", "public", "images", "logo.png"),
  ];
  const candidates =
    process.platform === "darwin" ? macCandidates : defaultCandidates;

  return candidates.find((filePath) => fs.existsSync(filePath)) || undefined;
};

if (isProd) {
  serve({ directory: "app" });
} else {
  app.setPath("userData", `${app.getPath("userData")} (development)`);
}
app.setName("Remotix");

(async () => {
  await app.whenReady();
  const appIconPath = resolveAppIconPath();

  if (process.platform === "darwin" && appIconPath && app.dock) {
    try {
      app.dock.setIcon(appIconPath);
    } catch (error) {
      console.warn("[icon] Failed to set dock icon:", error.message);
    }
  }

  // Keep Electron display media flow available.
  // If system picker is available, Electron will use it.
  // Otherwise, fallback to the first full-screen source.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const primaryDisplayId = String(screen.getPrimaryDisplay()?.id || "");
        const screenSources = sources.filter((source) =>
          source.id.startsWith("screen:"),
        );
        const screenSource =
          screenSources.find((source) => source.id === preferredScreenSourceId) ||
          screenSources.find(
            (source) =>
              String(source.display_id || "").trim() === primaryDisplayId,
          ) || screenSources[0];
        if (!screenSource) {
          console.error("[display-media] no screen source available");
          callback({ video: null, audio: null });
          return;
        }
        console.log(
          "[display-media] available sources",
          screenSources.map((source) => ({
            id: source.id,
            name: source.name,
            displayId: source.display_id,
          })),
        );
        console.log("[display-media] selected source", {
          id: screenSource.id,
          name: screenSource.name,
          displayId: screenSource.display_id,
          primaryDisplayId,
        });
        callback({ video: screenSource, audio: "loopback" });
      } catch (error) {
        console.error("[display-media] failed to resolve source", error);
        callback({ video: null, audio: null });
      }
    },
    { useSystemPicker: false },
  );

  // ✅ Create browser window
  const mainWindow = createWindow("main", {
    minWidth: 800,
    minHeight: 800,
    center: true,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isProd) {
    await mainWindow.loadURL("app://./home");
  } else {
    const port = process.argv[2];
    await mainWindow.loadURL(`http://localhost:${port}/home`);
    // mainWindow.webContents.openDevTools();
  }
})();

app.on("window-all-closed", () => {
  app.quit();
});

const getPermissionStatus = () => {
  const isMac = process.platform === "darwin";
  if (!isMac) {
    return {
      platform: process.platform,
      allGranted: true,
      requirements: [],
    };
  }

  const screen = systemPreferences.getMediaAccessStatus("screen");
  const accessibilityGranted =
    systemPreferences.isTrustedAccessibilityClient(false);

  const requirements = [
    {
      key: "screen",
      label: "Screen Recording",
      status: screen,
      granted: screen === "granted",
    },
    {
      key: "accessibility",
      label: "Accessibility",
      status: accessibilityGranted ? "granted" : "denied",
      granted: accessibilityGranted,
    },
  ];

  return {
    platform: process.platform,
    allGranted: requirements.every((item) => item.granted),
    requirements,
  };
};

ipcMain.handle("permissions:status", () => {
  return getPermissionStatus();
});

ipcMain.handle("permissions:request", async (_event, payload = {}) => {
  const key = payload?.key;
  if (process.platform !== "darwin") {
    return getPermissionStatus();
  }

  if (key === "screen") {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }

  if (key === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  }

  return getPermissionStatus();
});

ipcMain.handle("desktop:screen-sources", async () => {
  const primaryDisplayId = String(screen.getPrimaryDisplay()?.id || "");
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 },
  });

  const normalized = sources
    .filter((source) => source.id.startsWith("screen:"))
    .map((source) => ({
      id: source.id,
      name: source.name,
      displayId: String(source.display_id || ""),
      thumbnail: source.thumbnail?.toDataURL?.() || "",
    }));

  return {
    primaryDisplayId,
    sources: normalized,
  };
});

ipcMain.handle("desktop:set-selected-source", async (_event, payload = {}) => {
  preferredScreenSourceId = String(payload?.sourceId || "").trim();
  return { ok: true, sourceId: preferredScreenSourceId };
});

ipcMain.on("message", async (event, arg) => {
  event.reply("message", `${arg} World!`);
});

function mapCodeToNutKey(code) {
  const map = {
    // Letters
    KeyA: Key.A,
    KeyB: Key.B,
    KeyC: Key.C,
    KeyD: Key.D,
    KeyE: Key.E,
    KeyF: Key.F,
    KeyG: Key.G,
    KeyH: Key.H,
    KeyI: Key.I,
    KeyJ: Key.J,
    KeyK: Key.K,
    KeyL: Key.L,
    KeyM: Key.M,
    KeyN: Key.N,
    KeyO: Key.O,
    KeyP: Key.P,
    KeyQ: Key.Q,
    KeyR: Key.R,
    KeyS: Key.S,
    KeyT: Key.T,
    KeyU: Key.U,
    KeyV: Key.V,
    KeyW: Key.W,
    KeyX: Key.X,
    KeyY: Key.Y,
    KeyZ: Key.Z,

    // Numbers
    Digit0: Key.Num0,
    Digit1: Key.Num1,
    Digit2: Key.Num2,
    Digit3: Key.Num3,
    Digit4: Key.Num4,
    Digit5: Key.Num5,
    Digit6: Key.Num6,
    Digit7: Key.Num7,
    Digit8: Key.Num8,
    Digit9: Key.Num9,

    // Navigation
    ArrowUp: Key.Up,
    ArrowDown: Key.Down,
    ArrowLeft: Key.Left,
    ArrowRight: Key.Right,

    // Control keys
    Enter: Key.Enter,
    Escape: Key.Escape,
    Backspace: Key.Backspace,
    Tab: Key.Tab,
    Space: Key.Space,

    // Modifiers
    ShiftLeft: Key.LeftShift,
    ShiftRight: Key.RightShift,
    ControlLeft: Key.LeftControl,
    ControlRight: Key.RightControl,
    AltLeft: Key.LeftAlt,
    AltRight: Key.RightAlt,
  };

  return map[code] || null;
}

ipcMain.on("remote-input", async (_event, { type, payload }) => {
  try {
    if (type === "mouse-move") {
      const { x, y } = payload || {};
      if (typeof x === "number" && typeof y === "number") {
        const current = await mouse.getPosition();
        await mouse.setPosition({
          x: current.x + x,
          y: current.y + y,
        });
      } else {
        console.warn("current position :", await mouse.getPosition());
        console.warn("🟡 Invalid mouse-move payload:", payload);
      }
    }
    if (type === "mouse-click") {
      mouse.click(Button.LEFT);
    }
    if (type === "key-down") {
      const { code } = payload;
      const key = mapCodeToNutKey(code); // converts code to nut.js Key
      if (key) {
        await keyboard.pressKey(key);
      }
    }
    if (type === "key-up") {
      const { code } = payload;
      const key = mapCodeToNutKey(code);
      if (key) {
        await keyboard.releaseKey(key);
      }
    }
    // เพิ่มเติมใน ipcMain.on('remote-input')
    if (type === "mouse-down") await mouse.pressButton(Button.LEFT);
    if (type === "mouse-up") await mouse.releaseButton(Button.LEFT);
    if (type === "mouse-scroll") {
      const { deltaX, deltaY } = payload;
      await mouse.scrollVertical(deltaY); // หรือ scrollHorizontal สำหรับแนวนอน
    }
  } catch (err) {
    console.error("Input control error:", err);
  }
});
