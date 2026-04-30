import mongoose, { Schema } from 'mongoose';
const UserActivitySchema = new Schema({
    traderAddress: { type: String, required: true, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    conditionId: { type: String, index: true },
    type: { type: String },
    size: { type: Number },
    usdcSize: { type: Number },
    transactionHash: { type: String, index: true },
    price: { type: Number },
    asset: { type: String },
    side: { type: String },
    outcomeIndex: { type: Number },
    title: { type: String },
    slug: { type: String },
    icon: { type: String },
    eventSlug: { type: String },
    outcome: { type: String },
    name: { type: String },
    pseudonym: { type: String },
    bio: { type: String },
    profileImage: { type: String },
    profileImageOptimized: { type: String },
    bot: { type: Boolean, default: false },
    processedBy: [{ type: String }], // Array of chatIds who already processed this
    followerStatuses: { type: Schema.Types.Mixed, default: {} }, // map of { followerId: { status, error } }
    // Fields from IUserActivity
    action: { type: String },
    market: { type: String },
    amount: { type: Number },
    txHash: { type: String },
    details: { type: Schema.Types.Mixed },
}, { strict: false }); // Use strict: false to handle any other fields from Polymarket API
const UserPositionSchema = new Schema({
    traderAddress: { type: String, required: true, index: true },
    asset: { type: String, index: true },
    conditionId: { type: String, index: true },
    market: { type: String },
    side: { type: String, enum: ['LONG', 'SHORT'] },
    amount: { type: Number },
    entryPrice: { type: Number },
    lastPrice: { type: Number },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    pnl: { type: Number },
}, { strict: false });
const Activity = mongoose.model('UserActivity', UserActivitySchema);
const Position = mongoose.model('UserPosition', UserPositionSchema);
/**
 * Factory that returns a function for creating a new document,
 * with static model methods attached to it.
 */
const createDocumentFactory = (model, walletAddress) => {
    const factory = (data) => {
        const doc = new model({ ...data, traderAddress: walletAddress.toLowerCase() });
        return doc;
    };
    // Helper to inject traderAddress into queries
    const injectFilter = (query = {}) => {
        return { ...query, traderAddress: walletAddress.toLowerCase() };
    };
    // Attach static methods for compatibility
    Object.assign(factory, {
        find: (query = {}) => model.find(injectFilter(query)).lean(),
        findOne: (query = {}) => model.findOne(injectFilter(query)).lean(),
        findOneAndUpdate: (query, update, options = {}) => model.findOneAndUpdate(injectFilter(query), update, { ...options, new: true }).lean(),
        updateOne: (query, update, options = {}) => model.updateOne(injectFilter(query), update, options),
        updateMany: (query, update, options = {}) => model.updateMany(injectFilter(query), update, options),
        countDocuments: (query = {}) => model.countDocuments(injectFilter(query)),
    });
    return factory;
};
const getUserActivityModel = (walletAddress) => {
    return createDocumentFactory(Activity, walletAddress);
};
const getUserPositionModel = (walletAddress) => {
    return createDocumentFactory(Position, walletAddress);
};
export { getUserActivityModel, getUserPositionModel };
export { Activity, Position };
