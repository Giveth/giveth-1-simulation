import { Document, model, Schema, Types } from 'mongoose';

import {DonationCounter, DonationCounterInterface} from './donationCounter.model';

export const CommunityStatus = {
  ACTIVE: 'Active',
  PENDING: 'Pending',
  CANCELED: 'Canceled',
  FAILED: 'Failed',
};

export interface CommunityMongooseDocument extends Document {
  status:string,
  donationCounters: DonationCounterInterface[],
  tokenAddress:string,
  peopleCount:number,

}

const community = new Schema(
  // TODO note: the following commenting out of required is b/c
  // if a community is added to lp not from the dapp, we can't
  // guarantee that those fields are present until we have
  // ipfs enabled
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    communityUrl: { type: String },
    // FIXME: Should be unique but since we are using 0 for new Communities there can be more than one pending... Should instead be undefined
    delegateId: { type: Number }, // we can use Long here b/c lp only stores adminId in pledges as uint64
    status: {
      type: String,
      require: true,
      enum: Object.values(CommunityStatus),
      default: CommunityStatus.PENDING,
    },
    image: { type: String },
    prevImage: { type: String }, // To store deleted/cleared lost ipfs values
    txHash: { type: String, required: true },
    donationCounters: [DonationCounter],
    peopleCount: { type: Number },
    ownerAddress: { type: String, required: true },
    pluginAddress: { type: String },
    tokenAddress: { type: String },
    commitTime: { type: Number },
    mined: { type: Boolean },
    url: { type: String },
    customThanksMessage: { type: String },
    prevUrl: { type: String }, // To store deleted/cleared lost ipfs values
    isRecovered:{type: Boolean}

  },
  {
    timestamps: true,
  },
);
export const communityModel = model<CommunityMongooseDocument>('community', community);
