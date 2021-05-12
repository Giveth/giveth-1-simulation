import {donationModel, DonationMongooseDocument, DonationStatus} from "../models/donations.model";
import BigNumber from "bignumber.js";
import {DonationObjectInterface, ExtendedDonation, PledgeInterface, ReportInterface} from "../utils/interfaces";
import {getTokenByAddress, getTokenCutoff} from "../utils/tokenUtility";
import {getLogger} from "../utils/logger";
import {conversationModel} from "../models/conversations.model";
import {updateOneDonation} from "../repositories/donationRepository";
import {report} from "../utils/reportUtils";

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
           }) => {

      const list = pledgeNotUsedDonationListMap[pledgeId.toString()] || [];
      if (list.length === 0) {
        pledgeNotUsedDonationListMap[pledgeId.toString()] = list;
      }

      const item = {
        _id: _id.toString(),
        amount: amount.toString(),
        savedAmountRemaining: amountRemaining.toString(),
        amountRemaining: '0',
        txHash,
        status,
        savedStatus: status,
        mined,
        parentDonations: parentDonations.map(id => id.toString()),
        ownerId,
        ownerType,
        ownerTypeId,
        intendedProjectId: String(intendedProjectId),
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


export async function unsetPendingAmountRemainingFromCommittedDonations() {
  const query = {
    status: DonationStatus.COMMITTED,
    pendingAmountRemaining: {$exists: true}
  };
  const notPendingDonationsWithPendingAmountRemaining = await donationModel.find(query);
  report.removedPendingAmountRemainingCount = notPendingDonationsWithPendingAmountRemaining.length;
  console.log('Removed pendingAmountFromDonations count', notPendingDonationsWithPendingAmountRemaining.length)
  notPendingDonationsWithPendingAmountRemaining.forEach(donation => {
    logger.error('Remove pendingAmountFromDonations', donation)
  })
  await donationModel.updateMany(query, {
    $set: {updatedBySimulationDate: new Date()},
    $unset: {pendingAmountRemaining: 1}
  })


}

export async function fixConflictInDonations(
  options: {
    unusedDonationMap: Map<string, any>,
    donationMap: DonationObjectInterface,
    fixConflicts: boolean,
    pledges: PledgeInterface[]
  }) {
  const {
    unusedDonationMap, fixConflicts,
    donationMap, pledges
  } = options;
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
          logger.info('Deleting conversation and relevant conversation if exists ...', {_id});
          report.deletedDonations++;
          promises.push(donationModel.findOneAndDelete({_id}));
          promises.push(conversationModel.findOneAndDelete({
            donationId: _id,
          }));

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
            if (token && tokenCutoff && tokenCutoff.cutoff) {
              report.updateAmountRemaining++;
              promises.push(
                updateOneDonation(_id, {
                  amountRemaining,
                  lessThanCutoff: tokenCutoff.cutoff.gt(amountRemaining),
                }),
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
            promises.push(updateOneDonation(
              _id,
              {status}
            ));
          }
        }
      }
    },
  );
  return Promise.all(promises);
}

const donationCommitTime = async (liquidPledging: any, donation: DonationMongooseDocument) => {
  const pledge = await liquidPledging.getPledge(donation.pledgeId) ;
  return  new Date(pledge.commitTime * 1000)
}
export const addCommitTimeForToApproveDonations = async (liquidPledging: any) => {
  console.log('addCommitTimeForToApproveDonations  called');
  const query = {
    status: DonationStatus.TO_APPROVE,
    commitTime: {$exists: false}
  };
  await donationModel.find(query).cursor().eachAsync(async (donation) => {

    try {
      const commitTime = await donationCommitTime(liquidPledging, donation);
      await updateOneDonation(donation._id, {commitTime})
    } catch (error) {
      logger.error('addCommitTimeForToApproveDonations error', {
        donationID: donation._id,
        error
      })
    }
  })
}
