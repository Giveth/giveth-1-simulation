import {createProgressBar} from "./utils/progressBar";

const config = require('config');
import {
  AdminInterface,
  DelegateInfoInterface,
  DonationListObjectInterface, DonationObjectInterface, EventInterface, extendedDonation,
  PledgeInterface, TransferInfoInterface,
} from './utils/interfaces';
import BigNumber from 'bignumber.js';
import * as mongoose from 'mongoose';

const {Kernel, AppProxyUpgradeable} = require('giveth-liquidpledging/build/contracts');
import {setDonationUsdValue} from './utils/DonationUsdValueUtility';
import {getTokenCutoff} from './utils/tokenUtility';
import {donationModel, DonationMongooseDocument, DonationStatus} from './models/donations.model';
import {pledgeAdminModel, AdminTypes, PledgeAdminMongooseDocument} from './models/pledgeAdmins.model';
import {Logger} from 'winston';
import {getLogger} from './utils/logger';
import {getActionTakerAddress, getHomeTxHashForDonation, getTransaction} from './utils/web3Helpers';
import {sendReportEmail, sendSimulationErrorEmail} from './services/emailService';
import {syncDacs} from './services/dacServices'
import {syncPledgeAdminsAndProjects} from "./services/pledgeAdminService";
import {updateMilestonesFinalStatus} from "./services/milestoneService";
import {fetchBlockchainData, instantiateWeb3} from "./services/blockChainService";
import {cancelProject, updateEntityDonationsCounter} from "./services/projectService";
import {fetchDonationsInfo, fixConflictInDonations} from "./services/donationService";
import {isReturnTransfer} from "./utils/donationUtils";

const dappMailerUrl = config.get('dappMailerUrl') as string;
const givethDevMailList = config.get('givethDevMailList') as string[];
const dappMailerSecret = config.get('dappMailerSecret') as string;

const report = {
  syncDelegatesSpentTime: 0,
  syncProjectsSpentTime: 0,
  syncDonationsSpentTime: 0,
  syncPledgeAdminsSpentTime: 0,
  syncMilestoneSpentTime: 0,
  createdDacs: 0,
  createdCampaigns: 0,
  createdMilestones: 0,
  createdDonations: 0,
  createdPledgeAdmins: 0,
  updatedMilestoneStatus: 0,
  processedEvents: 0,
  correctFailedDonations: 0,
  fetchedNewEventsCount: 0,
  fetchedNewPledgeAdminCount: 0,
  fetchedNewPledgeCount: 0,
};

const cacheDir = config.get('cacheDir');
const updateState = config.get('updateNetworkCache');
const updateEvents = config.get('updateNetworkCache');
const index = !config.get('dryRun');
const fixConflicts = !config.get('dryRun');
// const ignoredTransactions  = require('./eventProcessingHelper.json');
const ignoredTransactions = [];

// Blockchain data
let events: EventInterface[];
let pledges: PledgeInterface[];
let admins: AdminInterface[];

// Map from pledge id to list of donations which are charged and can be used to move money from
const chargedDonationListMap: DonationListObjectInterface = {};
// Map from pledge id to list of donations belonged to the pledge and are not used yet!
let pledgeNotUsedDonationListMap = {};
// Map from _id to list of donations
let donationMap: DonationObjectInterface = {};
// Map from txHash to list of included events
const txHashTransferEventMap = {};
// Map from owner pledge admin ID to dictionary of charged donations
const ownerPledgeAdminIdChargedDonationMap = {};

const {nodeUrl, homeNodeUrl} = config.get('blockchain');
let foreignWeb3;
let homeWeb3;
let liquidPledging;

console.log(cacheDir);
const logger: Logger = getLogger();


const terminateScript = (message = '', code = 0) => {
  logger.error(`Exit message: ${message}`);
  if (message) {
    logger.error(`Exit message: ${message}`);
  }

  logger.on('finish', () => {
    setTimeout(() => process.exit(code), 5 * 1000);
  });

  logger.end();
};


