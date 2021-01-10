/* eslint-disable no-continue */
/* eslint-disable no-console */
/*  eslint-disable no-await-in-loop */
// import  Web3 from 'web3';
const config =require('config');
import {
  AdminInterface,
  DelegateInfoInterface,
  DonationListObjectInterface, DonationObjectInterface, EventInterface, extendedDonation,
  PledgeInterface, TransferInfoInterface,
} from './utils/interfaces';
// import  Web3 from 'web3';
const Contract = require('web3-eth-contract');
const Web3WsProvider = require('web3-providers-ws');
const ForeignGivethBridgeArtifact = require('giveth-bridge/build/ForeignGivethBridge.json');
import { keccak256 } from 'web3-utils';

const Web3 = require('web3');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yargs from 'yargs';
import BigNumber from 'bignumber.js';
import * as mongoose from 'mongoose';
import * as cliProgress from 'cli-progress';
import * as _colors from 'colors';

import { LiquidPledging, LiquidPledgingState } from 'giveth-liquidpledging';
const { Kernel, AppProxyUpgradeable } = require('giveth-liquidpledging/build/contracts');
import { toFn } from './utils/to';
import { DonationUsdValueUtility } from './utils/DonationUsdValueUtility';
import { getTokenByAddress, getTokenSymbolByAddress } from './utils/tokenUtility';
import { createProjectHelper } from './utils/createProjectHelper';
import { converionRateModel } from './models/conversionRates.model';
import { donationModel, DonationMongooseDocument, DonationStatus } from './models/donations.model';
import { milestoneModel, MilestoneMongooseDocument, MilestoneStatus } from './models/milestones.model';
import { campaignModel, CampaignStatus } from './models/campaigns.model';
import { pledgeAdminModel, AdminTypes, PledgeAdminMongooseDocument } from './models/pledgeAdmins.model';
import { Logger } from 'winston';
import { getLogger } from './utils/logger';
import { dacModel } from './models/dacs.model';
import { ANY_TOKEN, getTransaction, ZERO_ADDRESS } from './utils/web3Helpers';
// import { sendReportEmail } from './utils/emailService';
import { getAdminBatch, getPledgeBatch } from './utils/liquidPledgingHelper';
import { toBN } from 'web3-utils';
import { Types } from 'mongoose';
import { sendReportEmail, sendSimulationErrorEmail } from './utils/emailService';

const _groupBy = require('lodash.groupby');
const dappMailerUrl = config.get('dappMailerUrl');
const givethDevMailList = config.get('givethDevMailList');
const dappMailerSecret = config.get('dappMailerSecret')

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


const { argv } = yargs
  .option('dry-run', {
    describe: 'enable dry run',
    type: 'boolean',
    default: false,
  })
  .option('update-network-cache', {
    describe: 'update network state and events cache',
    type: 'boolean',
    default: false,
  })
  .option('cache-dir', {
    describe: 'directory to create cache file inside',
    type: 'string',
    default: path.join(os.tmpdir(), 'simulation-script'),
  })
  .option('log-dir', {
    describe: 'directory to save logs inside, if empty logs will be write to stdout',
    type: 'string',
  })
  .option('debug', {
    describe: 'produce debugging log',
    type: 'boolean',
  })
  .version(false)
  .help();
const cacheDir = argv['cache-dir'];
const logDir = argv['log-dir'];
const updateState = argv['update-network-cache'];
const updateEvents = argv['update-network-cache'];
const index = !argv['dry-run'];
const fixConflicts = !argv['dry-run'];
// const ignoredTransactions  = require('./eventProcessingHelper.json');
const ignoredTransactions = [];

// Blockchain data
let events: EventInterface[];
let pledges: PledgeInterface[];
let admins: AdminInterface[];

// Map from pledge id to list of donations which are charged and can be used to move money from
const chargedDonationListMap: DonationListObjectInterface = {};
// Map from pledge id to list of donations belonged to the pledge and are not used yet!
const pledgeNotUsedDonationListMap = {};
// Map from _id to list of donations
const donationMap: DonationObjectInterface = {};
// Map from txHash to list of included events
const txHashTransferEventMap = {};
// Map from owner pledge admin ID to dictionary of charged donations
const ownerPledgeAdminIdChargedDonationMap = {};

const { nodeUrl, liquidPledgingAddress, homeNodeUrl } = config.get('blockchain');
let foreignWeb3;
let homeWeb3;
let liquidPledging;

console.log(cacheDir);
const logger: Logger = getLogger(logDir, argv.debug ? 'debug' : 'error');

