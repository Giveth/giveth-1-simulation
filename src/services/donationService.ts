import {donationModel, DonationStatus} from "../models/donations.model";
import BigNumber from "bignumber.js";
import {DonationObjectInterface, ExtendedDonation, PledgeInterface, ReportInterface} from "../utils/interfaces";
import {getTokenByAddress, getTokenCutoff} from "../utils/tokenUtility";
import {getLogger} from "../utils/logger";

const logger = getLogger();

export async function fetchDonationsInfo():
  Promise<{
    pledgeNotUsedDonationListMap: any,
    donationMap: DonationObjectInterface
  }> {
  const pledgeNotUsedDonationListMap = {}
  const donationMap: DonationObjectInterface = {};

  // TODO: pendingAmountRemaining is not considered in updating, it should be removed for successful transactions

  await donationModel.find({}).cursor().eachAsync(
    async ({
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
    })=>{

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
      intendedProjectId:String(intendedProjectId),
      giverAddress,
      pledgeId: pledgeId.toString(),
      tokenAddress,
      isReturn,
      usdValue,
      createdAt,
    };

    list.push(item);
    donationMap[_id.toString()] = item as unknown as ExtendedDonation;
  }
  );
  return {
    donationMap,
    pledgeNotUsedDonationListMap
  }
}


export async function unsetPendingAmountRemainingFromCommittedDonations(options:{
  report :ReportInterface
}){
  const {report} = options;
  const query =  {status :{$ne: DonationStatus.PENDING},
    pendingAmountRemaining :{$exists :true}};
  const committedDonationsWithPendingAmountRemaining =await donationModel.find(query);
  report.removedPendingAmountRemainingCount = committedDonationsWithPendingAmountRemaining.length;
  console.log('Removed pendingAmountFromDonations count', committedDonationsWithPendingAmountRemaining.length)
  committedDonationsWithPendingAmountRemaining.forEach(donation =>{
    logger.error('Remove pendingAmountFromDonations',{
      _id:donation._id,
      pendingAmountRemaining :donation.pendingAmountRemaining
    })
  })
  await donationModel.updateMany(query,{$unset:{pendingAmountRemaining:1}} )


}

export async function fixConflictInDonations(
  options: {
    unusedDonationMap: Map<string, any>,
    donationMap: DonationObjectInterface,
    fixConflicts:boolean,
    report:ReportInterface,
    pledges: PledgeInterface[]
  }) {
  const {unusedDonationMap,fixConflicts,
    donationMap, pledges, report} = options;
  const promises = [];
  Object.values(donationMap).forEach(
    ({
       _id,
       amount,
       amountRemaining,
       savedAmountRemaining,
       status,
       savedStatus,
       pledgeId,
       txHash,
       tokenAddress,
     }) => {
      if (status === DonationStatus.FAILED) return;

      const pledge: PledgeInterface = pledges[Number(pledgeId)] || <PledgeInterface>{};

      if (unusedDonationMap.has(_id.toString())) {
        logger.error(
          `Donation was unused!\n${JSON.stringify(
            {
              _id,
              amount: amount.toString(),
              amountRemaining,
              status,
              pledgeId: pledgeId.toString(),
              pledgeOwner: pledge.owner,
              txHash,
            },
            null,
            2,
          )}`,
        );
        if (fixConflicts) {
          logger.debug('Deleting...');
          report.deletedDonations ++;
          promises.push(donationModel.findOneAndDelete({_id}));

        }
      } else {
        if (savedAmountRemaining && amountRemaining !== savedAmountRemaining) {
          logger.error(
            `Below donation should have remaining amount ${amountRemaining} but has ${savedAmountRemaining}\n${JSON.stringify(
              {
                _id,
                amount,
                amountRemaining,
                status,
                pledgeId,
                txHash,
              },
              null,
              2,
            )}`,
          );
          if (Number(pledgeId) !== 0) {
            logger.info(`Pledge Amount: ${pledge.amount}`);
          }
          if (fixConflicts) {
            const token = getTokenByAddress(tokenAddress);
            const tokenCutoff = token && getTokenCutoff(token.symbol);
            if(token && tokenCutoff && tokenCutoff.cutoff){
              promises.push(
                donationModel.updateOne(
                  {_id},
                  {
                    $set: {
                      amountRemaining,
                      lessThanCutoff: tokenCutoff.cutoff.gt(amountRemaining),
                    },
                  },
                ),
              );
            }

          }
        }

        if (savedStatus !== status) {
          logger.error(
            `Below donation status should be ${status} but is ${savedStatus}\n${JSON.stringify(
              {
                _id,
                amount: amount.toString(),
                amountRemaining,
                status,
                pledgeId: pledgeId.toString(),
                txHash,
              },
              null,
              2,
            )}`,
          );
          if (fixConflicts) {
            logger.debug('Updating...');
            promises.push(donationModel.updateOne({_id}, {status}));
          }
        }
      }
    },
  );
  return Promise.all(promises);
}