async function getKernel() {
  const kernelAddress = await liquidPledging.kernel();
  return new Kernel(foreignWeb3, kernelAddress);
}

const convertPledgeStateToStatus = (pledge: PledgeInterface,
                                    pledgeAdmin: AdminInterface | PledgeAdminMongooseDocument) => {
  const {pledgeState, delegates, intendedProject} = pledge;
  switch (pledgeState) {
    case 'Paying':
    case '1':
      return DonationStatus.PAYING;

    case 'Paid':
    case '2':
      return DonationStatus.PAID;

    case 'Pledged':
    case '0':
      if (intendedProject !== '0') return DonationStatus.TO_APPROVE;
      if (pledgeAdmin.type === 'Giver' || delegates.length > 0) return DonationStatus.WAITING;
      return DonationStatus.COMMITTED;

    default:
      return null;
  }
};


const isRejectedDelegation = (data: { fromPledge: PledgeInterface, toPledge: PledgeInterface }) => {
  const {fromPledge, toPledge} = data;
  return !!fromPledge &&
    Number(fromPledge.intendedProject) > 0 &&
    fromPledge.intendedProject !== toPledge.owner;
};


const addChargedDonation = (donation: DonationMongooseDocument) => {
  const candidates = chargedDonationListMap[donation.pledgeId] || [];
  if (candidates.length === 0) {
    chargedDonationListMap[donation.pledgeId] = candidates;
  }
  candidates.push(donation);

  const ownerEntityDonations = ownerPledgeAdminIdChargedDonationMap[donation.ownerId] || {};
  if (Object.keys(ownerEntityDonations).length === 0) {
    ownerPledgeAdminIdChargedDonationMap[donation.ownerId] = ownerEntityDonations;
  }
  ownerEntityDonations[donation._id] = donation;
};

