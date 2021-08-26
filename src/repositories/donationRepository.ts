import {donationModel, DonationStatus} from "../models/donations.model";
import {getLogger} from "../utils/logger";
import {report} from "../utils/reportUtils";
import {ObjectId, Types} from "mongoose";
import {traceModel} from "../models/traces.model";
import {AdminTypes} from "../models/pledgeAdmins.model";
import {Logger} from "winston";

const logger: Logger = getLogger();

export const updateOneDonation = async (donationId: ObjectId, updatedData: any) => {
  logger.error('Updating... donation', {
    donationId,
    updatedData
  });
  report.updatedDonations++;
  await donationModel.updateOne(
    {_id: donationId},
    {
      ...updatedData,
      updatedBySimulationDate: new Date()
    },
    {timestamps: false}
  );
}


export const findDonationById = async (donationId) => {
  return donationModel.findOne({_id: Types.ObjectId(donationId)})
}

export const findCampaignChildDonation = async (donationId) => {
  return donationModel.findOne({
    ownerType: AdminTypes.CAMPAIGN,
    status: DonationStatus.COMMITTED,
    parentDonations: donationId
  })
}

const findParentDonation = (parentDonations) => {
  if (parentDonations.length === 0) {
    return undefined;
  }
  return donationModel.findOne({_id: Types.ObjectId(parentDonations[0])});
};

export const isDonationBackToCampaignFromTrace = async (donation) => {
  // it happens when recipient of trace is campaign, delegate from campaign to trace
  // after withdrawal money go back to campaign pledge
  if (donation.ownerType !== AdminTypes.CAMPAIGN ||
    donation.status !== DonationStatus.COMMITTED) {
    return false;
  }
  const parentDonation = await findParentDonation(donation.parentDonations);
  if (!parentDonation ||
    parentDonation.status !== DonationStatus.PAID ||
    parentDonation.ownerType !== AdminTypes.TRACE) {
    return false;
  }
  const grandParentDonation = await findParentDonation(donation.parentDonations);
  return Boolean(grandParentDonation &&
    grandParentDonation.ownerType !== AdminTypes.CAMPAIGN &&
    grandParentDonation.ownerTypeId !== donation.ownerTypeId)

}
