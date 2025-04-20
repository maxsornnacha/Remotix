import path from 'path';
const { mouse, keyboard, Button, Key, screen } = require('@nut-tree-fork/nut-js');
import { app, ipcMain, session, desktopCapturer } from 'electron';
import serve from 'electron-serve';
import { createWindow } from './helpers';

const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  serve({ directory: 'app' });
} else {
  app.setPath('userData', `${app.getPath('userData')} (development)`);
}

(async () => {
  await app.whenReady();

  // ✅ Electron screen/media permission handler
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: true }
  );

  // ✅ Create browser window
  const mainWindow = createWindow('main', {
    minWidth: 800,
    minHeight: 800,
    center: true,
    icon: path.join(__dirname, '..', 'resources', 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isProd) {
    await mainWindow.loadURL('app://./home');
  } else {
    const port = process.argv[2];
    await mainWindow.loadURL(`http://localhost:${port}/home`);
    // mainWindow.webContents.openDevTools();
  }
})();

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.on('message', async (event, arg) => {
  event.reply('message', `${arg} World!`);
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

ipcMain.on('remote-input', async (_event, { type, payload }) => {
  try {
      if (type === 'mouse-move') {
        const { x, y } = payload || {};
        if (typeof x === 'number' && typeof y === 'number') {
          const current = await mouse.getPosition();
          await mouse.setPosition({
            x: current.x + x,
            y: current.y + y,
          });
        } else {
          console.warn("current position :", await mouse.getPosition());
          console.warn('🟡 Invalid mouse-move payload:', payload);
        }
      }
    if (type === 'mouse-click') {
      mouse.click(Button.LEFT);
    }
    if (type === 'key-down') {
      const { code } = payload;
      const key = mapCodeToNutKey(code); // converts code to nut.js Key
      if (key) {
        await keyboard.pressKey(key);
      }
    }
    if (type === 'key-up') {
      const { code } = payload;
      const key = mapCodeToNutKey(code);
      if (key) {
        await keyboard.releaseKey(key);
      }
    }    
  } catch (err) {
    console.error('Input control error:', err);
  }
});