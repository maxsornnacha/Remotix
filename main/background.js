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