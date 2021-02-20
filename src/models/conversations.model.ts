import {Document, model, Schema, Types} from 'mongoose';

export interface ConversationMongooseDocument extends Document {
  milestoneId:string,
  donationId: string,
  messageContext:string
}
const conversationSchema = new Schema(
  {
    milestoneId: {type: String, required: true},
    messageContext: {type: String, required: true},
    message: {type: String},
    replyToId: {type: String},
    performedByRole: {type: String, required: true},
    ownerAddress: {type: String, required: true},
    recipientAddress: {type: String},
    payments: [
      {
        amount: {type: String},
        symbol: {type: String},
        tokenDecimals: {type: String},
      },
    ],
    donorType: {type: String},
    donorId: {type: String},

    // this is for payment conversations
    donationId: {type: String},
    items: {type:Array},
    txHash: {type: String},
    mined: {type: Boolean, default: false},
  },
  {
    timestamps: true,
  },
);


export const conversationModel = model<ConversationMongooseDocument>('conversations', conversationSchema);