function eventDecodersFromArtifact(artifact) {
  return artifact.compilerOutput.abi
    .filter(method => method.type === 'event')
    .reduce(
      (decoders, event) => ({
        ...decoders,
        [event.name]: Contract.prototype._decodeEventABI.bind(event),
      }),
      {},
    );
}

function topicsFromArtifacts(artifacts, names) {
  return artifacts
    .reduce(
      (accumulator, artifact) =>
        accumulator.concat(
          artifact.compilerOutput.abi.filter(
            method => method.type === 'event' && names.includes(method.name),
          ),
        ),
      [],
    )
    .reduce(
      (accumulator, event) =>
        accumulator.concat({
          name: event.name,
          hash: keccak256(`${event.name}(${event.inputs.map(i => i.type).join(',')})`),
        }),
      [],
    );
}

async function getHomeTxHash(txHash: string) {
  const decoders = eventDecodersFromArtifact(ForeignGivethBridgeArtifact);

  const [err, receipt] = await toFn(foreignWeb3.eth.getTransactionReceipt(txHash));

  if (err || !receipt) {
    logger.error('Error fetching transaction, or no tx receipt found ->', err, receipt);
    return undefined;
  }

  const topics = topicsFromArtifacts([ForeignGivethBridgeArtifact], ['Deposit']);

  // get logs we're interested in.
  const logs = receipt.logs.filter(log => topics.some(t => t.hash === log.topics[0]));

  if (logs.length === 0) return undefined;

  const log = logs[0];

  const topic = topics.find(t => t.hash === log.topics[0]);
  const event = decoders[topic.name](log);

  return event.returnValues.homeTx;
}

async function getActionTakerAddress(options: { txHash: string, homeTxHash: string }) {
  const { txHash, homeTxHash } = options;
  const { from } = await getTransaction({ txHash:homeTxHash|| txHash, isHome: Boolean(homeTxHash), foreignWeb3, homeWeb3 });
  return from;
}

async function getHomeTxHashForDonation(options:
                                          { txHash: string, parentDonations: string[], from: string }) {
  const { txHash, parentDonations, from } = options;
  if (from === '0') {
    return getHomeTxHash(txHash);
  }
  if (parentDonations && parentDonations.length === 1) {
    const parentDonationWithHomeTxHash = await donationModel.findOne({
      _id: Types.ObjectId(parentDonations[0]),
      txHash,
      homeTxHash: { $exists: true },
    });
    if (parentDonationWithHomeTxHash) {
      return parentDonationWithHomeTxHash.homeTxHash;
    }
  }
  return null;
}

// const logger: Logger = getLogger(logDir, argv.debug ?'debug':'error')

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

const symbolDecimalsMap = {};

config.get('tokenWhitelist').forEach(({ symbol, decimals }) => {
  symbolDecimalsMap[symbol] = {
    cutoff: new BigNumber(10 ** (18 - Number(decimals))),
  };
});


const instantiateWeb3 = async ({ url }) => {
  const options = {
    timeout: 30000, // ms

    clientConfig: {
      // Useful if requests are large
      maxReceivedFrameSize: 100000000, // bytes - default: 1MiB
      maxReceivedMessageSize: 100000000, // bytes - default: 8MiB

      // Useful to keep a connection alive
      keepalive: true,
      keepaliveInterval: 45000, // ms
    },

    // Enable auto reconnection
    reconnect: {
      auto: true,
      delay: 5000, // ms
      maxAttempts: 5,
      onTimeout: false,
    },
  };

  if (!url || !url && url.startsWith('ws')) {
    throw new Error('invalid web3 websocket url');
  }
  const provider = new Web3WsProvider(url, options);
  return new Promise(resolve => {
    const web3 = new Web3(provider);
    if (provider.on) {
      provider.on('connect', () => {
        console.log(`connected to ${url}`);
        liquidPledging = new LiquidPledging(web3, liquidPledgingAddress);
        resolve(web3);
      });
    } else {
      liquidPledging = new LiquidPledging(web3, liquidPledgingAddress);
      resolve(web3);
    }
  });
};

async function getKernel() {
  const kernelAddress = await liquidPledging.kernel();
  return new Kernel(foreignWeb3, kernelAddress);
}

const donationUsdValueUtility = new DonationUsdValueUtility(converionRateModel, config, logger);

const createProgressBar = ({ title }) => {
  return new cliProgress.SingleBar({
    format: `${title} |${_colors.cyan(
      '{bar}',
    )}| {percentage}% || {value}/{total}`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });
};

