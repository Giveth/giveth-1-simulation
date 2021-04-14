import {donationModel} from "../models/donations.model";
import {getLogger} from "../utils/logger";
import {report} from "../utils/reportUtils";
import {ObjectId} from "mongoose";
const logger = getLogger();


export const updateOneDonation = async (donationId:ObjectId , updatedData:any) =>{
  logger.error('Updating... donation', {
    donationId,
    updatedData
  });
  report.updatedDonations++;
  await donationModel.updateOne(
    {_id: donationId},
    {...updatedData,
      updatedBySimulationDate:new Date()},
    {timestamps: false}
  );
}