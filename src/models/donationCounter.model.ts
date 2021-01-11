import {Document, model, Schema, Types} from "mongoose";
import {stringify} from "querystring";
export interface DonationCounterInterface {
  name: string,
  address: string,
  decimals: string,
  symbol:string,
  totalDonated: string,
  currentBalance: string,
  donationCount: number,
}

export const DonationCounter = new Schema({
  name: { type: String, required: true },
  address: { type: String, required: true },
  decimals: { type: String, required: true },
  symbol: { type: String, required: true },
  totalDonated: { type: String, min: 0 },
  currentBalance: { type: String, min: 0 },
  donationCount: { type: Number },
});


