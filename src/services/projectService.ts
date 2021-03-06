import {donationModel, DonationStatus} from "../models/donations.model";
import {AdminTypes} from "../models/pledgeAdmins.model";
import {createProgressBar} from "../utils/progressBar";
import {ANY_TOKEN, getTokenByAddress, getTokenSymbolByAddress} from "../utils/tokenUtility";
import {toBN} from "web3-utils";
import {traceModel, TraceMongooseDocument, TraceStatus} from "../models/traces.model";
import {campaignModel, CampaignMongooseDocument, CampaignStatus} from "../models/campaigns.model";
import {getLogger} from "../utils/logger";
import {communityModel, CommunityMongooseDocument} from "../models/communities.model";
import {Model, model} from "mongoose";
import BigNumber from "bignumber.js";
import {AdminInterface} from "../utils/interfaces";

const logger = getLogger();
const _groupBy = require('lodash.groupby');


interface EntityType extends CommunityMongooseDocument, CampaignMongooseDocument, TraceMongooseDocument {
  fullyFunded: boolean,
  maxAmount: string,
}

export const updateEntityDonationsCounter = async (type: string) => {
  let model: Model<EntityType>;
  const donationQuery = {
    // $select: ['amount', 'giverAddress', 'amountRemaining', 'token', 'status', 'isReturn'],
    mined: true,
    status: {$nin: [DonationStatus.FAILED, DonationStatus.PAYING, DonationStatus.PAID]},
  };

  let idFieldName;
  if (type === AdminTypes.COMMUNITY) {
    model = communityModel as unknown as Model<EntityType>;
    // TODO I think this can be gamed if the donor refunds their donation from the community
    Object.assign(donationQuery, {
      delegateType: AdminTypes.COMMUNITY,
      $and: [
        {
          $or: [{intendedProjectId: 0}, {intendedProjectId: undefined}],
        },
        {
          $or: [{parentDonations: {$not: {$size: 0}}}, {amountRemaining: {$ne: '0'}}],
        },
      ],
    });
    idFieldName = 'delegateTypeId';
  } else if (type === AdminTypes.CAMPAIGN) {
    model = campaignModel as unknown as Model<EntityType>;
    Object.assign(donationQuery, {
      ownerType: AdminTypes.CAMPAIGN,
    });
    idFieldName = 'ownerTypeId';
  } else if (type === AdminTypes.TRACE) {
    model = traceModel as unknown as Model<EntityType>;
    Object.assign(donationQuery, {
      ownerType: AdminTypes.TRACE,
    });
    idFieldName = 'ownerTypeId';
  } else {
    return;
  }

  const entities = await model.find({});
  const progressBar = createProgressBar({
    title: `Syncing donationCounter for ${type}`,
  });
  progressBar.start(entities.length);
  for (const entity of entities) {
    progressBar.increment();
    const oldDonationCounters = entity.donationCounters;
    const query = {...donationQuery};
    query[idFieldName] = entity._id;

    const donations = await donationModel.find(query);

    const returnedDonations = await donationModel.find({
      isReturn: true,
      mined: true,
      parentDonations: {$in: donations.map(d => d._id)},
    });

    // first group by token (symbol)
    const groupedDonations = _groupBy(donations,
      d => (getTokenSymbolByAddress(d.tokenAddress) || 'ETH'));
    const groupedReturnedDonations = _groupBy(
      returnedDonations,
      d => (getTokenSymbolByAddress(d.tokenAddress) || 'ETH'),
    );

    // and calculate cumulative token balances for each donated token
    const donationCounters = Object.keys(groupedDonations).map(symbol => {
      const tokenDonations = groupedDonations[symbol];
      const returnedTokenDonations = groupedReturnedDonations[symbol] || [];
      let {totalDonated, currentBalance} = tokenDonations.reduce(
        (accumulator, d) => ({
          totalDonated: d.isReturn
            ? accumulator.totalDonated
            : accumulator.totalDonated.add(toBN(d.amount)),
          currentBalance: accumulator.currentBalance.add(toBN(d.amountRemaining)),
        }),
        {
          totalDonated: toBN(0),
          currentBalance: toBN(0),
        },
      );

      // Exclude returned values from canceled trace
      if (
        !(type === AdminTypes.TRACE && entity.status === TraceStatus.CANCELED) &&
        !(type === AdminTypes.CAMPAIGN && entity.status === CampaignStatus.CANCELED)
      ) {
        totalDonated = returnedTokenDonations.reduce(
          (acc, d) => acc.sub(toBN(d.amount)),
          totalDonated,
        );
      }

      const donationCount = tokenDonations.filter(d => !d.isReturn).length;

      // find the first donation in the group that has a token object
      // b/c there are other donation objects coming through as well
      const {tokenAddress} = tokenDonations.find(d => d.tokenAddress);
      const token = getTokenByAddress(tokenAddress);
      return {
        name: token.name,
        address: token.address,
        foreignAddress: token.foreignAddress,
        decimals: token.decimals,
        symbol,
        totalDonated,
        currentBalance,
        donationCount,
      };
    });

    let shouldUpdateEntity = false;
    const mutations: any = {};
    let message = '';

    const typeName = type[0].toUpperCase() + type.slice(1);

    if (donationCounters.length !== oldDonationCounters.length) {
      message += `${typeName} ${entity._id.toString()} (${
        entity.status
      }) donation counter length is changed from ${oldDonationCounters.length} to ${
        donationCounters.length
      }\n`;
      mutations.donationCounters = donationCounters;
      shouldUpdateEntity = true;
    } else {
      donationCounters.forEach(dc => {
        const oldDC = oldDonationCounters.find(item => item.symbol === dc.symbol);
        if (
          oldDC === undefined ||
          oldDC.totalDonated.toString() !== dc.totalDonated.toString() ||
          oldDC.currentBalance.toString() !== dc.currentBalance.toString() ||
          oldDC.donationCount !== dc.donationCount
        ) {
          message += `${typeName} ${entity._id.toString()} (${
            entity.status
          }) donation counter should be updated\n`;
          if (oldDC) {
            message += `Old:\n${JSON.stringify(
              {
                symbol: oldDC.symbol,
                totalDonated: oldDC.totalDonated.toString(),
                currentBalance: oldDC.currentBalance.toString(),
              },
              null,
              2,
            )}\n`;
          }
          message += `New:\n${JSON.stringify(
            {
              symbol: dc.symbol,
              totalDonated: dc.totalDonated.toString(),
              currentBalance: dc.currentBalance.toString(),
            },
            null,
            2,
          )}\n`;

          mutations.donationCounters = donationCounters;
          shouldUpdateEntity = true;
        }
      });
    }

    const {tokenAddress, maxAmount} = entity;
    const token = getTokenByAddress(tokenAddress);
    const foundDonationCounter = token && donationCounters.find(dc => dc.symbol === token.symbol);
    const fullyFunded = !!(
      type === AdminTypes.TRACE &&
      donationCounters.length > 0 &&
      token &&
      token.foreignAddress !== ANY_TOKEN.foreignAddress &&
      maxAmount &&
      foundDonationCounter &&
      toBN(maxAmount)
        .sub(foundDonationCounter.totalDonated)
        .lt(toBN(10 ** (18 - Number(token.decimals))))
    ); // Difference less than this number is negligible

    if (
      (fullyFunded === true || entity.fullyFunded !== undefined) &&
      entity.fullyFunded !== fullyFunded && foundDonationCounter
    ) {
      message += `Diff: ${toBN(entity.maxAmount).sub(foundDonationCounter.totalDonated)}\n`;
      message += `${typeName} ${entity._id.toString()} (${
        entity.status
      }) fullyFunded status changed from ${entity.fullyFunded} to ${fullyFunded}\n`;
      shouldUpdateEntity = true;
      mutations.fullyFunded = fullyFunded;
    }

    const peopleCount = new Set(donations.map(d => d.giverAddress)).size;
    if (
      !(peopleCount === 0 && entity.peopleCount === undefined) &&
      peopleCount !== entity.peopleCount
    ) {
      message += `${typeName} ${entity._id.toString()} peopleCount value changed from ${
        entity.peopleCount
      } to ${peopleCount}\n`;
      shouldUpdateEntity = true;
      mutations.peopleCount = peopleCount;
    }

    if (shouldUpdateEntity) {
      logger.debug(`----------------------------\n${message}\nUpdating...`);
      await model.findOneAndUpdate({_id: entity._id}, mutations);
    }

  }
  progressBar.update(entities.length);
  progressBar.stop();
  console.log(`Syncing donationCounter for ${type} ends.`);

};