// Gets status of liquidpledging storage
const fetchBlockchainData = async () => {
  console.log('fetchBlockchainData ....', {
    updateEvents,
    updateState,
  });
  try {
    homeWeb3 = await instantiateWeb3({ url: homeNodeUrl });
    foreignWeb3 = await instantiateWeb3({ url: nodeUrl });

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir);
    }
    const stateFile = path.join(cacheDir, `./liquidPledgingState_${process.env.NODE_ENV}.json`);
    const eventsFile = path.join(cacheDir, `./liquidPledgingEvents_${process.env.NODE_ENV}.json`);

    let state: {
      pledges: PledgeInterface[],
      admins: AdminInterface [],
    } = <{
      pledges: PledgeInterface[],
      admins: AdminInterface [],
    }>{
      pledges: [null],
      admins: [null],
    };
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(String(fs.readFileSync(stateFile)));
    }
    events = fs.existsSync(eventsFile) ? JSON.parse(String(fs.readFileSync(eventsFile))) : [];

    if (updateState || updateEvents) {
      let fromBlock = 0;
      let fetchBlockNum: string | number = 'latest';
      if (updateEvents) {
        fromBlock = events.length > 0 ? events[events.length - 1].blockNumber + 1 : 0;
        fetchBlockNum =
          (await foreignWeb3.eth.getBlockNumber()) - config.get('blockchain.requiredConfirmations');
      }

      const fromPledgeIndex = state.pledges.length > 1 ? state.pledges.length : 1;
      const fromPledgeAdminIndex = state.admins.length > 1 ? state.admins.length : 1;

      let newEvents = [];
      let newPledges = [];
      let newAdmins = [];
      let dataFetched = false;
      let firstTry = true;
      while (
        !dataFetched
        // error ||
        // state.pledges.length <= 1 ||
        // state.admins.length <= 1
        ) {
        if (!firstTry) {
          logger.error('Some problem on fetching network info... Trying again!');
          if (!Array.isArray(state.pledges) || state.pledges.length <= 1) {
            logger.debug(`state.pledges: ${state.pledges}`);
          }
          if (!Array.isArray(state.admins) || state.admins.length <= 1) {
            logger.debug(`state.admins: ${state.admins}`);
          }
        }
        let [error, result] = await toFn(
          Promise.all([
            updateState ? getPledgeBatch(liquidPledging, fromPledgeIndex) : Promise.resolve(state.pledges),
            updateState ? getAdminBatch(liquidPledging, fromPledgeAdminIndex) : Promise.resolve(state.admins),
            updateEvents
              ? liquidPledging.$contract.getPastEvents('allEvents', {
                fromBlock,
                toBlock: fetchBlockNum,
              })
              : Promise.resolve([]),
          ]),
        );
        if (result) {
          [newPledges, newAdmins, newEvents] = result;
          dataFetched = true;
        }

        report.fetchedNewEventsCount = newEvents.length;
        report.fetchedNewPledgeCount = newPledges.length;
        report.fetchedNewPledgeAdminCount = newAdmins.length;

        if (error && error instanceof Error) {
          logger.error(`Error on fetching network info\n${error.stack}`);
        }
        firstTry = false;
      }


      if (updateState) {
        state.pledges = [...state.pledges, ...newPledges];
        state.admins = [...state.admins, ...newAdmins];
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      }
      if (updateEvents && newEvents) {
        events = [...events, ...newEvents];
        fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
      }
    }

    events.forEach(e => {
      if (e.event === 'Transfer') {
        const { transactionHash } = e;
        const list: EventInterface[] = txHashTransferEventMap[transactionHash] || [];
        if (list.length === 0) {
          txHashTransferEventMap[transactionHash] = list;
        }
        list.push(e);
      }
    });

    pledges = state.pledges;
    admins = state.admins;
    report.processedEvents = events.length;

  } catch (e) {
    logger.error('fetchBlockchainData error', e);
    console.error('fetchBlockchainData error', e);
    terminateScript(e.stack);
  }

};

