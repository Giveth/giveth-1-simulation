import {Document, Model, model, Schema, Types} from 'mongoose';

import {DonationCounter, DonationCounterInterface} from './donationCounter.model';

export const CampaignStatus = {
    ACTIVE: 'Active',
    PENDING: 'Pending',
    CANCELED: 'Canceled',
    FAILED: 'Failed',
};

export interface CampaignMongooseDocument extends Document {
    title: string,
    status: string,
    tokenAddress:string,
    peopleCount:number,
    donationCounters: DonationCounterInterface[],

}

const campaign = new Schema(
    {
        title: {type: String, required: true},
        description: {type: String, required: true},
        projectId: {type: Number, index: true}, // we can use Long here b/c lp only stores adminId in pledges as uint64
        image: {type: String, required: true},
        prevImage: {type: String}, // To store deleted/cleared lost ipfs values
        txHash: {type: String, index: true, required: true},
        peopleCount: {type: Number},
        donationCounters: [DonationCounter],
        communities: {type: [String]},
        reviewerAddress: {type: String, required: true, index: true},
        ownerAddress: {type: String, required: true, index: true},
        coownerAddress: {type: String, required: false, index: true},
        fundsForwarder: {type: String, required: false, index: true},
        pluginAddress: {type: String},
        tokenAddress: {type: String},
        mined: {type: Boolean, required: true, default: false},
        status: {
            type: String,
            require: true,
            enum: Object.values(CampaignStatus),
            default: CampaignStatus.PENDING,
        },
        url: {type: String},
        customThanksMessage: {type: String},
        prevUrl: {type: String}, // To store deleted/cleared lost ipfs values
        commitTime: {type: Number},
        communityUrl: {type: String},
        archivedTraces: {type: [Number]},
        isRecovered:{type: Boolean}
    },
    {
        timestamps: true,
    },
);
export const campaignModel = model<CampaignMongooseDocument>('campaign', campaign);

