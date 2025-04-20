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
    width: 800,
    height: 800,
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
    mainWindow.webContents.openDevTools();
  }
})();

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.on('message', async (event, arg) => {
  event.reply('message', `${arg} World!`);
});


ipcMain.on('remote-input', (_event, { type, payload }) => {
  try {
    if (type === 'mouse-move') {
      mouse.setPosition({ x: payload.x, y: payload.y });
    }
    if (type === 'mouse-click') {
      mouse.click(Button.LEFT);
    }
    if (type === 'key-down') {
      keyboard.type(payload.key);
    }
  } catch (err) {
    console.error('Input control error:', err);
  }
});