const revertProjectDonations = async (options: {
  projectId: string | number,
  ownerPledgeAdminIdChargedDonationMap: object
}) => {
  const {ownerPledgeAdminIdChargedDonationMap, projectId} = options;
  const donations: any = ownerPledgeAdminIdChargedDonationMap[projectId] || {};
  const values = Object.values(donations);
  const revertExceptionStatus = [DonationStatus.PAYING, DonationStatus.PAID];

  for (let i = 0; i < values.length; i += 1) {
    const donation: any = values[i];
    if (!new BigNumber(donation.amountRemaining).isZero() && !revertExceptionStatus.includes(donation.status)) {
      donation.status = DonationStatus.CANCELED;
    }

    // Remove all donations of same pledgeId from charged donation list that are not Paying or Paid
    // because all will be reverted
  }
};

export const cancelProject = async (
  options: {
    projectId: string,
    ownerPledgeAdminIdChargedDonationMap: object,
    admins:AdminInterface[]
  }) => {
  const {
    projectId, admins,
    ownerPledgeAdminIdChargedDonationMap
  } = options;
  admins[projectId].isCanceled = true;
  await revertProjectDonations({
    projectId,
    ownerPledgeAdminIdChargedDonationMap
  });

  const projectIdStr = String(projectId);
  for (let index = 1; index < admins.length; index += 1) {
    const admin = admins[index];

    if (admin.parentProject === projectIdStr) {
      admin.isCanceled = true;
      // eslint-disable-next-line no-await-in-loop
      await revertProjectDonations({
        projectId:index,
        ownerPledgeAdminIdChargedDonationMap
      });
    }
  }
};