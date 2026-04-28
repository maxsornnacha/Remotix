const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

export const getRtcConfig = () => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]

  const turnUrl = toText(process.env.NEXT_PUBLIC_TURN_URL)
  const turnUsername = toText(process.env.NEXT_PUBLIC_TURN_USERNAME)
  const turnCredential = toText(process.env.NEXT_PUBLIC_TURN_CREDENTIAL)

  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    })
  }

  return {
    iceServers,
  }
}
