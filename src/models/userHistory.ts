import mongoose, { Schema, Document, Model } from 'mongoose';

// Interface for User Activity
export interface IUserActivity extends Document {
    traderAddress: string;
    action: string;
    market: string;
    amount: number;
    price: number;
    timestamp: Date;
    txHash?: string;
    details?: any;
    // Multi-user tracking
    processedBy: string[];
    followerStatuses?: Record<string, { status: string; details?: string }>;
    // Compatibility fields
    bot?: boolean;
    botExcutedTime?: number;
    usdcSize?: number;
    transactionHash?: string;
    side?: string;
    title?: string;
    slug?: string;
    asset?: string;
}

const UserActivitySchema: Schema = new Schema({
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

// Interface for User Position
export interface IUserPosition extends Document {
    traderAddress: string;
    market: string;
    side: 'LONG' | 'SHORT';
    amount: number;
    entryPrice: number;
    lastPrice: number;
    status: 'OPEN' | 'CLOSED';
    openedAt: Date;
    closedAt?: Date;
    pnl?: number;
    // Polymarket compatibility
    asset?: string;
    conditionId?: string;
    currentValue?: number;
    percentPnl?: number;
}

const UserPositionSchema: Schema = new Schema({
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

const Activity = mongoose.model<IUserActivity>('UserActivity', UserActivitySchema);
const Position = mongoose.model<IUserPosition>('UserPosition', UserPositionSchema);

/**
 * Factory that returns a function for creating a new document,
 * with static model methods attached to it.
 */
const createDocumentFactory = (model: Model<any>, walletAddress: string) => {
    const factory = (data: any) => {
        const doc = new model({ ...data, traderAddress: walletAddress.toLowerCase() });
        return doc;
    };

    // Helper to inject traderAddress into queries
    const injectFilter = (query: any = {}) => {
        return { ...query, traderAddress: walletAddress.toLowerCase() };
    };

    // Attach static methods for compatibility
    Object.assign(factory, {
        find: (query: any = {}) => model.find(injectFilter(query)).lean(),
        findOne: (query: any = {}) => model.findOne(injectFilter(query)).lean(),
        findOneAndUpdate: (query: any, update: any, options: any = {}) => 
            model.findOneAndUpdate(injectFilter(query), update, { ...options, new: true }).lean(),
        updateOne: (query: any, update: any, options: any = {}) => 
            model.updateOne(injectFilter(query), update, options),
        updateMany: (query: any, update: any, options: any = {}) => 
            model.updateMany(injectFilter(query), update, options),
        countDocuments: (query: any = {}) => model.countDocuments(injectFilter(query)),
    });

    return factory as any;
};

const getUserActivityModel = (walletAddress: string) => {
    return createDocumentFactory(Activity, walletAddress);
};

const getUserPositionModel = (walletAddress: string) => {
    return createDocumentFactory(Position, walletAddress);
};

export { getUserActivityModel, getUserPositionModel };
export { Activity, Position };
