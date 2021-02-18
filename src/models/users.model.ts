import { Document, model, Schema, Types } from 'mongoose';




export interface UserMongooseDocument extends Document {
  address:string,
  giverId:string,
  name:string,
  url:string,

}

const userSchema = new Schema(
  {
    address: { type: String, required: true, unique: true },
    name: { type: String },
    email: { type: String },
    giverId: { type: String, index: true }, // we can use Long here b/c lp only stores adminId in pledges as uint64
    commitTime: { type: Number },
    avatar: { type: String },
    prevAvatar: { type: String }, // To store deleted/cleared lost ipfs values
    linkedin: { type: String },
    url: { type: String },
    prevUrl: { type: String }, // To store deleted/cleared lost ipfs values
    currency: { type: String }, // Users's native currency
  },
  {
    timestamps: true,
  },
);
export const userModel = model<UserMongooseDocument>('user', userSchema);