const handleFromDonations = async (from: string, to: string,
                                   amount: string, transactionHash: string) => {
  const usedFromDonations = []; // List of donations which could be parent of the donation
  let giverAddress;

  const toUnusedDonationList = pledgeNotUsedDonationListMap[to] || []; // List of donations which are candidates to be charged

  const toPledge = pledges[Number(to)];
  const toOwnerId = toPledge.owner;
  const toOwnerAdmin = admins[Number(toOwnerId)];
  if (from !== '0') {
    const candidateChargedParents = chargedDonationListMap[from] || [];

    // Trying to find the matching donation from DB
    let candidateToDonationList = toUnusedDonationList.filter(
      item => item.txHash === transactionHash && item.amountRemaining.eq(0),
    );

    if (candidateToDonationList.length > 1) {
      logger.debug('candidateToDonationList length is greater than one!');
    } else if (candidateToDonationList.length === 0) {
      // Try to find donation among failed ones!
      const failedDonationList = pledgeNotUsedDonationListMap['0'] || [];
      const matchingFailedDonationIndex = failedDonationList.findIndex(item => {
        if (item.txHash === transactionHash && item.amount === amount) {
          const {parentDonations} = item;
          if (from === '0') {
            return parentDonations.length === 0;
          } // It should not have parent
          // Check whether parent pledgeId equals from
          if (parentDonations.length === 0) return false;
          const parent = donationMap[item.parentDonations[0]];
          return parent.pledgeId === from;
        }
        return false;
      });

      // A matching failed donation found, it's not failed and should be updated with correct value
      if (matchingFailedDonationIndex !== -1) {
        const toFixDonation = failedDonationList[matchingFailedDonationIndex];
        logger.error(`Donation ${toFixDonation._id} hasn't failed, it should be updated`);

        // Remove from failed donations
        failedDonationList.splice(matchingFailedDonationIndex, 1);

        toFixDonation.status = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
        toFixDonation.pledgeId = to;
        toFixDonation.mined = true;
        toUnusedDonationList.push(toFixDonation);
        candidateToDonationList = [toFixDonation];
        logger.debug('Will update to:');
        logger.debug(JSON.stringify(toFixDonation, null, 2));

        if (fixConflicts) {
          logger.debug('Updating...');
          await donationModel.updateOne(
            {_id: toFixDonation._id},
            {status: toFixDonation.status, pledgeId: to},
          );
          report.correctFailedDonations++;
        }
      }
    }

    // Reduce money from parents one by one
    if (candidateChargedParents.length > 0) {
      let fromAmount = new BigNumber(amount);

      // If this is a return transfer, last donate added to charged parents has the same
      // transaction hash and greater than or equal amount remaining than this transfer amount
      // Money should be removed from that donation for better transparency
      const lastInsertedCandidate = candidateChargedParents[candidateChargedParents.length - 1];
      if (
        lastInsertedCandidate.txHash === transactionHash &&
        new BigNumber(lastInsertedCandidate.amountRemaining).gte(new BigNumber(amount))
      ) {
        giverAddress = lastInsertedCandidate.giverAddress;
        lastInsertedCandidate.amountRemaining = new BigNumber(lastInsertedCandidate.amountRemaining).minus(amount).toFixed();

        fromAmount = new BigNumber(0);
        logger.debug(
          `Amount ${amount} is reduced from ${JSON.stringify(
            {
              ...lastInsertedCandidate,
              amountRemaining: new BigNumber(lastInsertedCandidate.amountRemaining).toFixed(),
            },
            null,
            2,
          )}`,
        );

        if (lastInsertedCandidate._id) {
          usedFromDonations.push(lastInsertedCandidate._id);
        }

        if (new BigNumber(lastInsertedCandidate.amountRemaining).isZero()) {
          candidateChargedParents.pop();
        }
      } else {
        let consumedCandidates = 0;
        for (let j = 0; j < candidateChargedParents.length; j += 1) {
          const item = candidateChargedParents[j];

          if (item.giverAddress) {
            giverAddress = item.giverAddress;
          }

          const min = BigNumber.min(item.amountRemaining, fromAmount);
          item.amountRemaining = new BigNumber(item.amountRemaining).minus(min).toFixed();
          fromAmount = fromAmount.minus(min);
          if (new BigNumber(item.amountRemaining).isZero()) {
            consumedCandidates += 1;
            // It's approve or reject
            if (item.status === DonationStatus.TO_APPROVE) {
              item.status =
                Number(toPledge.owner) === item.intendedProjectId
                  ? DonationStatus.COMMITTED
                  : DonationStatus.REJECTED;
            }
          }
          logger.debug(
            `Amount ${min.toFixed()} is reduced from ${JSON.stringify(
              {...item, amountRemaining: item.amountRemaining},
              null,
              2,
            )}`,
          );
          if (item._id) {
            usedFromDonations.push(item._id);
          }
          if (fromAmount.eq(0)) break;
        }

        chargedDonationListMap[from] = candidateChargedParents.slice(consumedCandidates);
      }

      if (!fromAmount.eq(0)) {
        logger.debug(`from delegate ${from} donations don't have enough amountRemaining!`);
        logger.debug(`Deficit amount: ${fromAmount.toFixed()}`);
        logger.debug('Not used candidates:');
        candidateChargedParents.forEach(candidate =>
          logger.debug(JSON.stringify(candidate, null, 2)),
        );
        terminateScript();
      }
    } else {
      logger.error(`There is no donation for transfer from ${from} to ${to}`);
      // I think we should not terminate script
      terminateScript(`There is no donation for transfer from ${from} to ${to}`);
    }
  }

  return {usedFromDonations, giverAddress};
};

