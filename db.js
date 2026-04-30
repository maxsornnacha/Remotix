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

const hostAuditEventSchema = new mongoose.Schema(
  {
    externalId: { type: String, default: '' },
    event: { type: String, required: true, index: true },
    requestId: { type: String, default: '', index: true },
    policyMode: { type: String, default: '' },
    clientDeviceId: { type: String, default: '', index: true },
    clientDisplayName: { type: String, default: '' },
    clientSocketId: { type: String, default: '' },
    reason: { type: String, default: '' },
    riskReasons: [{ type: String }],
    approved: { type: Boolean, default: null },
    roomId: { type: String, required: true, index: true },
    at: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: Date.now, index: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

hostAuditEventSchema.index({ roomId: 1, at: -1 });
hostAuditEventSchema.index({ requestId: 1 });
hostAuditEventSchema.index({ clientDeviceId: 1, at: -1 });
hostAuditEventSchema.index({ event: 1, at: -1 });

const HostAuditEvent =
  mongoose.models.HostAuditEvent ||
  mongoose.model('HostAuditEvent', hostAuditEventSchema);

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
  HostAuditEvent,
  connectDb,
  isDbConnected,
};