export const updateEntity = async (model, type) => {
  const donationQuery = {
    // $select: ['amount', 'giverAddress', 'amountRemaining', 'token', 'status', 'isReturn'],
    mined: true,
    status: { $nin: [DonationStatus.FAILED, DonationStatus.PAYING, DonationStatus.PAID] },
  };

  let idFieldName;
  if (type === AdminTypes.DAC) {
    // TODO I think this can be gamed if the donor refunds their donation from the dac
    Object.assign(donationQuery, {
      delegateType: AdminTypes.DAC,
      $and: [
        {
          $or: [{ intendedProjectId: 0 }, { intendedProjectId: undefined }],
        },
        {
          $or: [{ parentDonations: { $not: { $size: 0 } } }, { amountRemaining: { $ne: '0' } }],
        },
      ],
    });
    idFieldName = 'delegateTypeId';
  } else if (type === AdminTypes.CAMPAIGN) {
    Object.assign(donationQuery, {
      ownerType: AdminTypes.CAMPAIGN,
    });
    idFieldName = 'ownerTypeId';
  } else if (type === AdminTypes.MILESTONE) {
    Object.assign(donationQuery, {
      ownerType: AdminTypes.MILESTONE,
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
    const query = { ...donationQuery };
    query[idFieldName] = entity._id;

    const donations = await donationModel.find(query);

    const returnedDonations = await donationModel.find({
      isReturn: true,
      mined: true,
      parentDonations: { $in: donations.map(d => d._id) },
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

      // eslint-disable-next-line prefer-const
      let { totalDonated, currentBalance } = tokenDonations.reduce(
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

      // Exclude returned values from canceled milestones
      if (
        !(type === AdminTypes.MILESTONE && entity.status === MilestoneStatus.CANCELED) &&
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
      const { tokenAddress } = tokenDonations.find(d => d.tokenAddress);
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

    const { tokenAddress, maxAmount } = entity;
    const token = getTokenByAddress(tokenAddress);
    const foundDonationCounter = token && donationCounters.find(dc => dc.symbol === token.symbol);
    const fullyFunded = !!(
      type === AdminTypes.MILESTONE &&
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
      await model.findOneAndUpdate({ _id: entity._id }, mutations);
    }

  }
  progressBar.update(entities.length);
  progressBar.stop();
  console.log(`Syncing donationCounter for ${type} ends.`);

};


// Update createdAt date of donations based on transaction date
// @params {string} startDate
// eslint-disable-next-line no-unused-vars
const updateDonationsCreatedDate = async (startDate: Date) => {
  const web3 = foreignWeb3;
  const donations = await donationModel.find({
    createdAt: {
      // $gte: startDate.toISOString(),
      $gte: startDate,
    },
  });
  for (const donation of donations) {
    const { _id, txHash, createdAt } = donation;
    const { timestamp } = await getTransaction({txHash, isHome :false, foreignWeb3, homeWeb3});
    const newCreatedAt =timestamp;
    if (createdAt.toISOString() !== newCreatedAt.toISOString()) {
      logger.info(
        `Donation ${_id.toString()} createdAt is changed from ${createdAt.toISOString()} to ${newCreatedAt.toISOString()}`,
      );
      logger.info('Updating...');
      const d = await donationModel.findOne({ _id });
      d.createdAt = newCreatedAt;
      await d.save();
    }
  }

};

// Fills pledgeNotUsedDonationListMap map to contain donation items for each pledge
// Fills donationMap to map id to donation item
const fetchDonationsInfo = async () => {
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

};

const convertPledgeStateToStatus = (pledge: PledgeInterface,
                                    pledgeAdmin: AdminInterface | PledgeAdminMongooseDocument) => {
  const { pledgeState, delegates, intendedProject } = pledge;
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

/**
 * Determine if this transfer was a return of excess funds of an over-funded milestone
 * @param {object} transferInfo
 */
async function isReturnTransfer(transferInfo: TransferInfoInterface) {
  const { fromPledge, fromPledgeAdmin, toPledgeId, txHash, fromPledgeId } = transferInfo;
  // currently only milestones will can be over-funded
  if (fromPledgeId === '0' || !fromPledgeAdmin || fromPledgeAdmin.type !== AdminTypes.MILESTONE) {
    return false;
  }

  const transferEventsInTx = txHashTransferEventMap[txHash];

  // ex events in return case:
  // Transfer(from: 1, to: 2, amount: 1000)
  // Transfer(from: 2, to: 1, amount: < 1000)
  return transferEventsInTx.some(
    (e: EventInterface) =>
      // it may go directly to fromPledge.oldPledge if this was delegated funds
      // being returned b/c the intermediary pledge is the pledge w/ the intendedProject
      [e.returnValues.from, fromPledge.oldPledge].includes(toPledgeId) &&
      e.returnValues.to === fromPledgeId,
  );
}

const isRejectedDelegation = (data: { fromPledge: PledgeInterface, toPledge: PledgeInterface }) => {
  const { fromPledge, toPledge } = data;
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

async function correctFailedDonation(failedDonationList, matchingFailedDonationIndex, toPledge, toOwnerAdmin, to: string, toUnusedDonationList, candidateToDonationList) {

  return { candidateToDonationList, failedDonationList };
}

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
          const { parentDonations } = item;
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
            { _id: toFixDonation._id },
            { status: toFixDonation.status, pledgeId: to },
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
              { ...item, amountRemaining: item.amountRemaining },
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

  return { usedFromDonations, giverAddress };
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

  const fromPledgeAdmin = await pledgeAdminModel.findOne({ id: Number(fromOwnerId) });

  let isReturn = isReverted;
  if (!isReturn) {
    const returnedTransfer = await isReturnTransfer({
      fromPledge,
      fromPledgeAdmin,
      fromPledgeId: from,
      toPledgeId: to,
      txHash: transactionHash,
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
    const rejectedDelegation = isRejectedDelegation({ toPledge, fromPledge });
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
    };
    const homeTxHash = await getHomeTxHashForDonation({
      txHash: transactionHash,
      parentDonations: usedFromDonations,
      from,
    });
    if (homeTxHash) {
      expectedToDonation.homeTxHash = homeTxHash;
    }

    if (fixConflicts) {
      let toPledgeAdmin: PledgeAdminMongooseDocument = await pledgeAdminModel.findOne({ id: Number(toOwnerId) });
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
        });
        await toPledgeAdmin.save();
        report.createdPledgeAdmins++;
        logger.info(`pledgeAdmin crated: ${toPledgeAdmin._id.toString()}`);
      }

      if(!toPledgeAdmin.typeId){
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
        const dacPledgeAdmin = await pledgeAdminModel.findOne({ id: Number(delegate.id) });
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
        const { intendedProject } = toPledge;
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

      const { timestamp } = await foreignWeb3.eth.getBlock(blockNumber);
      const actionTakerAddress = await getActionTakerAddress({ txHash: transactionHash, homeTxHash });
      const model: any = {
        ...expectedToDonation,
        tokenAddress: token.address,
        actionTakerAddress,
        amountRemaining: new BigNumber(expectedToDonation.amountRemaining).toFixed(),
        mined: true,
        createdAt: new Date(timestamp * 1000),
      };

      // if (!homeTxHash){
      //   //TODO now connecting homeWeb3 has problem if it was ok we can get actionTakerAddress for that too and using this function getActionTakerAddress()
      //   const {from}  = await foreignWeb3.eth.getTransaction(transactionHash)
      //   model.actionTakerAddress = from
      // }

      const { cutoff } = symbolDecimalsMap[token.symbol];
      model.lessThanCutoff = cutoff.gt(new BigNumber(model.amountRemaining));

      const donation = new donationModel(model);

      await donationUsdValueUtility.setDonationUsdValue(donation);
      await donation.save();
      report.createdDonations++;

      const _id = donation._id.toString();
      expectedToDonation._id = _id;
      expectedToDonation.savedAmountRemaining = model.amountRemaining;
      donationMap[_id] = { ...expectedToDonation };
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
      await donationModel.update({ _id: toDonation._id }, { mined: true });
      toDonation.mined = true;
    }

    toDonation.status = expectedStatus;

    const { parentDonations } = toDonation;
    if (
      usedFromDonations.length !== parentDonations.length ||
      usedFromDonations.some(id => !parentDonations.includes(id))
    ) {
      logger.error(`Parent of ${toDonation._id} should be updated to ${usedFromDonations}`);
      if (fixConflicts) {
        logger.debug('Updating...');
        toDonation.parentDonations = usedFromDonations;
        await donationModel.update(
          { _id: toDonation._id },
          { parentDonations: usedFromDonations },
        );

      }
    }

    if (toDonation.isReturn !== isReturn) {
      logger.error(`Donation ${toDonation._id} isReturn flag should be ${isReturn}`);
      logger.debug('Updating...');
      await donationModel.updateOne({ _id: toDonation._id }, { isReturn });
      toDonation.isReturn = isReturn;
    }

    const { usdValue } = toDonation;
    await donationUsdValueUtility.setDonationUsdValue(toDonation);
    if (toDonation.usdValue !== usdValue) {
      logger.error(
        `Donation ${toDonation._id} usdValue is ${usdValue} but should be updated to ${toDonation.usdValue}`,
      );
      logger.debug('Updating...');
      await donationModel.updateOne({ _id: toDonation._id }, { usdValue: toDonation.usdValue });

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

const revertProjectDonations = async projectId => {
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

const cancelProject = async (projectId: string) => {
  admins[projectId].isCanceled = true;
  await revertProjectDonations(projectId);

  const projectIdStr = String(projectId);
  for (let index = 1; index < admins.length; index += 1) {
    const admin = admins[index];

    if (admin.parentProject === projectIdStr) {
      admin.isCanceled = true;
      // eslint-disable-next-line no-await-in-loop
      await revertProjectDonations(index);
    }
  }
};

const fixConflictInDonations = unusedDonationMap => {
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
          promises.push(donationModel.findOneAndDelete({ _id }));

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
            logger.debug('Updating...');
            const { cutoff } = symbolDecimalsMap[getTokenByAddress(tokenAddress).symbol];
            promises.push(
              donationModel.updateOne(
                { _id },
                {
                  $set: {
                    amountRemaining,
                    lessThanCutoff: cutoff.gt(amountRemaining),
                  },
                },
              ),
            );
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
            promises.push(donationModel.updateOne({ _id }, { status }));
          }
        }
      }
    },
  );
  return Promise.all(promises);
};

const syncEventWithDb = async (eventData: EventInterface) => {
  const { event, transactionHash, logIndex, returnValues, blockNumber } = eventData;
  if (ignoredTransactions.some(it => it.txHash === transactionHash && it.logIndex === logIndex)) {
    logger.debug('Event ignored.');
    return;
  }

  if (event === 'Transfer') {
    const { from, to, amount } = returnValues;
    logger.debug(`Transfer from ${from} to ${to} amount ${amount}`);

    // eslint-disable-next-line no-await-in-loop
    const { usedFromDonations, giverAddress } = await handleFromDonations(
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
    const { idProject } = returnValues;
    logger.debug(
      `Cancel project ${idProject}: ${JSON.stringify(admins[Number(idProject)], null, 2)}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await cancelProject(idProject);
  }
};

const syncDonationsWithNetwork = async () => {
  // Map from pledge id to list of donations belonged to the pledge and are not used yet!
  await fetchDonationsInfo();
  const startTime = new Date();
  // create new progress bar
  const progressBar = createProgressBar({ title: 'Syncing donations with events.' });
  progressBar.start(events.length, 0);

  // Simulate transactions by events
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);
    const { event, transactionHash, logIndex, returnValues, blockNumber } = events[i];
    logger.debug(
      `-----\nProcessing event ${i}:\nLog Index: ${logIndex}\nEvent: ${event}\nTransaction hash: ${transactionHash}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await syncEventWithDb({ event, transactionHash, logIndex, returnValues, blockNumber });
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
  await fixConflictInDonations(unusedDonationMap);
};

const createMilestoneForPledgeAdmin = async ({
                                               project, getMilestoneDataForCreate,
                                               idProject, milestoneType, transactionHash,
                                             }) => {
  const campaign = await campaignModel.findOne({ projectId: project.parentProject });
  if (!campaign) {
    logger.error(`Campaign doesn't exist -> projectId:${idProject}`);
    return undefined;
  }
  const createMilestoneData = await getMilestoneDataForCreate({
    milestoneType,
    project,
    projectId: idProject,
    txHash: transactionHash,
  });
  return new milestoneModel({
    ...createMilestoneData,
    status: MilestoneStatus.PENDING,
    campaignId: campaign._id,
  }).save();
};
const createCampaignForPledgeAdmin = async ({ project, idProject, transactionHash, getCampaignDataForCreate }) => {
  const createCampaignData = await getCampaignDataForCreate({
    project,
    projectId: idProject,
    txHash: transactionHash,
  });
  return new campaignModel({
    ...createCampaignData,
    status: CampaignStatus.CANCELED,
  }).save();
};

const syncPledgeAdmin = async () => {

};

// Creates PledgeAdmins entity for a project entity
// Requires corresponding project entity has been saved holding correct value of txHash
// eslint-disable-next-line no-unused-vars

const createPledgeAdminAndProjectsIfNeeded = async (options:
                                                      {
                                                        getMilestoneTypeByProjectId,
                                                        getMilestoneDataForCreate,
                                                        getCampaignDataForCreate,
                                                        event: string,
                                                        transactionHash: string,
                                                        returnValues: {
                                                          idProject: string
                                                        }
                                                      }) => {
  const {
    event, transactionHash, returnValues, getCampaignDataForCreate,
    getMilestoneTypeByProjectId, getMilestoneDataForCreate,
  } = options;
  if (event !== 'ProjectAdded') return;
  try {
    const { idProject } = returnValues;
    const pledgeAdmin = await pledgeAdminModel.findOne({ id: Number(idProject) });
    if (pledgeAdmin) {
      return;
    }
    logger.error(`No pledge admin exists for ${idProject}`);
    logger.info('Transaction Hash:', transactionHash);

    const { project, milestoneType, isCampaign } = await getMilestoneTypeByProjectId(idProject);
    let entity = isCampaign
      ? await campaignModel.findOne({ txHash: transactionHash })
      : await milestoneModel.findOne({ txHash: transactionHash });
    // Not found any
    if (!entity && !isCampaign) {
      try {
        entity = await createMilestoneForPledgeAdmin({
          project,
          idProject,
          milestoneType,
          transactionHash,
          getMilestoneDataForCreate,
        });
        report.createdMilestones++;
      } catch (e) {
        logger.error('createMilestoneForPledgeAdmin error', { idProject, e });
        await new pledgeAdminModel({
          id: Number(idProject),
          type: AdminTypes.MILESTONE,
          typeId: 'notExists because create milestone failed',
        }).save();
        logger.error('create pledgeAdmin without creating milestone', { idProject });
      }
    } else if (!entity && isCampaign) {
      entity = await createCampaignForPledgeAdmin({ project, idProject, transactionHash, getCampaignDataForCreate });
      report.createdCampaigns++;
    }
    if (!entity) {
      return;
    }

    logger.info('created entity ', entity);
    const type = isCampaign ? AdminTypes.CAMPAIGN : AdminTypes.MILESTONE;
    logger.info(`a ${type} found with id ${entity._id.toString()} and status ${entity.status}`);
    logger.info(`Title: ${entity.title}`);
    const newPledgeAdmin = new pledgeAdminModel({
      id: Number(idProject),
      type,
      typeId: entity._id.toString(),
    });
    const result = await newPledgeAdmin.save();
    report.createdPledgeAdmins++;
    logger.info('pledgeAdmin saved', result);
  } catch (e) {
    console.log('createPledgeAdminAndProjectsIfNeeded error', {
      e,
      event,
      transactionHash,
      returnValues
    })
  }
  // process.stdout.write('.');
};

const syncPledgeAdminsAndProjects = async () => {
  console.log('syncPledgeAdminsAndProjects called', { fixConflicts });
  if (!fixConflicts) return;
  const {
    getMilestoneTypeByProjectId,
    getCampaignDataForCreate,
    getMilestoneDataForCreate,
  } = await createProjectHelper({
    web3: foreignWeb3,
    homeWeb3,
    liquidPledging,
    kernel: await getKernel(),
    AppProxyUpgradeable,
  });

  const startTime = new Date();
  console.log('Syncing PledgeAdmins with events .... ');
  const promises = [];
  const progressBar = createProgressBar({ title: 'Syncing pladgeAdmins with events' });
  progressBar.start(events.length, 0);
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);

    const { event, transactionHash, returnValues } = events[i];
    await createPledgeAdminAndProjectsIfNeeded({
      getCampaignDataForCreate,
      getMilestoneDataForCreate,
      getMilestoneTypeByProjectId, event, transactionHash, returnValues,
    })

    // promises.push(createPledgeAdminAndProjectsIfNeeded({
    //   getCampaignDataForCreate,
    //   getMilestoneDataForCreate,
    //   getMilestoneTypeByProjectId, event, transactionHash, returnValues,
    // }));
  }
  progressBar.update(events.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  report.syncPledgeAdminsSpentTime = spentTime;
  console.log(`pledgeAdmins events synced end.\n spentTime :${spentTime} seconds`);
};


const syncDacs = async () => {
  console.log('syncDacs called', { fixConflicts });
  if (!fixConflicts) return;
  const {
    getDacDataForCreate,
  } = await createProjectHelper({
    web3: foreignWeb3,
    homeWeb3,
    liquidPledging,
    kernel: await getKernel(),
    AppProxyUpgradeable,
  });

  const startTime = new Date();
  const progressBar = createProgressBar({ title: 'Syncing Dacs with events' });
  progressBar.start(events.length, 0);
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);
    try {
      const { event, transactionHash, returnValues } = events[i];
      if (event !== 'DelegateAdded') continue;
      const { idDelegate } = returnValues;
      const pledgeAdmin = await pledgeAdminModel.findOne({ id: Number(idDelegate) });
      if (pledgeAdmin) {
        continue;
      }
      const { from } = await getTransaction(
        {txHash:transactionHash, isHome:false, foreignWeb3, homeWeb3});
      const delegateId = idDelegate;
      let dac = await dacModel.findOne({ txHash:transactionHash });
      if (!dac) {
        const dacData = await getDacDataForCreate({
          from,
          txHash: transactionHash,
          delegateId,
        });
        dac = await new dacModel(dacData).save();
        report.createdDacs++;
        logger.info('created dac ', dac);
      }
      await new pledgeAdminModel(
        { id: Number(delegateId), type: 'dac', typeId: dac._id }).save();
      report.createdPledgeAdmins++;

    } catch (e) {
      logger.error('error in creating dac', e);
    }
  }
  progressBar.update(events.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  report.syncDelegatesSpentTime = spentTime;
  console.log(`dac/delegate events synced end.\n spentTime :${spentTime} seconds`);
};


const getExpectedStatus = (events: EventInterface[], milestone: MilestoneMongooseDocument) => {
  const eventToStatus = {
    ApproveCompleted: MilestoneStatus.COMPLETED,
    CancelProject: MilestoneStatus.CANCELED,
    MilestoneCompleteRequestApproved: MilestoneStatus.COMPLETED,
    MilestoneCompleteRequestRejected: MilestoneStatus.IN_PROGRESS,
    MilestoneCompleteRequested: MilestoneStatus.NEEDS_REVIEW,
    // "PaymentCollected", // expected status depends on milestone
    ProjectAdded: MilestoneStatus.IN_PROGRESS,
    // "ProjectUpdated", // Does not affect milestone status
    // "RecipientChanged", // Does not affect milestone status
    RejectCompleted: MilestoneStatus.REJECTED,
    RequestReview: MilestoneStatus.NEEDS_REVIEW,
  };

  const lastEvent = events.pop();
  if (lastEvent.event === 'PaymentCollected') {
    const { maxAmount, donationCounters, fullyFunded, reviewerAddress } = milestone;
    const hasReviewer = reviewerAddress && reviewerAddress !== ZERO_ADDRESS;
    if (
      maxAmount &&
      (fullyFunded || hasReviewer) &&
      donationCounters[0].currentBalance.toString() === '0'
    ) {
      return MilestoneStatus.PAID;
    }
    return getExpectedStatus(events, milestone);
  }
  return eventToStatus[lastEvent.event];
};

const updateMilestonesFinalStatus = async () => {
  const milestones = await milestoneModel.find({ projectId: { $gt: 0 } });
  const startTime = new Date();
  const progressBar = createProgressBar({ title: 'Updating milestone status' });
  progressBar.start(milestones.length);
  for (const milestone of milestones) {
    progressBar.increment();
    const matchedEvents = events.filter(event => event.returnValues && event.returnValues.idProject === String(milestone.projectId));
    const { status, projectId } = milestone;
    if ([MilestoneStatus.ARCHIVED, MilestoneStatus.CANCELED].includes(status)) continue;

    let message = '';
    message += `Project ID: ${projectId}\n`;
    message += `Events: ${events.toString()}\n`;
    const expectedStatus = getExpectedStatus(matchedEvents, milestone);
    if (status !== expectedStatus ){
      await milestoneModel.updateOne({ _id: milestone._id }, { status: expectedStatus, mined: true });
      report.updatedMilestoneStatus ++;
    }
  }
  progressBar.update(milestones.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  console.log(`Updating milestone status synced end.\n spentTime :${spentTime} seconds`);
  report.syncMilestoneSpentTime = spentTime;
};


const main = async () => {
  try {
    await fetchBlockchainData();

    if (!index && !fixConflicts) {
      terminateScript(null, 0);
      return;
    }

    /*
       Find conflicts in milestone donation counter
      */
    const mongoUrl = config.get('mongodb');
    mongoose.connect(mongoUrl);
    const db = mongoose.connection;

    db.on('error', err => logger.error(`Could not connect to Mongo:\n${err.stack}`));

    db.once('open', async () => {
      logger.info('Connected to Mongo');
      try {
        await syncDacs();
        await syncPledgeAdminsAndProjects();
        await syncDonationsWithNetwork();
        await updateEntity(dacModel, AdminTypes.DAC);
        await updateEntity(campaignModel, AdminTypes.CAMPAIGN);
        await updateEntity(milestoneModel, AdminTypes.MILESTONE);
        await updateMilestonesFinalStatus();
        console.table(report);
        if (config.get('emailReport')){
          await sendReportEmail(report,
            givethDevMailList,
            dappMailerUrl,
            dappMailerSecret
          )
        }

        terminateScript('All job done.', 0);
      } catch (e) {
        console.log('error syncing ... ', e);
        if (config.get('emailSimulationError')){
          sendSimulationErrorEmail(JSON.stringify(e, null , 4),
            givethDevMailList,
            dappMailerUrl,
            dappMailerSecret
          )
        }
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