const handleToDonations = async ({
                                   from,
                                   to,
                                   amount,
                                   transactionHash,
                                   blockNumber,
                                   usedFromDonations,
                                   giverAddress,
                                   isReverted = false,
                                 }) => {
  const toNotFilledDonationList = pledgeNotUsedDonationListMap[to] || []; // List of donations which are candidates to be charged


  const fromPledge = pledges[Number(from)];
  const toPledge = pledges[Number(to)];

  const toOwnerId = toPledge.owner;
  const fromOwnerId = from !== '0' ? fromPledge.owner : 0;

  const toOwnerAdmin = admins[Number(toOwnerId)];
  const fromOwnerAdmin = from !== '0' ? admins[Number(fromOwnerId)] : {};

  const fromPledgeAdmin = await pledgeAdminModel.findOne({id: Number(fromOwnerId)});

  let isReturn = isReverted;
  if (!isReturn) {
    const returnedTransfer = isReturnTransfer(
      {
        txHashTransferEventMap
        , transferInfo:
          {
            fromPledge,
            fromPledgeAdmin,
            fromPledgeId: from,
            toPledgeId: to,
            txHash: transactionHash,
          }
      });
    isReturn = isReturn || returnedTransfer;
  }

  const toIndex = toNotFilledDonationList.findIndex(
    item => item.txHash === transactionHash && item.amountRemaining.eq(0) && item.isReturn === isReturn,
  );

  const toDonation = toIndex !== -1 ? toNotFilledDonationList.splice(toIndex, 1)[0] : undefined;

  // It happens when a donation is cancelled, we choose the first one (created earlier)
  // if (toDonationList.length > 1) {
  //   console.log('toDonationList length is greater than 1');
  //   process.exit();
  // }

  if (!isReturn) {
    const rejectedDelegation = isRejectedDelegation({toPledge, fromPledge});
    isReturn = isReturn || rejectedDelegation;
  }

  if (toDonation === undefined) {
    // If parent is cancelled, this donation is not needed anymore
    const status = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
    let expectedToDonation: any = {
      txHash: transactionHash,
      parentDonations: usedFromDonations,
      from,
      pledgeId: to,
      pledgeState: toPledge.pledgeState,
      amount,
      amountRemaining: new BigNumber(amount),
      ownerId: toOwnerId,
      status,
      giverAddress,
      isReturn,
      isRecovered :true
    };
    const homeTxHash = await getHomeTxHashForDonation({
      txHash: transactionHash,
      parentDonations: usedFromDonations,
      from,
      web3: foreignWeb3
    });
    if (homeTxHash) {
      expectedToDonation.homeTxHash = homeTxHash;
    }

    if (fixConflicts) {
      let toPledgeAdmin: PledgeAdminMongooseDocument = await pledgeAdminModel.findOne({id: Number(toOwnerId)});
      if (!toPledgeAdmin) {
        if (toOwnerAdmin.type !== 'Giver') {
          terminateScript(
            `No PledgeAdmin record exists for non user admin ${JSON.stringify(
              toOwnerAdmin,
              null,
              2,
            )}`,
          );
          logger.error(
            `No PledgeAdmin record exists for non user admin ${JSON.stringify(
              toOwnerAdmin,
              null,
              2,
            )}`,
          );
          return;
        }

        // Create user pledge admin
        toPledgeAdmin = new pledgeAdminModel({
          id: Number(toOwnerId),
          type: AdminTypes.GIVER,
          typeId: toOwnerAdmin.addr,
          isRecovered:true
        });
        await toPledgeAdmin.save();
        report.createdPledgeAdmins++;
        logger.info(`pledgeAdmin crated: ${toPledgeAdmin._id.toString()}`);
      }

      if (!toPledgeAdmin.typeId) {
        console.log("pledgeAdminId is undefined", {toPledgeAdmin, expectedToDonation})
      }

      expectedToDonation = {
        ...expectedToDonation,
        ownerId: toPledgeAdmin.id,
        ownerTypeId: toPledgeAdmin.typeId,
        ownerType: toPledgeAdmin.type,
      };

      // Create donation
      const token = config.get('tokenWhitelist').find(
        t => t.foreignAddress.toLowerCase() === toPledge.token.toLowerCase(),
      );
      if (token === undefined) {
        logger.error(`No token found for address ${toPledge.token}`);
        terminateScript(`No token found for address ${toPledge.token}`);
        return;
      }
      expectedToDonation.tokenAddress = token.address;
      const delegationInfo: DelegateInfoInterface = <DelegateInfoInterface>{};
      // It's delegated to a DAC
      if (toPledge.delegates.length > 0) {
        const [delegate] = toPledge.delegates;
        const dacPledgeAdmin = await pledgeAdminModel.findOne({id: Number(delegate.id)});
        if (!dacPledgeAdmin) {
          // This is wrong, why should we terminate if there is no dacPledgeAdmin
          logger.error(`No dac found for id: ${delegate.id}`);
          terminateScript(`No dac found for id: ${delegate.id}`);
          return;
        }
        delegationInfo.delegateId = dacPledgeAdmin.id;
        delegationInfo.delegateTypeId = dacPledgeAdmin.typeId;
        delegationInfo.delegateType = dacPledgeAdmin.type;

        // Has intended project
        const {intendedProject} = toPledge;
        if (intendedProject !== '0') {
          const intendedProjectPledgeAdmin = await pledgeAdminModel.findOne({
            id: Number(intendedProject),
          });
          if (!intendedProjectPledgeAdmin) {
            terminateScript(`No project found for id: ${intendedProject}`);
            return;
          }
          delegationInfo.intendedProjectId = intendedProjectPledgeAdmin.id;
          delegationInfo.intendedProjectTypeId = intendedProjectPledgeAdmin.typeId;
          delegationInfo.intendedProjectType = intendedProjectPledgeAdmin.type;
        }
      }
      expectedToDonation = {
        ...expectedToDonation,
        ...delegationInfo,
      };

      // Set giverAddress to owner address if is a Giver
      if (giverAddress === undefined) {
        if (toOwnerAdmin.type !== 'Giver') {
          logger.error('Cannot set giverAddress');
          terminateScript(`Cannot set giverAddress`);
          return;
        }
        giverAddress = toPledgeAdmin.typeId;
        expectedToDonation.giverAddress = giverAddress;
      }

      if (status === null) {
        logger.error(`Pledge status ${toPledge.pledgeState} is unknown`);
        terminateScript(`Pledge status ${toPledge.pledgeState} is unknown`);
        return;
      }

      const {timestamp} = await foreignWeb3.eth.getBlock(blockNumber);
      const actionTakerAddress = await getActionTakerAddress({
        txHash: transactionHash,
        homeWeb3,
        foreignWeb3,
        homeTxHash
      });
      const model: any = {
        ...expectedToDonation,
        tokenAddress: token.address,
        actionTakerAddress,
        amountRemaining: new BigNumber(expectedToDonation.amountRemaining).toFixed(),
        mined: true,
        createdAt: new Date(timestamp * 1000),
      };

      const {cutoff} = getTokenCutoff(token.symbol);
      model.lessThanCutoff = cutoff.gt(new BigNumber(model.amountRemaining));

      const donation = new donationModel(model);

      await setDonationUsdValue(donation);
      await donation.save();
      report.createdDonations++;

      const _id = donation._id.toString();
      expectedToDonation._id = _id;
      expectedToDonation.savedAmountRemaining = model.amountRemaining;
      donationMap[_id] = {...expectedToDonation};
      logger.info(
        `donation created: ${JSON.stringify(
          {
            ...expectedToDonation,
            amountRemaining: new BigNumber(expectedToDonation.amountRemaining).toFixed(),
          },
          null,
          2,
        )}`,
      );
    } else {
      logger.info(
        `this donation should be created: ${JSON.stringify(
          {
            ...expectedToDonation,
            amountRemaining: new BigNumber(expectedToDonation.amountRemaining).toFixed(),
          },
          null,
          2,
        )}`,
      );
      logger.debug('--------------------------------');
      logger.debug(`From owner: ${fromOwnerAdmin}`);
      logger.debug(`To owner:${toOwnerAdmin}`);
      logger.debug('--------------------------------');
      logger.debug(`From pledge: ${fromPledge}`);
      logger.debug(`To pledge: ${toPledge}`);
    }
    addChargedDonation(expectedToDonation);
  } else {
    // Check toDonation has correct status and mined flag
    const expectedStatus = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
    if (expectedStatus === null) {
      logger.error(`Pledge status ${toPledge.pledgeState} is unknown`);
      terminateScript(`Pledge status ${toPledge.pledgeState} is unknown`);
      return;
    }

    if (toDonation.mined === false) {
      logger.error(`Donation ${toDonation._id} mined flag should be true`);
      logger.debug('Updating...');
      await donationModel.updateOne({_id: toDonation._id}, {mined: true});
      toDonation.mined = true;
    }

    toDonation.status = expectedStatus;

    const {parentDonations} = toDonation;
    if (
      usedFromDonations.length !== parentDonations.length ||
      usedFromDonations.some(id => !parentDonations.includes(id))
    ) {
      logger.error(`Parent of ${toDonation._id} should be updated to ${usedFromDonations}`);
      if (fixConflicts) {
        logger.debug('Updating...');
        toDonation.parentDonations = usedFromDonations;
        await donationModel.updateOne(
          {_id: toDonation._id},
          {parentDonations: usedFromDonations},
        );

      }
    }

    if (toDonation.isReturn !== isReturn) {
      logger.error(`Donation ${toDonation._id} isReturn flag should be ${isReturn}`);
      logger.debug('Updating...');
      await donationModel.updateOne({_id: toDonation._id}, {isReturn});
      toDonation.isReturn = isReturn;
    }

    const {usdValue} = toDonation;
    await setDonationUsdValue(toDonation);
    if (toDonation.usdValue !== usdValue) {
      logger.error(
        `Donation ${toDonation._id} usdValue is ${usdValue} but should be updated to ${toDonation.usdValue}`,
      );
      logger.debug('Updating...');
      await donationModel.updateOne({_id: toDonation._id}, {usdValue: toDonation.usdValue});

    }

    toDonation.txHash = transactionHash;
    toDonation.from = from;
    toDonation.pledgeId = to;
    toDonation.pledgeState = toPledge.pledgeState;
    toDonation.amountRemaining = amount;

    addChargedDonation(toDonation);

    logger.debug(
      `Amount added to ${JSON.stringify(
        {
          _id: toDonation._id,
          amountRemaining: toDonation.amountRemaining,
          amount: toDonation.amount,
          status: toDonation.status,
        },
        null,
        2,
      )}`,
    );
  }
};


