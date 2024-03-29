import {Document, model, Schema, Types} from "mongoose";

import {DonationCounter, DonationCounterInterface} from './donationCounter.model';

// milestones-model.js - A mongoose model
//
// See http://mongoosejs.com/docs/models.html
// for more of what you can do here.
export const TraceStatus = {
  PROPOSED: 'Proposed',
  REJECTED: 'Rejected',
  PENDING: 'Pending',
  IN_PROGRESS: 'InProgress',
  NEEDS_REVIEW: 'NeedsReview',
  COMPLETED: 'Completed',
  CANCELED: 'Canceled',
  PAYING: 'Paying',
  PAID: 'Paid',
  FAILED: 'Failed',
  ARCHIVED: 'Archived',
};

export const TraceTypes = {
  LPPCappedMilestone: 'LPPCappedMilestone',
  BridgedMilestone: 'BridgedMilestone',
  LPMilestone: 'LPMilestone',
};


export interface TraceMongooseDocument extends  Document {
  title:string,
  status:string,
  projectId:number,
  reviewerAddress:string,
  maxAmount:string,
  fullyFunded:boolean,
  tokenAddress:string,
  recipientId ?:number,
  donationCounters: DonationCounterInterface [],

}

const trace = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    image: { type: String },
    prevImage: { type: String }, // To store deleted/cleared lost ipfs values
    maxAmount: { type: String },
    ownerAddress: { type: String, required: true },
    reviewerAddress: { type: String },
    communityId: { type: Number },
    recipientAddress: { type: String },
    recipientId: { type: Number}, // we can use Long here b/c lp only stores adminId in pledges as uint64
    pendingRecipientAddress: { type: String },
    campaignReviewerAddress: { type: String },
    campaignId: { type: String, required: true },
    projectId: { type: Number}, // we can use Long here b/c lp only stores adminId in pledges as uint64
    status: {
      type: String,
      require: true,
      enum: Object.values(TraceStatus),
    },
    conversionRateTimestamp: { type: Date },
    selectedFiatType: { type: String },
    date: { type: Date, required: true },
    fiatAmount: { type: Number },
    conversionRate: { type: Number },
    txHash: { type: String },
    pluginAddress: { type: String },
    fullyFunded: { type: Boolean, default: false },
    donationCounters: [DonationCounter],
    peopleCount: { type: Number },
    mined: { type: Boolean, required: true, default: false },
    prevStatus: { type: String },
    url: { type: String },
    customThanksMessage: { type: String },
    prevUrl: { type: String }, // To store deleted/cleared lost ipfs values
    type: {
      type: String,
      required: true,
      enum: Object.values(TraceTypes),
    },

    // these 2 fields should not be stored in mongo
    // but we need them for temporary storage
    // as mongoose virtuals do not persist in after hooks
    message: { type: String },
    messageContext: { type: String },
    tokenAddress: { type: String, required: true },
    projectAddedAt: { type: Date }, // Store the time trace is accepted or added by campaign owner
    isRecovered:{type: Boolean}
  },
  {
    timestamps: true,
  },
);


export const traceModel =  model<TraceMongooseDocument>('trace', trace);


