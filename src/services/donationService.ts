import {donationModel} from "../models/donations.model";
import BigNumber from "bignumber.js";
import {DonationObjectInterface, extendedDonation} from "../utils/interfaces";

export async function fetchDonationsInfo():
  Promise<{ pledgeNotUsedDonationListMap: any,
    donationMap: DonationObjectInterface }> {
  const pledgeNotUsedDonationListMap = {}
  const donationMap: DonationObjectInterface = {};

  // TODO: pendingAmountRemaining is not considered in updating, it should be removed for successful transactions

  const donations = await donationModel.find({});
  for (const donation of donations) {
    const {
      _id,
      amount,
      amountRemaining,
      pledgeId,
      status,
      mined,
      txHash,
      parentDonations,
      ownerId,
      ownerType,
      ownerTypeId,
      intendedProjectId,
      giverAddress,
      tokenAddress,
      isReturn,
      usdValue,
      createdAt,
    } = donation;

    const list = pledgeNotUsedDonationListMap[pledgeId.toString()] || [];
    if (list.length === 0) {
      pledgeNotUsedDonationListMap[pledgeId.toString()] = list;
    }

    const item = {
      _id: _id.toString(),
      amount: amount.toString(),
      savedAmountRemaining: amountRemaining.toString(),
      amountRemaining: new BigNumber(0),
      txHash,
      status,
      savedStatus: status,
      mined,
      parentDonations: parentDonations.map(id => id.toString()),
      ownerId,
      ownerType,
      ownerTypeId,
      intendedProjectId,
      giverAddress,
      pledgeId: pledgeId.toString(),
      tokenAddress,
      isReturn,
      usdValue,
      createdAt,
    };

    list.push(item);
    donationMap[_id.toString()] = item as unknown as extendedDonation;
  }
  return {
    donationMap,
    pledgeNotUsedDonationListMap
  }
}
