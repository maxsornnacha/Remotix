const mongoose = require('mongoose');

const pairSchema = new mongoose.Schema(
  {
    ownerDeviceId: { type: String, required: true, index: true },
    ownerLabel: { type: String, default: '' },
    peerDeviceId: { type: String, required: true, index: true },
    peerLabel: { type: String, default: '' },
    lastRoomId: { type: String, default: '' },
    lastConnectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

pairSchema.index({ ownerDeviceId: 1, peerDeviceId: 1 }, { unique: true });

const Pairing = mongoose.models.Pairing || mongoose.model('Pairing', pairSchema);

const deviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, default: '' },
    isOnline: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);

const resumeTokenSchema = new mongoose.Schema(
  {
    tokenId: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ['host', 'client'], required: true },
    roomId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    targetHostDeviceId: { type: String, default: '' },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    isConsumed: { type: Boolean, default: false },
    isRevoked: { type: Boolean, default: false },
    status: { type: String, default: '' },
  },
  { timestamps: true, strict: false },
);

const ResumeToken =
  mongoose.models.ResumeToken || mongoose.model('ResumeToken', resumeTokenSchema);

const connectDb = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('MONGODB_URI is not configured. Pairing persistence disabled.');
    return false;
  }

  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected');
    return true;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    return false;
  }
};

const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = {
  Pairing,
  Device,
  ResumeToken,
  connectDb,
  isDbConnected,
};
