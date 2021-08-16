import { Document, model, Schema, Types } from 'mongoose';

export const EventStatus = {
  PENDING: 'Pending', // PENDING events were p/u by the ws subscription, but have yet to contain >= requiredConfirmations
  WAITING: 'Waiting', // WAITING events have been p/u by polling, have >= requiredConfirmations, & are ready to process
  PROCESSING: 'Processing',
  PROCESSED: 'Processed',
  FAILED: 'Failed',
};

export interface EventMongooseDocument extends Document {
  event:string,
  signature:string,
  logIndex:number,
  raw:any,
  returnValues:{
    idGiver:string
    url:string
  },
  transactionHash:string,
}

const eventSchema = new Schema(
  {
    logIndex: { type: Number, required: true },
    transactionIndex: { type: Number, required: true },
    transactionHash: { type: String, required: true, index: true },
    blockHash: { type: String, required: true },
    blockNumber: { type: Number, required: true },
    address: { type: String, required: true },
    type: { type: String },
    id: { type: String, required: true },
    returnValues: { type: Object },
    event: { type: String, index: true },
    signature: { type: String },
    raw: { type: Object },
    topics: [String],
    status: {
      type: String,
      require: true,
      enum: Object.values(EventStatus),
      default: EventStatus.WAITING,
    },
    processingError: { type: String },
    confirmations: { type: Number, require: true },
  },
  {
    timestamps: true,
  },
);
export const eventModel = model<EventMongooseDocument>('event', eventSchema);
