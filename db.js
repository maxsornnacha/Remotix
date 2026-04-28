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
  connectDb,
  isDbConnected,
};