const syncEventWithDb = async (eventData: EventInterface) => {
  const {event, transactionHash, logIndex, returnValues, blockNumber} = eventData;
  if (ignoredTransactions.some(it => it.txHash === transactionHash && it.logIndex === logIndex)) {
    logger.debug('Event ignored.');
    return;
  }

  if (event === 'Transfer') {
    const {from, to, amount} = returnValues;
    logger.debug(`Transfer from ${from} to ${to} amount ${amount}`);

    // eslint-disable-next-line no-await-in-loop
    const {usedFromDonations, giverAddress} = await handleFromDonations(
      from,
      to,
      amount,
      transactionHash,
    );

    // eslint-disable-next-line no-await-in-loop
    await handleToDonations({
      from,
      to,
      amount,
      transactionHash,
      blockNumber,
      usedFromDonations,
      giverAddress,
    });
  } else if (event === 'CancelProject') {
    const {idProject} = returnValues;
    logger.debug(
      `Cancel project ${idProject}: ${JSON.stringify(admins[Number(idProject)], null, 2)}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await cancelProject({
      ownerPledgeAdminIdChargedDonationMap,
      projectId:idProject,
      admins
    });
  }
};

const syncDonationsWithNetwork = async () => {
  // Map from pledge id to list of donations belonged to the pledge and are not used yet!
  const donationsInfo = await fetchDonationsInfo();
  donationMap = donationsInfo.donationMap;
  pledgeNotUsedDonationListMap = donationsInfo.pledgeNotUsedDonationListMap;

  const startTime = new Date();
  // create new progress bar
  const progressBar = createProgressBar({title: 'Syncing donations with events.'});
  progressBar.start(events.length, 0);

  // Simulate transactions by events
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);
    const {event, transactionHash, logIndex, returnValues, blockNumber} = events[i];
    logger.debug(
      `-----\nProcessing event ${i}:\nLog Index: ${logIndex}\nEvent: ${event}\nTransaction hash: ${transactionHash}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await syncEventWithDb({event, transactionHash, logIndex, returnValues, blockNumber});
  }
  progressBar.update(events.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  report.syncDonationsSpentTime = spentTime;
  console.log(`events donations synced end.\n spentTime :${spentTime} seconds`);

  const unusedDonationMap = new Map();
  Object.values(pledgeNotUsedDonationListMap).forEach((list: any = []) =>
    list.forEach(item => unusedDonationMap.set(item._id, item)),
  );
  await fixConflictInDonations({
    donationMap,
    fixConflicts,
    pledges,
    unusedDonationMap
  });
};


const main = async () => {
  try {
    homeWeb3 = (await instantiateWeb3(homeNodeUrl)).web3;
    const instantiateForeignWeb3 = await instantiateWeb3(nodeUrl);
    foreignWeb3 = instantiateForeignWeb3.web3;
    liquidPledging = instantiateForeignWeb3.liquidPledging;
    const blockChainData = await fetchBlockchainData({
      report,
      updateEvents,
      updateState,
      cacheDir,
      foreignWeb3,
      liquidPledging

    });
    events = blockChainData.events;
    admins = blockChainData.admins;
    pledges = blockChainData.pledges;
    events.forEach(e => {
      if (e.event === 'Transfer') {
        const {transactionHash} = e;
        const list: EventInterface[] = txHashTransferEventMap[transactionHash] || [];
        if (list.length === 0) {
          txHashTransferEventMap[transactionHash] = list;
        }
        list.push(e);
      }
    });

    if (!index && !fixConflicts) {
      terminateScript(null, 0);
      return;
    }

    /*
       Find conflicts in milestone donation counter
      */
    const mongoUrl = config.get('mongodb') as string;
    mongoose.connect(mongoUrl);
    const db = mongoose.connection;

    db.on('error', err => logger.error(`Could not connect to Mongo:\n${err.stack}`));

    db.once('open', async () => {
      logger.info('Connected to Mongo');
      try {
        await syncDacs({
          report,
          homeWeb3,
          foreignWeb3,
          events,
          liquidPledging,
          fixConflicts,
          AppProxyUpgradeable,
          kernel: await getKernel()
        });
        await syncPledgeAdminsAndProjects({
          report,
          homeWeb3,
          foreignWeb3,
          events,
          liquidPledging,
          fixConflicts,
          AppProxyUpgradeable,
          kernel: await getKernel()
        });
        await syncDonationsWithNetwork();
        await updateEntityDonationsCounter(AdminTypes.DAC);
        await updateEntityDonationsCounter(AdminTypes.CAMPAIGN);
        await updateEntityDonationsCounter(AdminTypes.MILESTONE);
        await updateMilestonesFinalStatus(
          {
            report,
            events
          }
        );
        console.table(report);
        if (config.get('emailReport')) {
          await sendReportEmail(report,
            givethDevMailList,
            dappMailerUrl,
            dappMailerSecret
          )
        }

        terminateScript('All job done.', 0);
      } catch (e) {
        console.log('error syncing ... ', e);
        if (config.get('emailSimulationError')) {
          sendSimulationErrorEmail(e.toString(),
            givethDevMailList,
            dappMailerUrl,
            dappMailerSecret
          )
        }
        terminateScript('Scripts failed', 0);

      }

    });
  } catch (e) {
    logger.error(e);
    throw e;
  }
};

main()
  .then(() => {
  })
  .catch(e => terminateScript(e, 1));
