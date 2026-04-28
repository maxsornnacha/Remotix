import { v4 as uuidv4 } from 'uuid'

const DEVICE_KEY = 'remotix-device-profile'
const DEVICE_ID_LENGTH = 32
const createDeviceId = () => uuidv4().replace(/-/g, '').slice(0, DEVICE_ID_LENGTH)

export const getOrCreateDeviceProfile = () => {
  if (typeof window === 'undefined') {
    return { deviceId: '', displayName: '' }
  }

  const saved = window.localStorage.getItem(DEVICE_KEY)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      if (parsed?.deviceId) return parsed
    } catch (error) {
      // ignore invalid payload
    }
  }

  const profile = {
    deviceId: createDeviceId(),
    displayName: `My Device ${Math.floor(Math.random() * 900 + 100)}`,
  }
  window.localStorage.setItem(DEVICE_KEY, JSON.stringify(profile))
  return profile
}

export const saveDeviceProfile = (profile) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(DEVICE_KEY, JSON.stringify(profile))
}

export const regenerateDeviceProfile = (currentDisplayName = '') => {
  if (typeof window === 'undefined') {
    return { deviceId: '', displayName: '' }
  }

  const profile = {
    deviceId: createDeviceId(),
    displayName: currentDisplayName || `My Device ${Math.floor(Math.random() * 900 + 100)}`,
  }
  window.localStorage.setItem(DEVICE_KEY, JSON.stringify(profile))
  return profile
}
